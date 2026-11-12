import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from 'playwright';
import { createAccountFixture } from './helpers/account-fixture.js';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { buildWorld } from '../tools/world-build/src/index.js';

if (!process.env.SU_TEST_DATABASE_URL) throw new Error('SU_TEST_DATABASE_URL is required.');
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const directory = await mkdtemp(join(tmpdir(), 'su-first-person-geometry-'));
const output = 'output/playwright/first-person-geometry';
const browser = await launchTestBrowser({ channel: 'chromium' });
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let player: Page | undefined;
const checks: string[] = [];
const errors: string[] = [];
const snapshot = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const rendering = (page: Page) =>
  page.evaluate(() => (window as any).__SU_DEBUG__.report().rendering);
const record = (message: string) => {
  checks.push(message);
  console.log(`Passed: ${message}`);
};
const playing = (page: Page) =>
  page.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().connection === 'playing');
const mouse = { x: 400, y: 300 };
async function aim(page: Page, yaw: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = (await rendering(page)).camera;
    const delta = Math.atan2(Math.sin(yaw - current.yaw), Math.cos(yaw - current.yaw));
    if (Math.abs(delta) < 0.01 && Math.abs(current.pitch) < 0.01) return;
    mouse.x -= delta / 0.002;
    mouse.y += current.pitch / 0.002;
    await page.mouse.move(mouse.x, mouse.y, { steps: 8 });
    await page.waitForTimeout(120);
  }
  const current = (await rendering(page)).camera;
  assert.ok(
    Math.abs(Math.atan2(Math.sin(yaw - current.yaw), Math.cos(yaw - current.yaw))) < 0.02,
    'native mouse aims at the intended world yaw',
  );
}
async function capture(page: Page) {
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable);
  if ((await page.evaluate(() => (window as any).__SU_DEBUG__.controls().view)) === 'overview')
    await page.keyboard.press('v');
  else await page.locator('#world').click({ position: { x: 400, y: 300 } });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(1200);
    if (await page.evaluate(() => (window as any).__SU_DEBUG__.controls().pointerLocked)) break;
    await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable);
    await page.locator('#world').click({ position: { x: 400, y: 300 } });
  }
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().pointerLocked);
}
try {
  await mkdir(output, { recursive: true });
  await cp('content', join(directory, 'content'), { recursive: true });
  const source = join(directory, 'content/worlds/physics-lab/world.json');
  const world = JSON.parse(await readFile(source, 'utf8'));
  world.entities.push({
    entityId: 'first-person-test-wall',
    kind: 'obstacle',
    position: { x: 0, y: 1.5, z: 4 },
    size: { x: 0.4, y: 3, z: 3 },
    mass: 0,
    friction: 0.6,
    restitution: 0,
    color: '#718292',
  });
  world.initialItems[0].position = { x: -3, y: 0.52, z: 2 };
  await writeFile(source, JSON.stringify(world));
  const release = join(directory, 'release');
  await buildWorld(source, release);
  app = await createGameServer({ port: 0, accounts: fixture, worldDirectory: release });
  fixture.config.publicOrigin = app.url;
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 640, height: 480 } })),
  );
  for (const context of contexts)
    await context.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  const [first, second] = await Promise.all(contexts.map((context) => context.newPage()));
  player = first;
  for (const [index, page] of [first, second].entries()) {
    page.setDefaultTimeout(20_000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(app.url + '/?diagnostics=1');
    if (index === 0) {
      await page.locator('#telegram-login').click();
      await page.locator('#profile-form').waitFor({ state: 'visible' });
      await page.goto(app.url + '/?diagnostics=1');
    }
    await page.locator('#join:not([disabled])').click();
    await playing(page);
  }
  const otherId = (await snapshot(second)).authoritative.entityId;
  await first.bringToFront();
  await first.mouse.move(mouse.x, mouse.y);
  await first.locator('#world').focus();
  await capture(first);
  await aim(first, Math.PI / 2);
  await first.waitForFunction((id) => {
    const entity = (window as any).__SU_DEBUG__
      .report()
      .rendering.dynamicEntities.find((entry: any) => entry.entityId === id);
    return entity?.overlayBlocked && !entity.overlayVisible;
  }, otherId);
  await first.screenshot({ path: `${output}/wall-occludes-player.png` });
  await first.keyboard.down('w');
  await first.waitForTimeout(1100);
  await first.keyboard.up('w');
  const stopped = await snapshot(first);
  const eye = (await rendering(first)).camera.position;
  assert.ok(stopped.authoritative.position.x < -0.54, 'the capsule remains outside the wall');
  assert.ok(
    eye.x < -0.54 && Math.abs(eye.x - stopped.predicted.position.x) < 0.001,
    'eyes stay at the protected physical position',
  );
  record(
    'a solid wall hides peer overlays and blocks both the capsule and the unsmoothed eye camera',
  );

  await aim(first, 0);
  await first.keyboard.down('w');
  await first.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.position.z > 9,
  );
  await first.keyboard.up('w');
  const position = (await snapshot(first)).predicted.position;
  await aim(first, Math.atan2(3 - position.x, 4 - position.z));
  await first.waitForFunction((id) => {
    const entity = (window as any).__SU_DEBUG__
      .report()
      .rendering.dynamicEntities.find((entry: any) => entry.entityId === id);
    return entity?.overlayVisible && !entity.overlayBlocked;
  }, otherId);
  await first.screenshot({ path: `${output}/peer-after-wall.png` });
  record(
    'walking around the wall restores the visible peer overlay through the shared physics ray query',
  );

  await first.keyboard.press('h');
  await first.locator('#respawn').click();
  await playing(first);
  await first.waitForTimeout(500);
  await first.keyboard.press('h');
  await capture(first);
  const itemsBefore = (await snapshot(first)).items.length;
  for (const key of ['x', 'z', 'r', 'f']) await first.keyboard.press(key);
  await first.waitForTimeout(350);
  assert.equal((await snapshot(first)).items.length, itemsBefore);
  assert.equal(await first.locator('#inventory-panel').isVisible(), false);
  assert.equal(await first.locator('.su-ctx:not([hidden])').count(), 0);
  await first.keyboard.press('v');
  await first.waitForFunction(() => (window as any).__SU_DEBUG__.controls().view === 'overview');
  await first.waitForFunction(() => !!document.querySelector('.su-ctx:not([hidden])'));
  await first.keyboard.press('z');
  await first.waitForFunction(
    (count) => (window as any).__SU_DEBUG__.snapshot().items.length < count,
    itemsBefore,
  );
  await first.keyboard.press('x');
  await first.locator('#inventory-panel').waitFor({ state: 'visible' });
  await first.keyboard.press('Escape');
  record(
    'an authenticated player cannot collect or open inventory in first person, and can collect and open it in overview',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/report.json`,
    JSON.stringify(
      { checks, errors, browser: browser.version(), rendering: await rendering(first) },
      null,
      2,
    ),
  );
} catch (error) {
  await player?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  const state = await player
    ?.evaluate(() => ({
      snapshot: (window as any).__SU_DEBUG__?.snapshot(),
      controls: (window as any).__SU_DEBUG__?.controls(),
      rendering: (window as any).__SU_DEBUG__?.report().rendering,
    }))
    .catch(() => undefined);
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify({ checks, errors, error: String(error), state }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await app?.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
