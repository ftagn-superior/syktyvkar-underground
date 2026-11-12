import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGameServer } from '../apps/server/src/index.js';
import { buildStreamingFixture } from './helpers/streaming-world.js';
import { launchTestBrowser } from './helpers/browser.js';

const output = process.env.SU_STREAMING_OUTPUT ?? 'output/large-map/l5/failures';
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'su-streaming-failures-'));
const fixture = await buildStreamingFixture(directory, 'spread');
const app = await createGameServer({
  port: 0,
  worldDirectory: fixture.worldDirectory,
  reconnectSeconds: 2,
});
const browser = await launchTestBrowser();
const errors: string[] = [],
  checks: string[] = [];
const phases: Record<string, unknown> = {};
const snapshot = (page: any): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const contexts = await Promise.all(
  [0, 1].map(() => browser.newContext({ viewport: { width: 960, height: 640 } })),
);
const pages = await Promise.all(
  contexts.map(async (context) => {
    await context.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(app.url + '/?diagnostics=1');
    await page.locator('#join:not([disabled])').waitFor();
    return page;
  }),
);
const [slow, good] = pages;
let release: () => void = () => {};
try {
  let modelRequested = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await slow.route(
    `**/worlds/streaming-lab/${fixture.manifest.assets['house-a'].modelFile}`,
    async (route) => {
      modelRequested = true;
      await gate;
      await route.continue().catch(() => {});
    },
  );
  await slow.locator('#join').click();
  const deadline = performance.now() + 10000;
  while (!modelRequested) {
    assert.ok(performance.now() < deadline, 'GLB never requested');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await good.locator('#join').click();
  await good.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  const before = await snapshot(good);
  await good.keyboard.down('s');
  await good.waitForFunction(
    (origin) => (window as any).__SU_DEBUG__.snapshot().authoritative.position.x - origin > 1,
    before.authoritative.position.x,
  );
  await good.keyboard.up('s');
  phases.loading = app.room.diagnostics();
  assert.equal(app.room.diagnostics().players, 1);
  assert.equal(app.room.diagnostics().preparing, 1);
  await slow.locator('#leave').click();
  release();
  await slow.waitForFunction(
    () => {
      const data = (window as any).__SU_DEBUG__.snapshot();
      return (
        data.connection === 'ready' &&
        (!data.streaming || data.streaming.entities === 0) &&
        data.physics.bodies === 0
      );
    },
    undefined,
    { timeout: 10000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterLeave = await snapshot(slow);
  assert.equal(afterLeave.physics.entities, 0);
  assert.equal(afterLeave.physics.bodies, 0);
  assert.equal(app.room.diagnostics().players, 1);
  assert.equal(app.room.diagnostics().sessions, 1);
  assert.equal(app.room.diagnostics().interest.views, 1);
  phases.afterLeave = afterLeave;
  checks.push(
    'Leaving during a real GLB request releases the seat and all local physics; late completion cannot activate the old session while a second browser keeps moving.',
  );
  console.log('Streaming failure: leave during GLB passed');
  await slow.unrouteAll({ behavior: 'wait' });
  let failing = true,
    requests = 0;
  await slow.route('**/worlds/streaming-lab/cells/**', async (route) => {
    requests++;
    if (failing) await route.fulfill({ status: 503, body: 'temporary test failure' });
    else await route.continue();
  });
  await slow.locator('#join:not([disabled])').click();
  await slow.locator('#area-retry:not([hidden])').waitFor();
  assert.ok(requests > 0);
  assert.equal(app.room.diagnostics().players, 1, 'Failed cell must not create an actor');
  failing = false;
  await slow.locator('#area-retry').click();
  await slow.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  const recovered = await snapshot(slow);
  assert.equal(recovered.physics.entities, recovered.streaming.entities);
  assert.equal(app.room.diagnostics().players, 2);
  assert.ok(requests >= 2);
  phases.recovered = recovered;
  checks.push(
    'A real HTTP 503 remains explicit without spawning; the UI retry prepares the same version and creates exactly one actor.',
  );
  console.log('Streaming failure: HTTP retry passed');
  // Expire the reservation before reconnecting: automatic recovery must become a fresh guest.
  await slow.context().setOffline(true);
  await slow.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
  );
  const expiredId = recovered.authoritative.entityId;
  const expiryDeadline = performance.now() + 15000;
  while (app.room.diagnostics().sessions !== 1) {
    assert.ok(
      performance.now() < expiryDeadline,
      'Server did not detect the drop and expire its reservation',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(app.room.diagnostics().players, 1);
  phases.expired = app.room.diagnostics();
  await slow.context().setOffline(false);
  await slow.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'ready',
    undefined,
    { timeout: 35000 },
  );
  await slow.locator('#join:not([disabled])').click();
  await slow.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  const fresh = await snapshot(slow);
  assert.notEqual(fresh.authoritative.entityId, expiredId);
  assert.equal(app.room.diagnostics().players, 2);
  phases.fresh = fresh;
  checks.push(
    'Expired reconnect reservation releases the old actor; an explicit new entry creates a fresh identity and no duplicate.',
  );
  assert.deepEqual(errors, []);
  await slow.screenshot({ path: join(output, 'recovered.png') });
  for (const page of pages) await page.locator('#leave').click();
  await slow.waitForTimeout(200);
  assert.equal(app.room.diagnostics().players, 0);
  assert.deepEqual(app.room.diagnostics().interest, {
    indexed: 1,
    buckets: 1,
    views: 0,
    memberships: 0,
    additions: app.room.diagnostics().interest.additions,
    removals: app.room.diagnostics().interest.removals,
    updates: app.room.diagnostics().interest.updates,
  });
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        result: 'passed',
        browser: browser.version(),
        protocolVersion: app.room.state.protocolVersion,
        checks,
        errors,
        phases,
        final: app.room.diagnostics(),
      },
      null,
      2,
    ) + '\n',
  );
  await rm(join(output, 'failure.json'), { force: true });
  console.log(JSON.stringify({ result: 'passed', checks }, null, 2));
} catch (error) {
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify(
      {
        error: String(error),
        errors,
        phases,
        states: await Promise.all(pages.map((page) => snapshot(page).catch(() => null))),
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  release();
  await browser.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
