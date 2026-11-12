import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';

// A fresh browser/server/database fixture for one comparable entry, without the full camera matrix.
const directory = resolve(process.env.SU_STATIC_WORLD_DIRECTORY ?? 'dist/worlds/ring-block');
const label = process.env.SU_STATIC_LABEL ?? 'after-cold';
const output = resolve('output/static-extraction', label);
await mkdir(output, { recursive: true });
assert.ok(
  process.env.SU_TEST_DATABASE_URL,
  'Cold entry evidence requires an explicit test database',
);
const app = await createGameServer({ port: 0, worldDirectory: directory });
const browser = await launchTestBrowser();
const errors: string[] = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  await page.goto(app.url + '/?diagnostics=1');
  await page.locator('#join:not([disabled])').waitFor();
  const before = await page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
  assert.equal(before.physics.bodies, 0);
  assert.equal(app.room.diagnostics().sessions, 0);
  const started = performance.now();
  await page.locator('#join').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
    undefined,
    { timeout: 15000 },
  );
  const criticalMs = performance.now() - started;
  const snapshot = await page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
  const rendering = await page.evaluate(() => (window as any).__SU_DEBUG__.report().rendering);
  assert.equal(snapshot.streaming.criticalReady, true);
  let respawnEvidence: unknown;
  if (label.startsWith('after')) {
    const origin = snapshot.authoritative.position;
    await page.locator('#world').focus();
    await page.keyboard.down('w');
    await page.waitForFunction(
      (start) => {
        const position = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
        return Math.hypot(position.x - start.x, position.z - start.z) > 1;
      },
      origin,
      { timeout: 10000 },
    );
    await page.keyboard.up('w');
    const moved = await page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
    await page.locator('#respawn:not([disabled])').waitFor();
    await page.locator('#respawn').click();
    await page.waitForFunction(
      (revision) => {
        const state = (window as any).__SU_DEBUG__.snapshot();
        return (
          state.connection === 'playing' &&
          state.streaming.criticalReady &&
          state.authoritative.revision > revision
        );
      },
      moved.authoritative.revision,
      { timeout: 15000 },
    );
    const returned = await page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
    const identity = returned.authoritative.entityId;
    await page.reload();
    await page.waitForFunction(
      () => {
        const state = (window as any).__SU_DEBUG__?.snapshot();
        return state?.connection === 'playing' && state.streaming.criticalReady;
      },
      undefined,
      { timeout: 15000 },
    );
    const reloaded = await page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
    assert.equal(reloaded.authoritative.entityId, identity, 'Reload restores the same player');
    await page.locator('#leave').click();
    await page.waitForFunction(
      () => {
        const state = (window as any).__SU_DEBUG__.snapshot();
        return state.connection === 'ready' && state.physics.bodies === 0;
      },
      undefined,
      { timeout: 15000 },
    );
    const preview = await page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
    assert.equal(app.room.diagnostics().sessions, 0);
    respawnEvidence = {
      origin,
      moved: moved.authoritative,
      respawn: returned,
      reloadReconnect: reloaded,
      leavePreview: preview,
    };
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        source: directory,
        mapVersion: snapshot.mapVersion,
        simulationConfigHash: snapshot.simulationConfigHash,
        browser: browser.version(),
        viewport: { width: 1920, height: 1080 },
        renderer: rendering.renderer,
        quality: 'economy',
        hardwareAcceptance: false,
        definition:
          'Fresh browser context and temporary database schema. Measure click on enabled join through playing/criticalReady. Preview prefetch before click is part of both identical scenarios; not a total navigation or compressed-transfer measurement.',
        criticalMs,
        respawnEvidence,
        snapshot,
        rendering,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({ label, status: 'passed', mapVersion: snapshot.mapVersion, criticalMs }),
  );
} finally {
  await browser.close();
  await app.close();
}
