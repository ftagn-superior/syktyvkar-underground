import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { buildWorld } from '../tools/world-build/src/index.js';
import { createGameServer } from './helpers/game-server.js';

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
async function turn(page: Page, key: 'q' | 'e') {
  await page.keyboard.press(key);
  await page.waitForFunction(() => !(window as any).__SU_DEBUG__.report().rendering.camera.turning);
}
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
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 800 } })),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const glbRequests: string[][] = [[], []];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().endsWith('.glb')) glbRequests[i].push(request.url());
    });
    await page.goto(`${app.url}/?diagnostics=1`);
    await page.locator('#join:not([disabled])').waitFor({ timeout: 30_000 });
    await page.locator('#diagnostics-toggle').click();
    await page.locator('#quality').selectOption('economy');
    await page.locator('#diagnostics-toggle').click();
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
    assert.equal(glbRequests[i].length, 2, 'one GLB fetch per model despite duplicate instances');
  }
  checks.push('three placed buildings reuse two verified GLB models per client');
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
  await pages[0].locator('#diagnostics-toggle').click();
  await pages[0].locator('#quality').selectOption('standard');
  await pages[0].locator('#diagnostics-toggle').click();
  await pages[0].waitForTimeout(800);
  assert.ok(
    (await buildings(pages[0])).buildings.find((b: any) => b.entityId === original.entityId)
      .opacity < 0.4,
  );
  await pages[0].screenshot({ path: 'output/playwright/buildings/occluded-standard.png' });
  await pages[0].locator('#diagnostics-toggle').click();
  await pages[0].locator('#quality').selectOption('economy');
  await pages[0].locator('#diagnostics-toggle').click();
  checks.push('both quality profiles retain the same occlusion behavior');

  // Camera moves without changing the authoritative position, and completes a full circuit.
  const stationary = (await snapshot(pages[0])).authoritative.position;
  const initialAngle = (await report(pages[0])).rendering.camera.azimuth;
  for (const selector of ['#camera-left', '#camera-right']) {
    const before = (await report(pages[0])).rendering.camera.azimuth;
    await pages[0].locator(selector).click();
    await pages[0].waitForFunction(
      () => !(window as any).__SU_DEBUG__.report().rendering.camera.turning,
    );
    const after = (await report(pages[0])).rendering.camera.azimuth;
    assert.ok(Math.abs(Math.abs(angleDelta(after, before)) - Math.PI / 2) < 0.01);
  }
  assert.ok(
    Math.abs(angleDelta((await report(pages[0])).rendering.camera.azimuth, initialAngle)) < 0.01,
  );
  checks.push('both visible camera buttons rotate by a quarter turn');
  let sawOpaque = false;
  for (let i = 0; i < 4; i++) {
    await turn(pages[0], 'e');
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
    'four camera turns preserve position and restore opaque geometry when the view clears',
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
    await turn(page, 'e');
  }
  checks.push('W movement remains screen-relative at all four camera angles');
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
    glbRequests: glbRequests.map((items) => items.length),
    rendering: (await report(page)).rendering,
  };
  await writeFile(
    'output/playwright/buildings/result.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
  for (const page of pages) await page.locator('#leave').click();
} finally {
  await browser.close();
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
