import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import {
  PROTOCOL_VERSION,
  STATIC_PLACEMENT_ASSET_ID,
  worldNeighborhood,
  type Vec3,
  type WorldManifest,
} from '../packages/contracts/src/index.js';
import { DATABASE_SCHEMA_VERSION } from '../apps/server/src/migrations.js';
import { physicsFixture } from '../packages/simulation/src/test-fixture.js';
import { buildWorld } from '../tools/world-build/src/index.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { hudClick, openChat, chatSent } from './helpers/hud.js';

if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('SU_TEST_DATABASE_URL is required; this scenario uses a disposable schema.');

const output = 'output/playwright/player-positions';
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'su-player-position-browser-'));
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const errors: string[] = [];
const checks: string[] = [];
const measurements: unknown[] = [];
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
let currentPage: Page | undefined;

const snapshot = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const playing = (page: Page) =>
  page.waitForFunction(() => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing');
const record = (message: string) => {
  checks.push(message);
  console.log(`Passed: ${message}`);
};
function samePosition(actual: Vec3, expected: Vec3) {
  assert.ok(
    Math.hypot(actual.x - expected.x, actual.z - expected.z) < 0.03,
    `exact X/Z: ${JSON.stringify({ actual, expected })}`,
  );
  assert.ok(
    Math.abs(actual.y - expected.y) <= 0.05,
    `body center Y has no repeated spawn offset: ${JSON.stringify({ actual, expected })}`,
  );
}
async function healthy(page: Page) {
  // Read readiness and its evidence together: a streaming pause can follow the first playing frame.
  const ready = await page.waitForFunction(() => {
    const state = (window as any).__SU_DEBUG__?.snapshot();
    return state?.connection === 'playing' &&
      state.authoritative &&
      state.predicted &&
      state.streaming?.criticalReady
      ? state
      : false;
  });
  const state = await ready.jsonValue();
  assert.equal(state.playerCount, 1);
  assert.ok(state.authoritative);
  assert.ok(state.predicted);
  assert.equal([...app!.room.state.players.values()].length, 1);
  await page.locator('.player-label.own').waitFor();
  assert.equal(await page.locator('.player-label.own').count(), 1);
  return state;
}
async function beginTracing(page: Page) {
  await page.evaluate(() => {
    const plans: unknown[] = [];
    (window as any).__positionPlans = plans;
    setInterval(() => {
      const plan = (window as any).__SU_DEBUG__?.snapshot().plan;
      if (plan && !(plans as any[]).some((old) => old.prepareId === plan.prepareId))
        plans.push(plan);
    }, 5);
  });
}
async function signedIn(context: BrowserContext) {
  const page = await context.newPage();
  currentPage = page;
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${app!.url}/?diagnostics=1`);
  await page.locator('#telegram-login').waitFor({ state: 'visible' });
  await page.locator('#telegram-login').click();
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  // The real OIDC callback returns to '/'; reopen diagnostics without changing authentication.
  await page.goto(`${app!.url}/?diagnostics=1`);
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  await page.locator('#profile-name').fill('Проверка позиции');
  await page.locator('input[name="avatar-skin"][value="standard"]').check();
  await beginTracing(page);
  const account = await page.evaluate(async () => (await fetch('/api/me')).json());
  return { page, accountId: account.account.accountId as string };
}
async function enter(page: Page) {
  await page.bringToFront();
  await page.locator('#join:not([disabled])').click();
  return healthy(page);
}
async function leave(page: Page) {
  await hudClick(page, '#leave');
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !(window as any).__SU_DEBUG__.snapshot().authoritative);
}
async function walkRemote(page: Page) {
  await page.locator('#world').focus();
  const initial = (await snapshot(page)).authoritative.position;
  await page.keyboard.down('Shift');
  await page.keyboard.down('s');
  try {
    await page.waitForFunction(
      (start) => {
        const p = (window as any).__SU_DEBUG__.snapshot().authoritative?.position;
        return p && Math.hypot(p.x - start.x, p.z - start.z) >= 34;
      },
      initial,
      { timeout: 20_000 },
    );
  } finally {
    await page.keyboard.up('s');
    await page.keyboard.up('Shift');
  }
  await page.waitForTimeout(350);
  return (await healthy(page)).authoritative.position as Vec3;
}
async function chat(page: Page, message: string) {
  if (await page.evaluate(() => !!document.pointerLockElement)) await page.keyboard.press('t');
  else await openChat(page);
  await page.locator('#chat-input').fill(message);
  await page.keyboard.press('Enter');
  await chatSent(page);
  // The local body and its speech bubble are intentionally hidden in first-person view.
  await page.locator('.player-chat').filter({ hasText: message }).waitFor({ state: 'attached' });
}
async function newContext() {
  const context = await browser!.newContext({ viewport: { width: 960, height: 640 } });
  await context.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  return context;
}
async function firstPerson(page: Page) {
  await page.locator('#world').focus();
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable);
  await page.keyboard.press('v');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().view === 'first-person');
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(700);
    if (await page.evaluate(() => !!document.pointerLockElement)) return;
    await page.locator('#world').click({ position: { x: 350, y: 250 } });
  }
  await page.waitForFunction(() => !!document.pointerLockElement);
}

try {
  // Eight-metre cells let actual keyboard movement reach a disjoint saved critical region quickly.
  // The whole flat authored world is real physics; no coordinates are injected into the player.
  const source = join(directory, 'source');
  await mkdir(source);
  await cp('content/items/catalog.json', join(source, 'items.json'));
  await cp(
    `content/buildings/ring-block/objects/${STATIC_PLACEMENT_ASSET_ID}`,
    join(source, 'bench'),
    {
      recursive: true,
    },
  );
  const base = physicsFixture();
  await writeFile(
    join(source, 'catalog.json'),
    JSON.stringify({
      formatVersion: 1,
      assets: { [STATIC_PLACEMENT_ASSET_ID]: 'bench/asset.json' },
    }),
  );
  await writeFile(
    join(source, 'cell.json'),
    JSON.stringify({
      formatVersion: 2,
      cellId: '0_0',
      statics: [{ ...base.entities[0], color: '#263441', size: { x: 64, y: 1, z: 64 } }],
      buildings: [],
    }),
  );
  await writeFile(
    join(source, 'world.json'),
    JSON.stringify({
      formatVersion: 5,
      worldId: 'player-position-browser',
      bounds: { min: { x: -32, y: -5, z: -32 }, max: { x: 32, y: 10, z: 32 } },
      simulation: base.simulation,
      spawnPoints: [-18, -15, -12, -9, -6, -3, 0, 3].map((x) => ({ x, y: 0, z: -18 })),
      initialItems: [],
      cellSize: 8,
      assetCatalog: 'catalog.json',
      itemCatalog: 'items.json',
      cells: ['cell.json'],
    }),
  );
  const worldDirectory = join(directory, 'world');
  await buildWorld(join(source, 'world.json'), worldDirectory);
  const startApp = async (port: number) => {
    const instance = await createGameServer({
      port,
      worldDirectory,
      accounts: fixture,
      testDiagnostics: true,
      prepareTimeoutMs: 6000,
    });
    fixture.config.publicOrigin = instance.url;
    return instance;
  };
  app = await startApp(0);
  browser = await launchTestBrowser({ channel: 'chromium' });
  const context = await newContext();
  const first = await signedIn(context);
  const initial = await enter(first.page);
  const startPosition = initial.authoritative.position;
  const remote = await walkRemote(first.page);
  await first.page.screenshot({ path: `${output}/remote-overview.png` });
  await leave(first.page);
  const restored = await enter(first.page);
  samePosition(restored.authoritative.position, remote);
  assert.notEqual(restored.authoritative.entityId, initial.authoritative.entityId);
  await chat(first.page, 'Вернулся на прежнее место');
  await leave(first.page);
  record(
    'real OIDC login, keyboard movement, UI exit and immediate exact-body-center return with working chat',
  );
  await context.close();

  const secondContext = await newContext();
  const second = await signedIn(secondContext);
  assert.equal(second.accountId, first.accountId);
  const other = await enter(second.page);
  samePosition(other.authoritative.position, remote);
  await secondContext.setOffline(true);
  await second.page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
  );
  await secondContext.setOffline(false);
  const reconnected = await healthy(second.page);
  assert.equal(reconnected.authoritative.entityId, other.authoritative.entityId);
  samePosition(reconnected.authoritative.position, remote);
  record(
    'a separate browser context restores by account; short reconnect retains one existing entity',
  );

  await firstPerson(second.page);
  const beforeMove = (await snapshot(second.page)).authoritative.position;
  await second.page.keyboard.down('s');
  await second.page.waitForTimeout(550);
  await second.page.keyboard.up('s');
  await second.page.waitForTimeout(350);
  const moved = (await snapshot(second.page)).authoritative.position;
  assert.ok(Math.hypot(moved.x - beforeMove.x, moved.z - beforeMove.z) > 0.25);
  await chat(second.page, 'Управление после возврата');
  await second.page.screenshot({ path: `${output}/remote-first-person.png` });
  await leave(second.page);
  const fromFirstPerson = await enter(second.page);
  samePosition(fromFirstPerson.authoritative.position, moved);
  record(
    'first-person input and chat work after restore; leaving and rejoining preserves the new body position',
  );

  const oldEpoch = fromFirstPerson.worldEpoch;
  const port = Number(new URL(app.url).port);
  await app.close();
  app = await startApp(port);
  await second.page.goto(`${app.url}/?diagnostics=1`);
  await second.page.locator('#profile-form').waitFor({ state: 'visible' });
  await beginTracing(second.page);
  const restarted = await enter(second.page);
  assert.notEqual(restarted.worldEpoch, oldEpoch);
  samePosition(restarted.authoritative.position, moved);
  measurements.push({
    startPosition,
    remote,
    restoredPosition: restored.authoritative.position,
    separateContextPosition: other.authoritative.position,
    firstPersonPosition: moved,
    restartedPosition: restarted.authoritative.position,
    oldEpoch,
    newEpoch: restarted.worldEpoch,
  });
  record('graceful server restart restores a previous-epoch position from PostgreSQL');
  await leave(second.page);
  await second.page.locator('#account-logout').click();
  await second.page.locator('#telegram-login').waitFor({ state: 'visible' });
  await second.page.locator('#telegram-login').click();
  await second.page.locator('#profile-form').waitFor({ state: 'visible' });
  await second.page.goto(`${app.url}/?diagnostics=1`);
  await second.page.locator('#profile-form').waitFor({ state: 'visible' });
  const afterLogout = await enter(second.page);
  samePosition(afterLogout.authoritative.position, moved);
  await leave(second.page);
  record('logout and real reauthentication retain the account position');
  await secondContext.close();

  const info = await (await fetch(`${app.url}/api/world`)).json();
  const manifest = (await (
    await fetch(new URL(info.manifestUrl, app.url))
  ).json()) as WorldManifest;
  const savedCells = worldNeighborhood(manifest.bounds, manifest.grid, moved);
  const startCells = worldNeighborhood(manifest.bounds, manifest.grid, startPosition);
  assert.ok(
    savedCells.every((id) => !startCells.includes(id)),
    'fixture regions are disjoint',
  );
  const savedFiles = new Set(
    manifest.cells.filter((cell) => savedCells.includes(cell.cellId)).map((cell) => cell.file),
  );
  const fallbackContext = await newContext();
  let failedRequests = 0;
  await fallbackContext.route('**/worlds/player-position-browser/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if ([...savedFiles].some((file) => path.endsWith(`/${file}`))) {
      failedRequests++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'corrupt bytes' });
    } else await route.continue();
  });
  const fallback = await signedIn(fallbackContext);
  await fallback.page.locator('#join:not([disabled])').click();
  await fallback.page
    .locator('#notice')
    .filter({
      hasText: 'Не удалось вернуться на прежнее место. Появляемся на старте',
    })
    .waitFor();
  const defaultSpawn = await healthy(fallback.page);
  samePosition(defaultSpawn.authoritative.position, startPosition);
  const fallbackPlans = await fallback.page.evaluate(() => (window as any).__positionPlans);
  assert.ok(defaultSpawn.preparations.some((plan: any) => plan.spawnSource === 'saved'));
  assert.ok(defaultSpawn.preparations.some((plan: any) => plan.spawnSource === 'default'));
  assert.ok(failedRequests >= 2, 'integrity verification retries corrupt saved-area bytes');
  assert.ok(defaultSpawn.streaming.resources.integrityRetries > 0);
  await chat(fallback.page, 'Старт работает после отказа');
  await fallback.page.locator('#world').focus();
  await fallback.page.keyboard.down('s');
  await fallback.page.waitForTimeout(550);
  await fallback.page.keyboard.up('s');
  await fallback.page.waitForTimeout(350);
  const afterFallback = (await healthy(fallback.page)).authoritative.position;
  assert.ok(
    Math.hypot(afterFallback.x - startPosition.x, afterFallback.z - startPosition.z) > 0.25,
  );
  await fallback.page.screenshot({ path: `${output}/fallback-playing.png` });
  await hudClick(fallback.page, '#respawn');
  await playing(fallback.page);
  await fallback.page.waitForFunction(
    (revision) => (window as any).__SU_DEBUG__.snapshot().authoritative?.revision > revision,
    defaultSpawn.authoritative.revision,
  );
  samePosition((await snapshot(fallback.page)).authoritative.position, startPosition);
  await leave(fallback.page);
  const savedDefault = await enter(fallback.page);
  samePosition(savedDefault.authoritative.position, startPosition);
  await leave(fallback.page);
  measurements.push({ savedCells, startCells, failedRequests, fallbackPlans, afterFallback });
  record(
    'only saved-region resources fail integrity checks; one automatic fallback reaches a playable default area',
  );
  record(
    'the UI respawn action uses the ordinary start and immediately becomes the next saved position',
  );
  await fallbackContext.close();

  const globalContext = await newContext();
  const allCellFiles = manifest.cells.map((cell) => cell.file);
  await globalContext.route('**/worlds/player-position-browser/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (allCellFiles.some((file) => path.endsWith(`/${file}`)))
      await route.fulfill({ status: 503, body: 'fixture unavailable' });
    else await route.continue();
  });
  const global = await signedIn(globalContext);
  await global.page.locator('#join:not([disabled])').click();
  await global.page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'preparing',
  );
  await global.page.waitForFunction(
    () => {
      const state = (window as any).__SU_DEBUG__.snapshot();
      return ['ready', 'error'].includes(state.connection) && !state.authoritative;
    },
    undefined,
    { timeout: 22_000 },
  );
  const globalPlans = await global.page.evaluate(() => (window as any).__positionPlans);
  assert.equal(globalPlans.filter((plan: any) => plan.spawnSource === 'default').length, 1);
  assert.equal(app.room.state.players.size, 0);
  await global.page.screenshot({ path: `${output}/global-resource-failure.png` });
  measurements.push({ globalPlans, globalSnapshot: await snapshot(global.page) });
  record(
    'global critical-resource outage ends with the existing preparation error and no unsafe player or endless fallback',
  );

  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/report.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        result: 'passed',
        browser: browser.version(),
        protocolVersion: PROTOCOL_VERSION,
        databaseVersion: DATABASE_SCHEMA_VERSION,
        world: 'player-position-browser: isolated flat world with 8m cells',
        provider: 'local OIDC fixture with real RS256 validation',
        database: 'isolated PostgreSQL schema',
        checks,
        measurements,
        browserErrors: errors,
        manualCityAcceptance:
          'not performed; ring-block requires the separate manual acceptance checklist',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ result: 'passed', checks, output }, null, 2));
} catch (error) {
  await currentPage?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  const state = await currentPage
    ?.evaluate(() => ({
      snapshot: (window as any).__SU_DEBUG__?.snapshot(),
      controls: (window as any).__SU_DEBUG__?.controls(),
      plans: (window as any).__positionPlans,
      notice: document.getElementById('notice')?.textContent,
    }))
    .catch(() => undefined);
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        checks,
        measurements,
        errors,
        error: String(error),
        state,
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
