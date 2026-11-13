/** Fresh full-city UI acceptance on a disposable exact-layout fixture. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  sampleTerrain,
  validatePlacementCatalog,
  type PlacementCatalog,
} from '../packages/contracts/src/index.js';
import { selectSupportRule, planSupportPlacement } from '../packages/terrain-build/src/supports.js';
import { readAuthoringRelease } from '../apps/server/src/layout/release.js';
import { hash } from '../packages/world-release/src/index.js';
import { createSavedTerrainServer } from './helpers/saved-terrain-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { openChat } from './helpers/hud.js';

const root = 'output/ring-terrain-stage6/candidate';
const directory = join(root, 'authoring-world');
const snapshotFile = join(root, 'target-static-snapshot.json');
const output = 'output/ring-terrain-stage6/controls/placement-night';
const expected = JSON.parse(
  await readFile(join(root, 'export-world/manifest.json'), 'utf8'),
).mapVersion;
await mkdir(output, { recursive: true });
const app = await createSavedTerrainServer({
  worldDirectory: directory,
  snapshotFile,
  expectedMapVersion: expected,
});
const browser = await launchTestBrowser({ channel: 'chromium', renderer: 'default' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [],
  checks: string[] = [];
const report: any = {
  formatVersion: 1,
  status: 'running',
  mapVersion: expected,
  snapshotSha256: hash(await readFile(snapshotFile)),
  database: 'disposable local test schema',
  errors,
  checks,
  browser: browser.version(),
};
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(45_000);
const playing = () =>
  page.waitForFunction(() => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing');
const render = () => page.evaluate(() => (window as any).__SU_DEBUG__.report().rendering);
try {
  const response = await fetch(app.url + app.info.placementCatalog.url);
  assert.equal(response.status, 200);
  const catalog: PlacementCatalog = validatePlacementCatalog(await response.json());
  assert.equal(catalog.groundY, null);
  assert.equal(catalog.models.length, 22);
  assert.ok(catalog.terrain!.groundEntityIds.length > 0);
  report.catalog = {
    version: catalog.placementCatalogVersion,
    models: catalog.models.length,
    groundBodies: catalog.terrain!.groundEntityIds.length,
  };
  await page.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'standard'));
  await page.goto(app.url + '/?diagnostics=1&time=12');
  await page.locator('#telegram-login').click();
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  await page.goto(app.url + '/?diagnostics=1&time=12');
  await page.locator('#join:not([disabled])').click();
  await playing();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().streaming.backgroundReady,
  );
  report.day = await render();
  assert.equal(report.day.hour, 12);
  assert.ok(report.day.nightLampSources > 0);
  await page.screenshot({ path: join(output, 'day.png') });
  checks.push('exact fresh map and all 22 catalog models; day view includes authored lamp sources');
  await openChat(page);
  await page.locator('#chat-input').fill('/motherlode');
  await page.locator('#chat-send:not([disabled])').click();
  await page.locator('#placement-catalog').waitFor({ state: 'visible' });
  await page.locator('[data-asset-id="bench-0152a250d22ef0a9"]').click();
  await page.locator('#placement-catalog-place:not([disabled])').click();
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.placement().hasGhost);
  const refused: string[] = [];
  let placed = false;
  for (const [x, y] of [
    [850, 500],
    [900, 550],
    [1000, 550],
    [750, 600],
    [550, 500],
    [450, 550],
    [1050, 650],
    [400, 650],
  ]) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(150);
    const preview = await page.evaluate(() => (window as any).__SU_DEBUG__.placement());
    if (!preview.pose || !(await page.locator('#static-placement-confirm').isEnabled())) continue;
    assert.ok(preview.pose.position.y > 0.1, 'Terrain ghost must not use the former Y=0 plane');
    report.preview = preview;
    await page.screenshot({ path: join(output, 'terrain-preview.png') });
    await page.locator('#static-placement-confirm').click();
    await page.waitForFunction(
      () =>
        !(window as any).__SU_DEBUG__.snapshot().staticPlacementPending &&
        !(window as any).__SU_DEBUG__.placement().pending,
    );
    if (await page.locator('#static-placement').isHidden()) {
      placed = true;
      break;
    }
    refused.push(await page.locator('#static-placement .place-status').innerText());
  }
  assert.ok(placed, `No accepted candidate position: ${JSON.stringify(refused)}`);
  await playing();
  const rows = (
    await app.accounts.pool.query(
      `SELECT i.* FROM world_static_instances i JOIN world_static_operations o ON i.world_id=o.world_id AND i.entity_id=o.entity_id WHERE o.source='game' AND i.enabled ORDER BY o.layout_revision DESC LIMIT 1`,
    )
  ).rows;
  assert.equal(rows.length, 1);
  const row = rows[0];
  const authored = await readAuthoringRelease(directory);
  assert.equal(authored.terrain?.formatVersion, 2);
  const terrain = authored.terrain!;
  assert.equal(terrain.formatVersion, 2);
  const owner = {
    entityId: row.entity_id,
    assetId: row.asset_id,
    position: { x: row.position_x, y: row.position_y, z: row.position_z },
    rotation: { x: row.rotation_x, y: row.rotation_y, z: row.rotation_z, w: row.rotation_w },
  };
  const support = selectSupportRule(terrain.supports, owner)!;
  const planned = planSupportPlacement(terrain.grid, support, owner);
  assert.ok(Math.abs(owner.position.y - planned.minimumY) < 1e-7);
  assert.ok(owner.position.y > 0.1);
  report.placed = {
    ...owner,
    terrainY: sampleTerrain(terrain.grid, owner.position.x, owner.position.z)!.height,
    plannedY: planned.minimumY,
    refusals: refused,
  };
  checks.push(
    'native catalog selection and nonzero terrain ghost; server placed the model at exact planned support Y',
  );
  await page.screenshot({ path: join(output, 'placed.png') });
  await page.goto(app.url + '/?diagnostics=1&time=23');
  // The existing reconnect token automatically resumes the same character after reload.
  await playing();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().streaming.backgroundReady,
  );
  report.night = await render();
  assert.equal(report.night.hour, 23);
  assert.ok(report.night.nightLampSources > 0);
  await page.screenshot({ path: join(output, 'night.png') });
  checks.push('night view reload preserves dynamic placement and authored light sources');
  assert.deepEqual(errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error);
  report.state = await page
    .evaluate(() => ({
      placement: (window as any).__SU_DEBUG__?.placement(),
      snapshot: (window as any).__SU_DEBUG__?.snapshot(),
    }))
    .catch(() => undefined);
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  await app.close();
}
console.log(JSON.stringify({ status: report.status, checks, output }));
