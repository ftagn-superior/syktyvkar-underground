import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BusNetwork } from '../packages/contracts/src/index.js';
import { buildWorld } from '../tools/world-build/src/index.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';
import { createGameServer } from './helpers/game-server.js';

// Run after pnpm build. Every SQL write stays in the account fixture's disposable schema.
if (!process.env.SU_TEST_DATABASE_URL) throw new Error('SU_TEST_DATABASE_URL is required.');
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const temporary = await mkdtemp(join(tmpdir(), 'su-interactions-'));
const output = 'output/playwright/interactions';
const network: BusNetwork = {
  formatVersion: 3,
  stops: [
    {
      id: 'start',
      name: 'Начало',
      position: [-3, 4],
      routes: ['1'],
      source: 'osm',
      platforms: [{ id: 'p-start', position: [-3, 4], source: 'osm' }],
    },
    {
      id: 'end',
      name: 'Конец',
      position: [10, 4],
      routes: ['1'],
      source: 'osm',
      platforms: [{ id: 'p-end', position: [10, 4], source: 'osm' }],
    },
  ],
  routes: [
    {
      id: '1',
      ref: '1',
      name: 'Проверочный',
      from: 'Начало',
      to: 'Конец',
      circular: false,
      directions: [
        {
          towards: 'Конец',
          circular: false,
          sequence: [
            { stopId: 'start', platformId: 'p-start' },
            { stopId: 'end', platformId: 'p-end' },
          ],
          legs: [
            [
              [
                [-3, 4],
                [10, 4],
              ],
            ],
          ],
        },
      ],
    },
  ],
};
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
const checks: string[] = [];
const errors: string[] = [];
let travelRequests = 0;
const checked = (message: string) => {
  checks.push(message);
  console.log(`Passed: ${message}`);
};

try {
  await mkdir(output, { recursive: true });
  await cp('content', join(temporary, 'content'), { recursive: true });
  const source = join(temporary, 'content/worlds/physics-lab/world.json');
  const authored = JSON.parse(await readFile(source, 'utf8'));
  authored.initialItems = [-3, -4.4].map((x, index) => ({
    seedId: `interaction-${index}`,
    typeId: 'wooden-crate',
    position: { x, y: 0.52, z: 2 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  }));
  await writeFile(source, JSON.stringify(authored));
  const release = join(temporary, 'release');
  await buildWorld(source, release);
  // Keep the map endpoint local too, rather than requesting an unavailable city background.
  await writeFile(join(release, 'bus-map.json'), JSON.stringify({ roads: [], buildings: [] }));
  app = await createGameServer({
    port: 0,
    accounts: fixture,
    worldDirectory: release,
    busNetwork: network,
  });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      if (payload.toString().includes('requestBusTravel')) travelRequests++;
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem('su:render-quality:v1', 'economy');
    localStorage.setItem('su:help-tip:v1', '1');
  });
  const snapshot = () => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
  const bus = page.locator('.bus-map-backdrop');
  const prompt = page.locator('.su-ctx:not([hidden])');
  await page.goto(`${app.url}/?diagnostics=1`);
  await page.locator('#telegram-login').click();
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  await page.goto(`${app.url}/?diagnostics=1`);
  await page.locator('#join:not([disabled])').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
  );
  await prompt.waitFor();
  assert.match(await prompt.innerText(), /Пробел.*Подобрать/s);
  assert.equal(await prompt.getAttribute('aria-keyshortcuts'), 'Space');
  await page.screenshot({ path: `${output}/pickup-space.png` });
  await page.locator('#world').focus();
  await page.keyboard.press('z');
  await page.waitForTimeout(150);
  assert.equal((await snapshot()).items.length, 2);
  assert.equal(await bus.isHidden(), true);
  checked('Space pickup prompt wins over the closer bus stop; Z activates neither target');

  await page.keyboard.press('x');
  await page.locator('#inventory-panel').waitFor({ state: 'visible' });
  assert.match(await page.locator('#inventory-note').innerText(), /Пусто.*нажмите пробел/);
  await page.keyboard.press('Escape');
  checked('the empty inventory also explains the Space pickup binding');

  await page.keyboard.press('t');
  await page.locator('#chat-input').fill('два');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#chat-input').inputValue(), 'два ');
  assert.equal((await snapshot()).items.length, 2);
  await page.keyboard.press('Escape');
  for (const tag of ['input', 'textarea', 'div']) {
    await page.evaluate((name) => {
      const field = document.createElement(name);
      field.id = 'interaction-text';
      if (name === 'div') field.contentEditable = 'true';
      field.style.cssText =
        'position:fixed;top:0;left:0;z-index:10000;min-width:100px;min-height:40px';
      document.body.append(field);
      field.focus();
    }, tag);
    await page.keyboard.press('Space');
    assert.equal(
      await page
        .locator('#interaction-text')
        .evaluate((node) =>
          node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
            ? node.value
            : node.textContent?.replace(/\u00a0/g, ' '),
        ),
      ' ',
    );
    assert.equal((await snapshot()).items.length, 2);
    await page.locator('#interaction-text').evaluate((node) => node.remove());
  }
  checked('Space types in chat, input, textarea and contenteditable without collecting');

  await page.locator('#world').focus();
  for (let count = 1; count <= 2; count++) {
    await page.waitForFunction(() => {
      const state = (window as any).__SU_DEBUG__.snapshot();
      return (
        !state.itemPending &&
        !state.storagePaused &&
        document.querySelector('.su-ctx-act')?.textContent === 'Подобрать'
      );
    });
    // Focus the prompt itself to exercise the browser's native Space-to-click behavior as well.
    await prompt.focus();
    await page.keyboard.down('Space');
    await page.waitForFunction(
      (expected) =>
        (window as any).__SU_DEBUG__.snapshot().inventory.slots.flatMap((s: any) => s.items)
          .length === expected,
      count,
    );
    await page.keyboard.down('Space'); // Playwright marks the second keydown as repeat.
    await page.waitForTimeout(200);
    assert.equal((await snapshot()).items.length, 2 - count);
    assert.equal(await bus.isHidden(), true, 'held Space must not activate the next target');
    await page.keyboard.up('Space');
    await page.waitForTimeout(150);
    assert.equal(await bus.isHidden(), true, 'keyup must not click the new stop prompt');
  }
  checked(
    'each fresh Space collects one item; repeat and native button keyup never activate another target',
  );
  await page.keyboard.press('x');
  await page.locator('#inventory-panel').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  checked('X still opens the inventory');

  await page.keyboard.press('h');
  assert.match(
    await page.locator('#help-panel .keys').innerText(),
    /Взаимодействие · подобрать\s+Пробел/,
  );
  await page.locator('[data-theme-mode="auto"]').focus();
  await page.keyboard.press('Space');
  assert.equal(await bus.isHidden(), true);
  await page.keyboard.press('Escape');
  checked('help shows Space and owns focused button input');

  await page.locator('#world').focus();
  await page.keyboard.press('v');
  await page.waitForFunction(
    () =>
      !!document.pointerLockElement &&
      (window as any).__SU_DEBUG__.controls().view === 'first-person',
  );
  await page.waitForFunction(
    () => document.querySelector('.su-ctx-act')?.textContent === 'Автобусы',
  );
  await page.keyboard.press('z');
  assert.equal(await bus.isHidden(), true);
  await page.keyboard.down('Space');
  await bus.waitFor({ state: 'visible' });
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  assert.equal(
    await page.locator('.bus-map-side [data-stop="end"]').count(),
    1,
    'holding the opening Space must not click the newly focused route button',
  );
  assert.equal(
    (await page.evaluate(() => (window as any).__SU_DEBUG__.controls())).view,
    'overview',
  );
  checked('Space opens the stop from first person and preserves its existing return to overview');

  await page.locator('.bus-map-side [data-stop="end"]').focus();
  await page.keyboard.press('Space');
  const go = page.locator('.bus-go');
  await go.waitFor();
  assert.match(await go.innerText(), /Пробел/);
  await page.screenshot({ path: `${output}/bus-space.png` });
  const beforeTravel = (await snapshot()).authoritative.revision;
  await page.keyboard.press('z');
  assert.equal(await bus.isVisible(), true);
  assert.equal((await snapshot()).authoritative.revision, beforeTravel);
  await go.focus();
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  await bus.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    (before) => (window as any).__SU_DEBUG__.snapshot().authoritative.revision > before,
    beforeTravel,
  );
  assert.equal((await snapshot()).authoritative.revision, beforeTravel + 1);
  assert.equal(travelRequests, 1, 'one press sends exactly one travel request');
  checked(
    'Space on a focused destination selects it; Space on travel sends one trip and Z sends none',
  );

  // Server-side placement uses the same API as arrival; put the player outside both prompt ranges.
  const world = (app.room as any).world;
  const player = [...app.room.state.players.values()][0]!;
  const away = world.findGroundSpawn([{ x: -12, z: 14 }], player.entityId);
  assert.ok(away);
  assert.equal(world.respawnPlayerAtPosition(player.entityId, away), true);
  await page.waitForFunction(() => !!document.querySelector('.su-ctx[hidden]'));
  await page.locator('#world').focus();
  const previousScroll = await page.evaluate(() => {
    document.documentElement.style.overflow = 'auto';
    document.body.style.minHeight = '250vh';
    return scrollY;
  });
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => scrollY), previousScroll);
  checked('Space and auto-repeat do not scroll even with no contextual target');

  const touchContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await touchContext.addInitScript(() => {
    localStorage.setItem('su:render-quality:v1', 'economy');
    localStorage.setItem('su:help-tip:v1', '1');
  });
  const touch = await touchContext.newPage();
  touch.on('pageerror', (error) => errors.push(error.message));
  await touch.goto(`${app.url}/?diagnostics=1`);
  await touch.locator('#join:not([disabled])').tap();
  await touch.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
  );
  const touchSessionId = await touch.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().sessionId,
  );
  const touchPlayer = app.room.state.players.get(touchSessionId)!;
  const boarding = world.findGroundSpawn([{ x: -3, z: 4 }], touchPlayer.entityId);
  assert.ok(boarding);
  assert.equal(world.respawnPlayerAtPosition(touchPlayer.entityId, boarding), true);
  const touchPrompt = touch.locator('.su-ctx:not([hidden])');
  await touchPrompt.waitFor();
  await touch.keyboard.press('Space');
  assert.equal(await touch.locator('.bus-map-backdrop').isHidden(), true);
  assert.equal(await touch.evaluate(() => (window as any).__SU_DEBUG__.controls().mode), 'touch');
  await touchPrompt.tap();
  await touch.locator('.bus-map-backdrop').waitFor({ state: 'visible' });
  checked('touch ignores hardware Space, keeps touch mode and opens the stop by tapping');

  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      { result: 'passed', browser: browser.version(), checks, travelRequests, errors },
      null,
      2,
    ) + '\n',
  );
  console.log('Interaction browser journey passed.');
} catch (error) {
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) {
      await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
      console.error(
        'INTERACTION_DIAGNOSTICS',
        await page
          .evaluate(() => ({
            controls: (window as any).__SU_DEBUG__?.controls(),
            snapshot: (window as any).__SU_DEBUG__?.snapshot(),
            prompt: document.querySelector('.su-ctx')?.outerHTML,
            bus: document.querySelector('.bus-map-side')?.innerHTML,
          }))
          .catch(() => null),
      );
    }
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
