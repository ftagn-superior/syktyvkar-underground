/** Single hardware-rendered client on the explicitly restored local production database. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Page } from 'playwright';
import { createDatabasePool } from '../apps/server/src/database.js';
import { createGameServer } from '../apps/server/src/index.js';
import { launchTestBrowser } from './helpers/browser.js';
const databaseUrl = process.env.SU_REHEARSAL_DATABASE_URL;
assert.ok(databaseUrl);
const database = new URL(databaseUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.equal(database.pathname, '/terrain_production_rehearsal');
const candidate = resolve(process.argv[2] ?? 'output/ring-terrain-stage6/candidate');
const output = resolve(process.argv[3] ?? 'output/ring-terrain-stage6/live-profile');
process.umask(0o077);
await mkdir(output, { recursive: true, mode: 0o700 });
const report: any = {
  formatVersion: 1,
  status: 'running',
  scope: 'single live network client on migrated full production copy',
  viewport: { width: 1920, height: 1080 },
  quality: 'standard',
  hour: 12,
  network: 'direct loopback',
  measurement:
    'Native application frame intervals; lightweight pose polling; no full scene diagnostic polling during samples',
  warmupMs: 60000,
  criteria: { meanFpsMinimum: 59, frameP95MaximumMs: 20, peaksReportedSeparately: true },
  errors: [],
  phases: [],
};
const save = (name: string, data: unknown) =>
  writeFile(join(output, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const snapshot = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.motion());
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0;
const held = new Map<Page, string[]>();
async function keys(page: Page, next: string[]) {
  for (const key of held.get(page) ?? []) if (!next.includes(key)) await page.keyboard.up(key);
  for (const key of next) if (!(held.get(page) ?? []).includes(key)) await page.keyboard.down(key);
  held.set(page, next);
}
async function navigate(page: Page, point: [number, number], sprint: boolean) {
  const first = (await snapshot(page)).predicted.position;
  const length = Math.hypot(point[0] - first.x, point[1] - first.z);
  const segments = Math.max(1, Math.ceil(length));
  let waypoint = 1;
  const deadline =
    Date.now() + Math.max(25000, Math.hypot(point[0] - first.x, point[1] - first.z) * 900);
  while (Date.now() < deadline) {
    const state = await snapshot(page);
    if (state.connection === 'waiting') {
      await keys(page, []);
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__.motion().connection === 'playing',
        undefined,
        { timeout: 20000 },
      );
      continue;
    }
    assert.equal(state.connection, 'playing');
    const position = state.predicted?.position;
    assert.ok(position, 'Predicted character position is available');
    const along =
      length > 0
        ? ((position.x - first.x) * (point[0] - first.x) +
            (position.z - first.z) * (point[1] - first.z)) /
          length
        : 0;
    const lateral =
      length > 0
        ? Math.abs(
            (position.x - first.x) * (point[1] - first.z) -
              (position.z - first.z) * (point[0] - first.x),
          ) / length
        : 0;
    // At 14m/s a fixed step can pass a small intermediate target without landing
    // inside its radius. Crossing its plane advances the same straight segment.
    if (waypoint < segments && along >= (length * waypoint) / segments - 0.15 && lateral <= 0.6) {
      waypoint++;
      continue;
    }
    const targetX = first.x + ((point[0] - first.x) * waypoint) / segments;
    const targetZ = first.z + ((point[1] - first.z) * waypoint) / segments;
    const dx = targetX - position.x,
      dz = targetZ - position.z;
    if (Math.hypot(dx, dz) < 0.35) {
      if (waypoint < segments) {
        waypoint++;
        continue;
      }
      await keys(page, []);
      await delay(300);
      return (await snapshot(page)).authoritative.position;
    }
    const next =
      Math.abs(dx) > Math.abs(dz)
        ? dx > 0
          ? ['d', 's']
          : ['w', 'a']
        : dz > 0
          ? ['a', 's']
          : ['w', 'd'];
    if (sprint && Math.hypot(point[0] - position.x, point[1] - position.z) > 3) next.push('Shift');
    await keys(page, next);
    await delay(45);
  }
  await keys(page, []);
  throw new Error(
    `City route stuck at ${point}: ${JSON.stringify((await snapshot(page)).predicted)}`,
  );
}

const pool = createDatabasePool(databaseUrl);
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
try {
  app = await createGameServer({
    pool,
    port: 0,
    host: '127.0.0.1',
    worldDirectory: join(candidate, 'authoring-world'),
    modelCatalogDirectory: join(candidate, 'authoring-world/model-catalog'),
    clientDirectory: 'dist/client',
    testDiagnostics: true,
    itemCreationEnabled: false,
  });
  app.room.state.dayFrozenHour = 12;
  report.world = await (await fetch(app.url + '/api/world')).json();
  report.realWorldItems = app.room.state.items.size;
  assert.equal(report.realWorldItems, 4);
  browser = await launchTestBrowser({
    renderer: 'default',
    channel: 'chromium',
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: report.viewport });
  await context.addInitScript(
    'globalThis.__name = (value) => value; localStorage.setItem("su:render-quality:v1", "standard");',
  );
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.goto(app.url + '/?diagnostics=1');
  await page.locator('#join:not([disabled])').waitFor();
  const began = Date.now();
  await page.locator('#join').click();
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.motion().connection === 'playing');
  report.joinMs = Date.now() - began;
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().streaming.backgroundReady,
  );
  await page.locator('#world').focus();
  console.log('[live-profile] Joined; 60-second warmup');
  await delay(60000);
  report.initial = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
  assert.match(
    JSON.stringify(report.initial.rendering.renderer),
    /Apple|Metal|M3/i,
    'Hardware renderer required',
  );
  assert.doesNotMatch(JSON.stringify(report.initial.rendering.renderer), /SwiftShader|llvmpipe/i);
  async function begin() {
    await page.evaluate(() => {
      const debug = (window as any).__SU_DEBUG__;
      const first = debug.frames();
      const probe: any = {
        frames: [],
        samples: [],
        gaps: [],
        hidden: document.hidden,
        started: performance.now(),
      };
      const visibility = () => {
        if (document.hidden) probe.hidden = true;
      };
      document.addEventListener('visibilitychange', visibility);
      let lastSequence = first.firstSequence + first.samples.length - 1;
      const collect = () => {
        const history = debug.frames();
        const end = history.firstSequence + history.samples.length - 1;
        if (history.firstSequence > lastSequence + 1 || end < lastSequence)
          probe.gaps.push({ lastSequence, firstSequence: history.firstSequence, end });
        for (
          let i = Math.max(0, lastSequence + 1 - history.firstSequence);
          i < history.samples.length;
          i++
        )
          probe.frames.push(history.samples[i]);
        lastSequence = end;
        const state = debug.motion();
        probe.samples.push({ at: performance.now(), ...state });
      };
      const timer = setInterval(collect, 250);
      (window as any).__LIVE_PROFILE__ = {
        finish: () => {
          clearInterval(timer);
          document.removeEventListener('visibilitychange', visibility);
          collect();
          return { ...probe, ended: performance.now() };
        },
      };
    });
  }
  async function finish(kind: string) {
    const data = await page.evaluate(() => {
      return (window as any).__LIVE_PROFILE__.finish();
    });
    assert.deepEqual(data.gaps, [], 'Every native frame interval must be collected exactly once');
    const frameMs = data.frames as number[];
    const totalMs = frameMs.reduce((a, b) => a + b, 0),
      meanFps = (1000 * frameMs.length) / (data.ended - data.started),
      p95 = percentile(frameMs, 0.95);
    assert.ok(
      totalMs >= 59000,
      'At least 60 seconds sampled with a one-second scheduling tolerance',
    );
    assert.equal(data.hidden, false, 'The sample remains visible');
    assert.ok(
      Math.abs(totalMs - (data.ended - data.started)) < 100,
      'Native intervals must cover the full wall-clock phase (within boundary frames)',
    );
    const summary = {
      kind,
      clock: 'native WorldView.onFrame performance.now intervals',
      totalMs,
      wallTimeMs: data.ended - data.started,
      frames: frameMs.length,
      meanFps,
      frameP95Ms: p95,
      frameMaxMs: Math.max(...frameMs),
      framesOver33ms: frameMs.filter((v) => v > 33.34).length,
      framesOver50ms: frameMs.filter((v) => v > 50).length,
      performanceAccepted: meanFps >= 59 && p95 <= 20,
      playingSamples: data.samples.filter((s: any) => s.connection === 'playing').length,
      samples: data.samples.length,
    };
    report.phases.push(summary);
    await save(kind + '-samples.json', data);
    assert.equal(
      summary.playingSamples,
      summary.samples,
      'No connection drop during hardware sample',
    );
    console.log(JSON.stringify(summary));
  }
  console.log('[live-profile] 60-second stationary sample');
  await begin();
  await delay(60000);
  await finish('steady');
  console.log('[live-profile] Live walking/sprinting route across cell boundaries');
  await begin();
  const routeStart = Date.now(),
    route: any[] = [];
  for (const [sprint, points] of [
    [
      false,
      [
        [-3, 13],
        [-33, -75],
        [-68, -130],
        [-100, -200],
      ],
    ],
    [
      true,
      [
        [-68, -130],
        [-33, -75],
        [-3, 13],
      ],
    ],
  ] as [boolean, [number, number][]][]) {
    for (const point of points) {
      const reached = await navigate(page, point, sprint);
      route.push({ point, sprint, reached });
      console.log(JSON.stringify({ phase: 'waypoint', point, sprint, reached }));
    }
  }
  if (Date.now() - routeStart < 60000) await delay(60000 - (Date.now() - routeStart));
  await keys(page, []);
  await finish('route');
  report.route = route;
  await page.screenshot({ path: join(output, 'after-route.png') });
  await page.keyboard.press('v');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().view === 'first-person');
  await delay(1000);
  await page.screenshot({ path: join(output, 'first-person.png') });
  report.firstPerson = await page.evaluate(
    () => (window as any).__SU_DEBUG__.report().rendering.camera,
  );
  await page.keyboard.press('v');
  report.final = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
  assert.deepEqual(report.errors, []);
  await browser.close();
  browser = undefined;
  await app.close();
  app = undefined;
  // Real items have now settled and been saved for several minutes. Verify this
  // resulting state, rather than only the initial post-migration poses, restarts.
  app = await createGameServer({
    pool,
    port: 0,
    host: '127.0.0.1',
    worldDirectory: join(candidate, 'authoring-world'),
    modelCatalogDirectory: join(candidate, 'authoring-world/model-catalog'),
    clientDirectory: 'dist/client',
    itemCreationEnabled: false,
  });
  const restarted = await fetch(app.url + '/health/ready');
  assert.equal(restarted.status, 200);
  assert.equal(app.room.state.items.size, report.realWorldItems);
  report.restartAfterLiveSimulation = { readiness: 200, items: app.room.state.items.size };
  report.status = report.phases.every((p: any) => p.performanceAccepted)
    ? 'passed'
    : 'performance-budget-failed';
  if (report.status !== 'passed') process.exitCode = 1;
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app?.close();
  await pool.end();
  await save('report.json', report);
  console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }));
}
