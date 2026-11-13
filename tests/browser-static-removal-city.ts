import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';
import { openChat } from './helpers/hud.js';

if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('Set SU_TEST_DATABASE_URL to a test PostgreSQL database.');

const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
const errors: string[] = [];
const output = 'output/playwright/static-removal-city';
async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 45000 },
  );
}

try {
  app = await createGameServer({
    port: 0,
    accounts: fixture,
    worldDirectory: 'dist/worlds/ring-block',
  });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser({ channel: 'chromium' });
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const observerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const owner = await ownerContext.newPage(),
    observer = await observerContext.newPage();
  for (const page of [owner, observer]) {
    page.setDefaultTimeout(60000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  }
  await owner.goto(app.url);
  await owner.locator('#telegram-login').click();
  await owner.locator('#profile-form').waitFor({ state: 'visible' });
  for (const page of [owner, observer]) {
    await page.bringToFront();
    await page.goto(app.url + '/?diagnostics=1');
    await page.waitForFunction(
      () => (window as any).__SU_DEBUG__?.snapshot().streaming?.backgroundReady === true,
      undefined,
      { timeout: 90000 },
    );
    await page.locator('#join:not([disabled])').click();
    await playing(page);
  }
  await owner.bringToFront();
  // Keep the initial player positions; zoom out through the normal camera wheel input.
  await owner.mouse.move(640, 400);
  await owner.mouse.wheel(0, 650);
  await owner.waitForTimeout(300);
  await openChat(owner);
  await owner.locator('#chat-input').fill('/vilievna');
  await owner.locator('#chat-send:not([disabled])').click();
  await owner.locator('#static-removal').waitFor({ state: 'visible' });
  const candidates: Array<{
    entityId: string;
    assetId: string;
    bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  }> = await owner.evaluate(() => {
    const debug = (window as any).__SU_DEBUG__;
    const position = debug.snapshot().authoritative.position;
    return debug
      .buildings()
      .buildings.filter((item: any) => item.assetId.startsWith('osm-way-') && item.bounds)
      .sort(
        (a: any, b: any) =>
          Math.hypot(a.position.x - position.x, a.position.z - position.z) -
          Math.hypot(b.position.x - position.x, b.position.z - position.z),
      );
  });
  let chosen: (typeof candidates)[number] | undefined;
  const attempts: unknown[] = [];
  for (const candidate of candidates.slice(0, 70)) {
    for (const fraction of [0.8, 0.55, 0.25]) {
      const { min, max } = candidate.bounds;
      const point = await owner.evaluate(
        (position) => {
          const point = (window as any).__SU_DEBUG__.project(position);
          const bounds = document.getElementById('world')!.getBoundingClientRect();
          return { x: point.x + bounds.left, y: point.y + bounds.top, visible: point.visible };
        },
        { x: (min.x + max.x) / 2, y: min.y + (max.y - min.y) * fraction, z: (min.z + max.z) / 2 },
      );
      if (!point.visible || point.y < 130 || point.y > 720) continue;
      await owner.mouse.move(point.x, point.y);
      await owner.waitForTimeout(90);
      const hovered = await owner.evaluate(() => (window as any).__SU_DEBUG__.removal().hovered);
      attempts.push({ entityId: candidate.entityId, point, hovered });
      if (hovered !== candidate.entityId) continue;
      await owner.mouse.click(point.x, point.y);
      await owner.waitForFunction(
        (id) => (window as any).__SU_DEBUG__.removal().selected === id,
        candidate.entityId,
      );
      chosen = candidate;
      break;
    }
    if (chosen) break;
  }
  await mkdir(output, { recursive: true });
  if (!chosen) {
    await owner.screenshot({ path: `${output}/selection-failed.png` });
    await writeFile(
      `${output}/selection-failed.json`,
      JSON.stringify({ candidates, attempts }, null, 2),
    );
  }
  assert.ok(chosen, 'a whole original city building can be selected with a real pointer');
  await owner.screenshot({ path: `${output}/selected-building.png` });
  const before = await owner.evaluate(() => (window as any).__SU_DEBUG__.snapshot().publication);
  const beforeBodies = app.room.diagnostics().bodies;
  const started = performance.now();
  await owner.locator('#static-removal-confirm:not([disabled])').click();
  await owner.locator('#static-removal').waitFor({ state: 'hidden' });
  for (const page of [owner, observer]) {
    await playing(page);
    await page.waitForFunction(
      (id) =>
        !(window as any).__SU_DEBUG__
          .buildings()
          .buildings.some((item: any) => item.entityId === id),
      chosen.entityId,
    );
    assert.notEqual(
      await page.evaluate(() => (window as any).__SU_DEBUG__.snapshot().publication.mapVersion),
      before.mapVersion,
    );
  }
  const elapsedMs = performance.now() - started;
  const stored = (
    await fixture.pool.query(
      'SELECT enabled,instance_revision FROM world_static_instances WHERE entity_id=$1',
      [chosen.entityId],
    )
  ).rows[0];
  assert.deepEqual(stored, { enabled: false, instance_revision: 2 });
  assert.ok(
    app.room.diagnostics().bodies < beforeBodies,
    'whole original building colliders are released',
  );
  assert.equal(
    (await fixture.pool.query("SELECT 1 FROM world_static_operations WHERE source='game'"))
      .rowCount,
    1,
  );
  assert.deepEqual(errors, []);
  await owner.screenshot({ path: `${output}/after-removal.png` });
  const result = {
    entityId: chosen.entityId,
    assetId: chosen.assetId,
    elapsedMs,
    server: app.room.diagnostics().staticPlacement,
    errors,
  };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
}
