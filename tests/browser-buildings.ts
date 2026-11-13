import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import type { WorldManifest } from '../packages/contracts/src/index.js';
import { buildWorld } from '../tools/world-build/src/index.js';
import { createGameServer } from './helpers/game-server.js';
import { holdCamera, rotateCamera, waitForCamera } from './helpers/camera.js';
import { hudClick, setRenderQuality } from './helpers/hud.js';

// A separate test release changes only placements/spawns; controls still use real keyboard input.
const temporary = await mkdtemp(join(tmpdir(), 'su-buildings-browser-'));
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
const browser = await launchTestBrowser();
const errors: string[] = [];
const checks: string[] = [];
const snapshot = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const buildings = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.buildings());
const report = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.report());
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
try {
  await cp('content', join(temporary, 'content'), { recursive: true });
  const source = join(temporary, 'content/worlds/physics-lab/world.json');
  const world = JSON.parse(await readFile(source, 'utf8'));
  world.spawnPoints[0] = { x: -8, y: 0, z: -18.5 };
  world.spawnPoints[1] = { x: 12, y: 0, z: -14 };
  await writeFile(source, JSON.stringify(world));
  const cellFile = resolve(dirname(source), world.cells[0]);
  const cell = JSON.parse(await readFile(cellFile, 'utf8'));
  const original = cell.buildings.find((item: any) => item.position.x < 0);
  assert.ok(original);
  cell.buildings.push({
    ...original,
    entityId: 'test-house-copy',
    position: { x: -12, y: 0, z: 12 },
  });
  await writeFile(cellFile, JSON.stringify(cell));
  const output = join(temporary, 'release');
  await buildWorld(source, output);
  app = await createGameServer({ port: 0, worldDirectory: output });
  const info = await fetch(`${app.url}/api/world`).then((response) => response.json());
  const manifestUrl = new URL(info.manifestUrl, app.url);
  const manifest: WorldManifest = await fetch(manifestUrl).then((response) => response.json());
  const graphicsFiles = new Set(
    manifest.cells.flatMap(
      (cell) =>
        cell.graphicsPacks ??
        cell.assetIds.flatMap((id) => {
          const file = manifest.assets[id].modelFile;
          return file ? [file] : [];
        }),
    ),
  );
  const expectedGraphics = [...graphicsFiles].map((file) => new URL(file, manifestUrl).href).sort();
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 800 } })),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const graphicsRequests: string[][] = [[], []];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/\.(glb|pack)$/.test(request.url())) graphicsRequests[i].push(request.url());
    });
    await page.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
    await page.goto(`${app.url}/?diagnostics=1`);
    await page.locator('#join:not([disabled])').waitFor({ timeout: 30_000 });
    await page.locator('#join').click();
    await page.waitForFunction(
      () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
    );
  }
  await mkdir('output/playwright/buildings', { recursive: true });
  for (let i = 0; i < pages.length; i++) {
    const data = await buildings(pages[i]);
    assert.equal(data.buildings.length, 3);
    assert.equal(data.assets.length, 2);
    assert.equal(
      data.assets.reduce((sum: number, asset: any) => sum + asset.loads, 0),
      2,
    );
    assert.deepEqual(
      graphicsRequests[i].sort(),
      expectedGraphics,
      'each published graphics resource is fetched once despite duplicate building instances',
    );
  }
  checks.push('three placed buildings reuse two verified GLB models per client');
  await pages[0].bringToFront();
  await pages[0].waitForFunction(
    (id) =>
      (window as any).__SU_DEBUG__.buildings().buildings.find((b: any) => b.entityId === id)
        ?.opacity < 0.4,
    original.entityId,
  );
  const first = await buildings(pages[0]);
  const second = await buildings(pages[1]);
  assert.ok(first.buildings.find((b: any) => b.entityId === 'test-house-copy').opacity > 0.99);
  assert.ok(second.buildings.find((b: any) => b.entityId === original.entityId).opacity > 0.99);
  await pages[0].screenshot({ path: 'output/playwright/buildings/occluded-economy.png' });
  checks.push(
    'occlusion is local to the player and does not fade another instance of the same asset',
  );
  await setRenderQuality(pages[0], 'standard');
  await pages[0].waitForTimeout(800);
  assert.ok(
    (await buildings(pages[0])).buildings.find((b: any) => b.entityId === original.entityId)
      .opacity < 0.4,
  );
  await pages[0].screenshot({ path: 'output/playwright/buildings/occluded-standard.png' });
  await setRenderQuality(pages[0], 'economy');
  checks.push('both quality profiles retain the same occlusion behavior');

  // Camera moves without changing the authoritative position, and completes a full circuit.
  const stationary = (await snapshot(pages[0])).authoritative.position;
  const initialAngle = (await report(pages[0])).rendering.camera.azimuth;
  for (const key of ['q', 'e'] as const) {
    const before = (await report(pages[0])).rendering.camera.azimuth;
    await holdCamera(pages[0], key, 230);
    const after = (await report(pages[0])).rendering.camera.azimuth;
    const change = angleDelta(after, before);
    assert.ok(change * (key === 'e' ? 1 : -1) > 0.03);
    assert.ok(Math.abs(change) < 0.8, 'a short hold stops before a quarter turn');
  }
  await rotateCamera(
    pages[0],
    angleDelta(initialAngle, (await report(pages[0])).rendering.camera.azimuth),
  );
  assert.ok(
    Math.abs(angleDelta((await report(pages[0])).rendering.camera.azimuth, initialAngle)) < 0.01,
  );
  checks.push('Q and E rotate while held and settle at arbitrary angles on release');
  await pages[0].keyboard.down('q');
  await pages[0].keyboard.down('e');
  await pages[0].waitForTimeout(350);
  const opposed = (await report(pages[0])).rendering.camera.azimuth;
  await pages[0].waitForTimeout(200);
  assert.ok(
    Math.abs(angleDelta((await report(pages[0])).rendering.camera.azimuth, opposed)) < 0.001,
  );
  await pages[0].keyboard.up('q');
  await pages[0].waitForTimeout(200);
  await pages[0].keyboard.up('e');
  await waitForCamera(pages[0]);
  assert.ok(angleDelta((await report(pages[0])).rendering.camera.azimuth, opposed) > 0.03);
  await rotateCamera(
    pages[0],
    angleDelta(initialAngle, (await report(pages[0])).rendering.camera.azimuth),
  );
  checks.push('opposite rotation keys cancel and releasing one resumes the other direction');
  const fixedCamera = (await report(pages[0])).rendering.camera;
  await pages[0].mouse.move(640, 390);
  await pages[0].mouse.down({ button: 'right' });
  await pages[0].mouse.move(710, 470, { steps: 6 });
  assert.equal(await pages[0].locator('#world.camera-rotating').count(), 1);
  await pages[0].evaluate(() => window.dispatchEvent(new Event('blur')));
  const cancelled = (await report(pages[0])).rendering.camera.azimuth;
  await pages[0].mouse.move(790, 500, { steps: 6 });
  await pages[0].mouse.up({ button: 'right' });
  await pages[0].waitForTimeout(300);
  const afterCancel = (await report(pages[0])).rendering.camera;
  assert.ok(Math.abs(angleDelta(afterCancel.azimuth, cancelled)) < 0.001);
  assert.equal(afterCancel.beta, fixedCamera.beta);
  assert.equal(afterCancel.zoom, fixedCamera.zoom);
  assert.equal(await pages[0].locator('#world.camera-rotating').count(), 0);
  await pages[0].keyboard.down('e');
  await pages[0].waitForTimeout(100);
  await pages[0].evaluate(() => window.dispatchEvent(new Event('blur')));
  await pages[0].keyboard.up('e');
  const blurred = (await report(pages[0])).rendering.camera.azimuth;
  await pages[0].waitForTimeout(300);
  assert.ok(
    Math.abs(angleDelta((await report(pages[0])).rendering.camera.azimuth, blurred)) < 0.001,
  );
  await rotateCamera(
    pages[0],
    angleDelta(initialAngle, (await report(pages[0])).rendering.camera.azimuth),
  );
  checks.push('blur cancels keyboard and captured mouse rotation without changing pitch or zoom');
  let sawOpaque = false;
  for (let i = 0; i < 4; i++) {
    await rotateCamera(pages[0], [0.39, 1.28, 1.73, 2 * Math.PI - 3.4][i]);
    await pages[0].waitForTimeout(600);
    const data = await buildings(pages[0]);
    sawOpaque ||= data.buildings.find((b: any) => b.entityId === original.entityId).opacity > 0.99;
    await pages[0].screenshot({ path: `output/playwright/buildings/view-${i + 1}.png` });
  }
  assert.equal(sawOpaque, true, 'a clear viewing angle restores opaque walls and roof');
  assert.ok(
    Math.abs(angleDelta((await report(pages[0])).rendering.camera.azimuth, initialAngle)) < 0.01,
  );
  const afterRotation = (await snapshot(pages[0])).authoritative.position;
  assert.ok(Math.hypot(afterRotation.x - stationary.x, afterRotation.z - stationary.z) < 0.05);
  checks.push(
    'mouse orbit crosses arbitrary angles and a full circuit without moving the player; clear views restore opacity',
  );

  // The eastern spawn has space to move in every camera direction.
  const page = pages[1];
  await page.bringToFront();
  await page.locator('#world').focus();
  for (let i = 0; i < 4; i++) {
    const before = (await snapshot(page)).authoritative.position;
    const angle = (await report(page)).rendering.camera.azimuth;
    await page.keyboard.down('w');
    await page.waitForFunction(
      (origin) => {
        const p = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
        return Math.hypot(p.x - origin.x, p.z - origin.z) > 0.45;
      },
      before,
      { timeout: 10_000 },
    );
    await page.keyboard.up('w');
    await page.waitForTimeout(300);
    const after = (await snapshot(page)).authoritative.position;
    const dx = after.x - before.x,
      dz = after.z - before.z;
    const length = Math.hypot(dx, dz);
    assert.ok(
      (dx * -Math.cos(angle) + dz * -Math.sin(angle)) / length > 0.95,
      'W follows the current view',
    );
    await rotateCamera(page, 0.61 + i * 0.13);
  }
  checks.push('W movement remains screen-relative at arbitrary camera angles');
  // Walk toward a solid house face using the matching world direction.
  await pages[0].bringToFront();
  await pages[0].locator('#world').focus();
  await pages[0].keyboard.down('s');
  await pages[0].keyboard.down('a');
  await pages[0].waitForTimeout(2500);
  await pages[0].keyboard.up('s');
  await pages[0].keyboard.up('a');
  await pages[0].waitForTimeout(350);
  const blocked = (await snapshot(pages[0])).authoritative.position;
  assert.ok(
    blocked.z > -18.3 && blocked.z < -17.25,
    `opaque physics remains solid behind faded house: z=${blocked.z}`,
  );
  checks.push('faded buildings remain solid in authoritative physics');
  assert.deepEqual(errors, []);
  const result = {
    date: new Date().toISOString(),
    browser: browser.version(),
    result: 'passed',
    checks,
    browserErrors: errors,
    graphicsRequests: graphicsRequests.map((items) => items.length),
    rendering: (await report(page)).rendering,
  };
  await writeFile(
    'output/playwright/buildings/result.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
  for (const page of pages) await hudClick(page, '#leave');
} finally {
  await browser.close();
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
