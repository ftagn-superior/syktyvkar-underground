import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import type { Page } from 'playwright';
import { createGameServer } from '../apps/server/src/index.js';
import { buildWorld } from '../tools/world-build/src/index.js';
import { launchTestBrowser } from './helpers/browser.js';
import { createDelayRelay } from './helpers/tcp-delay.js';
import { hash } from './large-map/content.js';
const output = process.env.SU_L3_OUTPUT ?? 'output/large-map/l3';
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'su-l3-browser-'));
const browser = await launchTestBrowser();
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let relay: Awaited<ReturnType<typeof createDelayRelay>> | undefined;
const errors: string[] = [],
  logs: string[] = [];
const checks: string[] = [];
const phases: Record<string, unknown> = {};
let activePages: Page[] = [];
const keysHeld = new Map<Page, string[]>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
async function keys(page: Page, next: string[]) {
  for (const key of keysHeld.get(page) ?? []) if (!next.includes(key)) await page.keyboard.up(key);
  for (const key of next)
    if (!(keysHeld.get(page) ?? []).includes(key)) await page.keyboard.down(key);
  keysHeld.set(page, next);
}
async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 22000 },
  );
}
async function move(page: Page, x: number, z: number, timeout = 55000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const snapshot = await state(page);
    if (snapshot.connection !== 'playing' || !snapshot.predicted) {
      await keys(page, []);
      await sleep(40);
      continue;
    }
    const position = snapshot.predicted.position;
    assert.ok(position.y > 0.8, 'Capsule fell through a ground seam');
    assert.ok(
      snapshot.pendingInputs <= 32 && snapshot.historyInputs <= 30,
      'Input/history budget exceeded',
    );
    const dx = x - position.x,
      dz = z - position.z;
    if (Math.hypot(dx, dz) < 0.2) {
      await keys(page, []);
      await sleep(250);
      return;
    }
    const diagonal =
      Math.abs(dx) > 0.3 &&
      Math.abs(dz) > 0.3 &&
      Math.abs(dx / dz) > 0.7 &&
      Math.abs(dx / dz) < 1.4;
    const next = diagonal
      ? [dx > 0 ? (dz > 0 ? 's' : 'd') : dz > 0 ? 'a' : 'w']
      : Math.abs(dx) > Math.abs(dz)
        ? dx > 0
          ? ['d', 's']
          : ['w', 'a']
        : dz > 0
          ? ['a', 's']
          : ['w', 'd'];
    await keys(page, next);
    await sleep(35);
  }
  await keys(page, []);
  throw new Error(`Movement timeout ${x},${z}`);
}
async function pushAcross(page: Page, direction: -1 | 1, targetX: number) {
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    const snapshot = await state(page);
    if (direction * (snapshot.crate.position.x - targetX) > 0) {
      await keys(page, []);
      return;
    }
    if (snapshot.connection !== 'playing' || !snapshot.predicted) {
      await keys(page, []);
      await sleep(40);
      continue;
    }
    const own = snapshot.predicted.position,
      crate = snapshot.crate.position;
    // Off-center contact can rotate and deflect a physical crate. Re-align using real controls.
    if (direction * (own.x - crate.x) > -0.65) {
      await keys(page, []);
      await move(page, own.x, crate.z + 2);
      await move(page, crate.x - direction * 2, crate.z + 2);
      await move(page, crate.x - direction * 2, crate.z);
    } else if (Math.abs(own.z - crate.z) > 0.09) {
      await keys(page, own.z < crate.z ? ['a', 's'] : ['w', 'd']);
    } else await keys(page, direction > 0 ? ['d', 's'] : ['w', 'a']);
    await sleep(35);
  }
  await keys(page, []);
  throw new Error(`Client did not push the crate across ${targetX}`);
}
const stage = (name: string) => console.log(`L3: ${name}`);
try {
  await cp('content', join(temporary, 'content'), { recursive: true });
  const source = join(temporary, 'content/worlds/streaming-lab/world.json');
  const header = JSON.parse(await readFile(source, 'utf8'));
  header.spawnPoints = [
    { x: -4, y: 0, z: 10 },
    { x: 4, y: 0, z: 10 },
    { x: -996, y: 0, z: 4 },
    { x: -996, y: 0, z: 504 },
    { x: 504, y: 0, z: -996 },
    { x: -496, y: 0, z: 754 },
    { x: 754, y: 0, z: -496 },
    { x: 504, y: 0, z: 504 },
  ];
  header.crate.position.x = -1;
  await writeFile(source, JSON.stringify(header));
  const manifest = await buildWorld(source, join(temporary, 'world'));
  app = await createGameServer({ port: 0, worldDirectory: join(temporary, 'world') });
  const profile = { name: 'rtt100-jitter20', rttMs: 100, jitterMs: 20 };
  relay = await createDelayRelay(new URL(app.url), profile);
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 960, height: 640 } })),
  );
  const pages = await Promise.all(
    contexts.map(async (context) => {
      await context.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
      return context.newPage();
    }),
  );
  activePages = pages;
  const http: string[][] = [[], []];
  const boundaryWaits: any[] = [];
  const states: any[] = [];
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type()))
        logs.push(
          message.text().replace(/([?&](?:reconnectionToken|token)=)[^&\s'"]+/g, '$1[redacted]'),
        );
    });
    page.on('request', (request) => {
      if (request.url().includes('/worlds/')) http[index].push(new URL(request.url()).pathname);
    });
    if (index === 0) {
      const boundaryFile = manifest.cells.find((cell) => cell.cellId === '9_8')!.file;
      await page.route(`**/worlds/streaming-lab/${boundaryFile}`, async (route) => {
        await sleep(250);
        boundaryWaits.push(await state(page));
        await sleep(500);
        await route.continue();
      });
    }
    await page.goto(relay.url + '/?diagnostics=1');
    await page.locator('#join:not([disabled])').waitFor();
    assert.ok(
      !http[index].some((path) => path.endsWith('.glb') || path.includes('/cells/')),
      'Full world fetched before a server plan',
    );
    await page.locator('#join').click();
    await playing(page);
    const current = await state(page);
    states.push(current);
    assert.equal(current.streaming.required.length, 9);
    assert.equal(current.predictionWorlds, 1);
    assert.equal(current.physics.crate, true);
    assert.ok(
      !http[index].some((path) =>
        ['house-remote-a', 'house-remote-b'].some((id) =>
          path.endsWith(manifest.assets[id].modelFile),
        ),
      ),
      'Remote model fetched',
    );
  }
  phases.cold = { http: http.map((paths) => paths.slice()), states };
  checks.push(
    'Cold entry fetches only the server-planned neighborhoods/dependencies, with no remote models',
  );
  stage('cold entry passed');
  const [first, second] = pages;
  await first.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().playerCount === 2);
  const identity = (await state(first)).authoritative.entityId;
  // Each participant pushes the same authoritative crate across x=0 from its own side.
  await move(second, 5, 14);
  await keys(first, ['d', 's']);
  await first.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.position.x > 1.5,
    undefined,
    { timeout: 6000 },
  );
  await keys(first, []);
  phases.heldMovementAfterWait = await state(first);
  await pushAcross(first, 1, 1);
  await move(first, (await state(first)).authoritative.position.x, 4);
  phases.firstPush = await Promise.all(pages.map(state));
  const movingCrate = (await state(second)).crate.position;
  await move(second, Math.max(4, movingCrate.x + 2), movingCrate.z);
  await pushAcross(second, -1, -0.3);
  await sleep(650);
  const pushes = await Promise.all(pages.map(state));
  assert.ok(
    Math.hypot(
      pushes[0].crate.position.x - pushes[1].crate.position.x,
      pushes[0].crate.position.z - pushes[1].crate.position.z,
    ) < 0.1,
  );
  phases.boundaryWaits = boundaryWaits;
  assert.ok(boundaryWaits.length > 0, 'Boundary delay did not exercise preparation');
  assert.ok(
    boundaryWaits.every(
      (sample) => sample.areaWaiting && sample.streaming.required.includes('9_8'),
    ),
    'Waiting cancelled the predicted target',
  );
  checks.push(
    'A delayed next row remains required while prediction is paused; the held movement key resumes',
  );
  phases.pushes = pushes;
  checks.push(
    'Two independent clients meet from different cells and push one crate across the seam in both directions',
  );
  stage('shared crate passed');
  await move(first, -3, -3);
  await move(first, 3, 3);
  phases.corner = await state(first);
  assert.equal((phases.corner as any).authoritative.entityId, identity);
  checks.push(
    'Side/corner transitions retain identity and the prediction world, with supported ground',
  );
  stage('corner passed');
  await move(first, 130, 4);
  await sleep(300);
  const distant = await state(first);
  phases.distant = distant;
  assert.equal(distant.predictionWorlds, 1);
  assert.ok(distant.replaySteps > 0, 'RTT profile did not exercise rollback replay');
  assert.ok(distant.historyPeak <= 30);
  assert.ok(distant.physics.entities < 300, 'Client loaded full static world');
  stage('distant movement passed');
  await contexts[0].setOffline(true);
  await first.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
    undefined,
    { timeout: 12000 },
  );
  await sleep(300);
  await contexts[0].setOffline(false);
  await playing(first);
  assert.equal((await state(first)).authoritative.entityId, identity);
  phases.reconnect = await state(first);
  checks.push('A short drop prepares the actual distant area and restores the same entity');
  http[0].length = 0;
  await first.reload();
  await playing(first);
  const restored = await state(first);
  phases.reload = restored;
  assert.equal(restored.authoritative.entityId, identity);
  assert.ok(restored.authoritative.position.x > 125);
  assert.ok(
    !http[0].some((path) => path.includes('/cells/6_')),
    'Distant reload fetched the original region',
  );
  checks.push('Reload restores the stored identity and fetches the actual distant area');
  stage('remote reconnect/reload passed');
  const targetFile = manifest.cells.find((cell) => cell.cellId === '6_8')!.file;
  let fail = true;
  let delayed = 0;
  await first.route(`**/worlds/streaming-lab/${targetFile}`, async (route) => {
    if (fail) await route.fulfill({ status: 503, body: 'L3 resource fault' });
    else {
      delayed++;
      await sleep(1300);
      await route.continue();
    }
  });
  await first.locator('#respawn').click();
  await first.waitForFunction(
    () => !!(window as any).__SU_DEBUG__.snapshot().areaProblem,
    undefined,
    { timeout: 8000 },
  );
  const waiting = await state(first);
  phases.waiting = waiting;
  assert.equal(waiting.authoritative.revision, restored.authoritative.revision);
  assert.ok(
    waiting.streaming.required.includes('9_8') && waiting.streaming.required.includes('7_8'),
    'Old and target cells are not held together',
  );
  const otherBefore = (await state(second)).authoritative.position;
  await move(second, otherBefore.x, otherBefore.z + 2);
  const otherAfter = (await state(second)).authoritative.position;
  assert.ok(
    Math.hypot(otherAfter.x - otherBefore.x, otherAfter.z - otherBefore.z) > 1.5,
    'Waiting client stopped the other player',
  );
  const stillWaiting = await state(first);
  assert.ok(
    Math.hypot(
      stillWaiting.authoritative.position.x - waiting.authoritative.position.x,
      stillWaiting.authoritative.position.z - waiting.authoritative.position.z,
    ) < 0.05,
    'Return moved before readiness',
  );
  fail = false;
  await first.locator('#area-retry').click();
  await playing(first);
  const returned = await state(first);
  phases.returned = returned;
  assert.equal(returned.authoritative.entityId, identity);
  assert.equal(returned.authoritative.revision, restored.authoritative.revision + 1);
  assert.ok(Math.abs(returned.authoritative.position.x) < 20 && delayed > 0);
  await first.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().streaming.cells.length === 9,
    undefined,
    { timeout: 10000 },
  );
  phases.released = await state(first);
  checks.push(
    'Slow/failed HTTP keeps the old character neutral; another player moves; retry commits one return and releases old cells',
  );
  stage('delayed return passed');
  const correctionHistories = await Promise.all(
    pages.map((page) => page.evaluate(() => (window as any).__SU_DEBUG__.corrections())),
  );
  const sourceFiles = [
    'apps/client/src/main.ts',
    'apps/client/index.html',
    'apps/client/src/rendering/world-view.ts',
    'apps/client/src/rendering/world-decoration.ts',
    'apps/client/src/network/session.ts',
    'apps/client/src/streaming/resources.ts',
    'apps/client/src/streaming/cells.ts',
    'apps/client/src/streaming/prediction-area.ts',
    'apps/server/src/world-room.ts',
    'packages/protocol/src/index.ts',
    'packages/contracts/src/index.ts',
    'packages/contracts/src/world-grid.ts',
    'packages/simulation/src/prediction.ts',
    'packages/simulation/src/authoritative-world.ts',
    'tests/large-map-l3.ts',
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(sourceFiles.map(async (path) => [path, hash(await readFile(path))])),
  );
  assert.deepEqual(errors, []);
  await first.screenshot({ path: output + '/returned.png' });
  const result = {
    date: new Date().toISOString(),
    result: 'passed',
    profile,
    browser: browser.version(),
    cpu: cpus()[0].model,
    renderer: 'SwiftShader',
    mapVersion: manifest.mapVersion,
    simulationConfigHash: manifest.simulationConfigHash,
    sourceHashes,
    checks,
    phases,
    correctionHistories,
    http,
    relay: relay.metrics(),
    errors,
    logs,
    server: app.room.diagnostics(),
  };
  await rm(output + '/failure.json', { force: true });
  await writeFile(output + '/browser.json', JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        result: result.result,
        checks,
        server: result.server,
        corrections: correctionHistories.map((history) => history.samples.length),
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    output + '/failure.json',
    JSON.stringify(
      {
        error: String(error),
        errors,
        logs,
        phases,
        lastStates: await Promise.all(activePages.map((page) => state(page).catch(() => null))),
        server: app?.room.diagnostics(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  await relay?.close();
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
