import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';

// Functional SwiftShader integration evidence, with economy rasterization for the 12-view matrix.
// A standard-quality screenshot also compiles both material families. The 90s background wait
// accommodates software rasterization; the cold critical entry still must fit the 15s plan.
const output = 'output/playwright/dynamic-map';
await mkdir(output, { recursive: true });
const app = await createGameServer({ port: 0, worldDirectory: 'dist/worlds/ring-block' });
const browser = await launchTestBrowser();
const errors: string[] = [];
const phases: unknown[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  await page.goto(app.url + '/?diagnostics=1');
  await page.locator('#join:not([disabled])').waitFor();
  const snapshot = () => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
  assert.equal(app.room.diagnostics().sessions, 0, 'Preview must not reserve a seat');
  assert.equal((await snapshot()).physics.bodies, 0, 'Preview does not create local physics');
  const coldStart = performance.now();
  await page.locator('#join').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
    undefined,
    { timeout: 15_000 },
  );
  phases.push({
    phase: 'cold-critical-entry',
    ms: performance.now() - coldStart,
    snapshot: await snapshot(),
  });
  await page.locator('#leave').click();
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().connection === 'ready');

  await page.waitForFunction(
    () => {
      const debug = (window as any).__SU_DEBUG__;
      return debug?.report().rendering.streaming.shownRadius >= 499;
    },
    undefined,
    { timeout: 90_000 },
  );
  assert.equal(app.room.diagnostics().sessions, 0, 'Preview must not reserve a seat');
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 360, height: 800 },
    { width: 3840, height: 720 },
  ]) {
    await page.setViewportSize(size);
    await page.locator('#world').dispatchEvent('wheel', { deltaY: 10_000 });
    for (let turn = 0; turn < 4; turn++) {
      await page.locator('#world').focus();
      await page.keyboard.press('e');
      await page.waitForFunction(
        () => {
          const r = (window as any).__SU_DEBUG__.report().rendering;
          return (
            !r.camera.turning &&
            r.camera.zoom === 30 &&
            r.streaming.shownRadius >= r.streaming.drawRadius - 1
          );
        },
        undefined,
        { timeout: 90_000 },
      );
      phases.push(await page.evaluate(() => (window as any).__SU_DEBUG__.report().rendering));
    }
    await page.screenshot({ path: `${output}/preview-${size.width}x${size.height}.png` });
    console.log(`Prepared preview at ${size.width}x${size.height}, four views.`);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('#world').dispatchEvent('wheel', { deltaY: -10_000 });
  await page.locator('#join').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
    undefined,
    { timeout: 20_000 },
  );
  const joined = await snapshot();
  assert.ok(joined.streaming.criticalReady);
  assert.equal(app.room.diagnostics().sessions, 1);
  assert.equal(joined.predictionWorlds, 1);
  await page.keyboard.down('w');
  await page.waitForFunction((origin) => {
    const p = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
    return Math.hypot(p.x - origin.x, p.z - origin.z) > 1;
  }, joined.authoritative.position);
  await page.keyboard.up('w');
  await page.locator('#diagnostics-toggle').click();
  await page.locator('#quality').selectOption('standard');
  await page.locator('#diagnostics-toggle').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${output}/playing.png` });
  await page.locator('#diagnostics-toggle').click();
  await page.locator('#quality').selectOption('economy');
  await page.locator('#diagnostics-toggle').click();
  await page.locator('#leave').click();
  await page.waitForFunction(
    () => {
      const debug = (window as any).__SU_DEBUG__,
        s = debug.snapshot();
      return (
        s.connection === 'ready' &&
        s.physics.bodies === 0 &&
        debug.report().rendering.dynamicEntities.length === 0 &&
        debug.report().rendering.streaming.shownRadius >= 499
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  assert.equal(app.room.diagnostics().sessions, 0);
  assert.equal(await page.locator('.player-label').count(), 0);
  assert.equal((await snapshot()).predictionWorlds, 1);
  await page.locator('#join').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  assert.equal((await snapshot()).predictionWorlds, 1, 'Rejoining reuses the local physics world');
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/result.json`,
    JSON.stringify({ result: 'passed', hardwareAcceptance: false, phases, errors }, null, 2),
  );
  console.log('Dynamic city: preview, 30x camera in 12 views, input, leave and rejoin passed.');
} finally {
  await browser.close();
  await app.close();
}
