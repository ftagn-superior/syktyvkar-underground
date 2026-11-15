import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture, setAccountAdmin } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';
import { openChat } from './helpers/hud.js';
import { buildingBounds, type WorldManifest } from '../packages/contracts/src/index.js';

if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('Set SU_TEST_DATABASE_URL to a test PostgreSQL database.');

const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
const errors: string[] = [];
const output = 'output/playwright/static-removal-city';
const viewport = {
  width: Number(process.env.SU_CITY_EDITOR_WIDTH ?? 1280),
  height: Number(process.env.SU_CITY_EDITOR_HEIGHT ?? 800),
};
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
  const ownerContext = await browser.newContext({ viewport });
  const observerContext = await browser.newContext({ viewport });
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
  const adminCookie = (await owner.context().cookies()).find(
    (cookie) => cookie.name === 'su_session',
  )!;
  await setAccountAdmin(fixture.store, `${adminCookie.name}=${adminCookie.value}`);
  for (const page of [owner, observer]) {
    await page.bringToFront();
    await page.goto(
      app.url +
        '/?diagnostics=1' +
        (process.env.SU_CITY_EDITOR_INITIAL_FAR === '1' ? '&initialZoom=30' : ''),
    );
    await page.waitForFunction(
      () => (window as any).__SU_DEBUG__?.snapshot().streaming?.backgroundReady === true,
      undefined,
      { timeout: 90000 },
    );
    await page.locator('#join:not([disabled])').click();
    await playing(page);
  }
  console.log('Both city clients joined');
  await owner.bringToFront();
  // Both clients observe far groups while retaining the independent player near pin.
  for (const page of [owner, observer]) {
    await page.bringToFront();
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    const zoom = await page.evaluate(
      () => (window as any).__SU_DEBUG__.report().rendering.camera.zoom,
    );
    await page.mouse.wheel(0, Math.log(30 / zoom) * 1000);
    await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await page.waitForFunction(
      () => {
        const r = (window as any).__SU_DEBUG__.report();
        return (
          Math.abs(r.rendering.camera.zoom - 30) < 1e-4 &&
          r.streaming.criticalReady &&
          r.streaming.groups.every((g: any) => !g.wanted || g.current === g.wanted) &&
          r.streaming.graphicsRequired.every((id: string) =>
            r.streaming.graphicsActive.includes(id),
          )
        );
      },
      undefined,
      { timeout: 300000 },
    );
    console.log('City far client ready', page === owner ? 'owner' : 'observer');
  }
  console.log('Both city clients reached far readiness');
  const beforeGameFar = await owner.evaluate(() => {
    const r = (window as any).__SU_DEBUG__.report();
    return {
      geometry: r.rendering.geometry,
      drawCalls: r.rendering.drawCalls,
      near: r.streaming.groups.filter((g: any) => g.current === 'near').length,
      far: r.streaming.groups.filter((g: any) => g.current === 'far').length,
    };
  });
  assert.ok(beforeGameFar.near > 0 && beforeGameFar.far > 0);
  const info = await fetch(app.url + '/api/world').then((r) => r.json()),
    manifestUrl = new URL(info.manifestUrl, app.url);
  const manifest: WorldManifest = await fetch(manifestUrl).then((r) => r.json());
  const farIds = new Set(
    await owner.evaluate(() =>
      (window as any).__SU_DEBUG__
        .report()
        .streaming.groups.filter((g: any) => g.current === 'far')
        .map((g: any) => g.id),
    ),
  );
  const logicalBuildings = [];
  for (const group of manifest.graphics!.groups.filter((g) => farIds.has(g.groupId))) {
    const cell = manifest.cells.find((c) => c.cellId === group.ownerCellId)!;
    const body = await fetch(new URL(cell.file, manifestUrl)).then((r) => r.json());
    const members = new Set(group.memberIds);
    for (const b of body.buildings)
      if (members.has(b.entityId) && b.assetId.startsWith('osm-way-'))
        logicalBuildings.push({
          ...b,
          bounds: buildingBounds(b, manifest.assets[b.assetId].bounds),
        });
  }
  await owner.bringToFront();
  await openChat(owner);
  await owner.locator('#chat-input').fill('/vilievna');
  await owner.locator('#chat-send:not([disabled])').click();
  await owner.locator('#static-removal').waitFor({ state: 'visible' });
  const candidates: Array<{
    entityId: string;
    assetId: string;
    bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  }> = await owner.evaluate((logicalBuildings) => {
    const debug = (window as any).__SU_DEBUG__;
    const position = debug.snapshot().authoritative.position;
    return logicalBuildings.sort(
      (a: any, b: any) =>
        Math.hypot(a.position.x - position.x, a.position.z - position.z) -
        Math.hypot(b.position.x - position.x, b.position.z - position.z),
    );
  }, logicalBuildings);
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
      if (!point.visible || point.y < 130 || point.y > viewport.height - 60) continue;
      await owner.mouse.move(point.x, point.y);
      await owner
        .waitForFunction(
          (id) => (window as any).__SU_DEBUG__.removal().hovered === id,
          candidate.entityId,
          { timeout: 5000, polling: 100 },
        )
        .catch(() => {});
      const hovered = await owner.evaluate(() => (window as any).__SU_DEBUG__.removal().hovered);
      console.log('Far hover', candidate.entityId, hovered);
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
  const chosenGroup = manifest.graphics!.groups.find((g) => g.memberIds.includes(chosen.entityId))!;
  assert.ok(farIds.has(chosenGroup.groupId), 'selection starts from an unloaded far owner');
  await owner.mouse.move(40, 90);
  await owner.waitForTimeout(700);
  assert.equal(
    await owner.evaluate(() => (window as any).__SU_DEBUG__.removal().selected),
    chosen.entityId,
  );
  assert.equal(
    await owner.evaluate(
      (id) =>
        (window as any).__SU_DEBUG__.report().streaming.groups.find((g: any) => g.id === id)
          ?.current,
      chosenGroup.groupId,
    ),
    'near',
    'selection stays pinned while moving to confirmation',
  );
  await owner.screenshot({ path: `${output}/selected-building.png` });
  const before = await owner.evaluate(() => (window as any).__SU_DEBUG__.snapshot().publication);
  const beforeBodies = app.room.diagnostics().bodies;
  const started = performance.now();
  await owner.locator('#static-removal-confirm:not([disabled])').click();
  await owner.locator('#static-removal').waitFor({ state: 'hidden' });
  for (const page of [owner, observer]) {
    await page.waitForFunction(
      (mapVersion) => {
        const s = (window as any).__SU_DEBUG__.snapshot();
        return s.connection === 'playing' && s.publication.mapVersion !== mapVersion;
      },
      before.mapVersion,
      { timeout: 60000 },
    );
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
  const serverMetrics = app.room.diagnostics().staticPlacement!;
  assert.ok(
    serverMetrics.pauseMs !== undefined && serverMetrics.pauseMs <= 250,
    `Live commit pause exceeds the existing 250 ms maximum: ${serverMetrics.pauseMs}`,
  );
  await owner.screenshot({ path: `${output}/after-removal.png` });
  const result = {
    entityId: chosen.entityId,
    assetId: chosen.assetId,
    elapsedMs,
    beforeGameFar,
    server: app.room.diagnostics().staticPlacement,
    errors,
  };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await mkdir(output, { recursive: true });
  await writeFile(
    `${output}/failure-server.json`,
    JSON.stringify(app?.room.diagnostics(), null, 2),
  );
  let failedPage = 0;
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) {
      console.error(
        'City UI notice',
        await page
          .locator('#notice')
          .innerText()
          .catch(() => ''),
      );
      await writeFile(
        `${output}/failure-${failedPage++}.json`,
        JSON.stringify(
          await page.evaluate(() => (window as any).__SU_DEBUG__?.report()).catch(() => null),
          null,
          2,
        ),
      );
      console.error(
        'City failure state',
        await page.evaluate(() => (window as any).__SU_DEBUG__?.snapshot()).catch(() => null),
      );
    }
  console.error('Browser errors', errors);
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
}
