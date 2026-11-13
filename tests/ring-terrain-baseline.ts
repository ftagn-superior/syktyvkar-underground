/** Hardware reference for terrain stage 0; no room, database or gameplay acceptance. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import type { Browser, Page } from 'playwright';
import { buildWorld } from '../tools/world-build/src/index.js';
import {
  readAuthoringRelease,
  createLayoutPublication,
} from '../apps/server/src/layout/release.js';
import { writeWorldPublication } from '../packages/world-release/src/index.js';
import { validateWorldLayoutSnapshot } from '../packages/contracts/src/index.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { launchTestBrowser } from './helpers/browser.js';

const output = resolve(
  process.env.SU_RING_BASELINE_OUTPUT ?? 'output/ring-terrain-stage0/hardware-baseline',
);
const layoutFile = resolve(process.env.SU_RING_BASELINE_LAYOUT ?? 'data/map-layout.json');
const warmupMs = Number(process.env.SU_RING_BASELINE_WARMUP_MS ?? 60_000);
const sampleMs = Number(process.env.SU_RING_BASELINE_SAMPLE_MS ?? 60_000);
assert.ok(Number.isFinite(warmupMs) && warmupMs >= 60_000);
assert.ok(Number.isFinite(sampleMs) && sampleMs >= 60_000);
const route = [
  [0, 0],
  [-33, -75],
  [-68, -130],
  [-100, -200],
  [-141, -280],
  [-100, -200],
  [-93.0264, -120.1397],
  [-68, -130],
  [-33, -75],
  [0, 0],
];
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const percentile = (values: number[], p: number) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
};
const distribution = (values: number[]) => ({
  count: values.length,
  mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: values.length ? Math.max(...values) : null,
});
await mkdir(output, { recursive: true });
const exportBytes = await readFile(layoutFile);
const snapshot = JSON.parse(exportBytes.toString());
validateWorldLayoutSnapshot(snapshot);
const oldDistHash = sha(await readFile('dist/worlds/ring-block/manifest.json'));
const sourceDirectory = join(output, 'source-world');
const started = performance.now();
await buildWorld('content/worlds/ring-block/world.json', sourceDirectory);
const release = await readAuthoringRelease(sourceDirectory);
const prepared = await createLayoutPublication(release, snapshot);
const directory = join(output, 'export-world');
await writeWorldPublication(prepared.publication, directory);
const preparationMs = performance.now() - started;
const manifest = prepared.publication.manifest;
const wasm = await loadServerWasm();

// Served as a module: Vite resolves the existing application and simulation modules.
// Raw JavaScript avoids injecting tsx helpers into browser functions.
const browserModule = String.raw`
import { loadWorldHeader } from '/packages/contracts/src/index.ts';
import { createPhysicsWorld } from '/packages/simulation/src/physics-world.ts';
import { WorldView } from '/apps/client/src/rendering/world-view.ts';
import { CellStreamer } from '/apps/client/src/streaming/cells.ts';
import { VerifiedResources } from '/apps/client/src/streaming/resources.ts';
const config = await (await fetch('/baseline-config')).json();
const manifest = await (await fetch('/baseline-manifest')).json();
const resources = new VerifiedResources(manifest, '/baseline-assets/');
const header = await loadWorldHeader(manifest, path => resources.read(path));
const wasm = await (await fetch('/baseline-wasm')).arrayBuffer();
const world = await createPhysicsWorld(header, wasm, true);
document.body.style.cssText = 'margin:0;overflow:hidden;background:#101820';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:100vw;height:100vh';
document.body.append(canvas);
const labels = document.createElement('div');
document.body.append(labels);
const view = new WorldView(canvas, labels, header, 'standard');
view.setTimeOfDay(12);
const stream = new CellStreamer(manifest, resources, world, view);
const camera = view.scene.activeCamera;
const spawn = header.spawnPoints[0];
view.target.set(0, 0, 0);
camera.setTarget(view.target, false, false, true);
stream.setArea(spawn);
const fixedDt = 1 / 60;
let accumulator = 0;
let character;
let active;
let motion;
let disposed = false;
let lastDiagnostic = 0;
let tickCount = 0;
const failures = [];
const phase = () => {
  // Avoid retaining the same 4096-operation and HTTP traces on every 250 ms sample.
  const { operations, cells, resources: resourceState, ...streaming } = stream.diagnostics();
  const { http, ...resourceSummary } = resourceState;
  return {
  streaming, resources: resourceSummary,
  rendering: view.renderingDiagnostics(), physics: world.staticDiagnostics(),
  controller: character ? world.state('baseline-controller') : null,
  wasmReservedBytes: world.plugin._hknp.HEAPU8.byteLength,
  jsHeap: performance.memory ? {
    usedJSHeapSize: performance.memory.usedJSHeapSize,
    totalJSHeapSize: performance.memory.totalJSHeapSize,
    jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
  } : null,
  activeIndices: view.scene.getActiveIndices(),
  totalVertices: view.scene.getTotalVertices(), hidden: document.hidden, tickCount,
  };
};
function routeAt(t) {
  const distances = config.route.slice(1).map((p, i) => Math.hypot(p[0] - config.route[i][0], p[1] - config.route[i][1]));
  let distance = Math.min(1, Math.max(0, t)) * distances.reduce((a, b) => a + b, 0);
  for (let i = 0; i < distances.length; i++) {
    if (distance <= distances[i] || i === distances.length - 1) {
      const f = Math.min(1, distance / distances[i]);
      return { x: config.route[i][0] + (config.route[i + 1][0] - config.route[i][0]) * f,
        z: config.route[i][1] + (config.route[i + 1][1] - config.route[i][1]) * f };
    }
    distance -= distances[i];
  }
}
view.onFrame((now, delta) => {
  if (disposed) return;
  if (motion) {
    const center = routeAt((now - motion.started) / motion.duration);
    view.target.set(center.x, 0, center.z);
  }
  const area = view.graphicalArea();
  stream.setVisualArea(area.center, area.drawRadius);
  stream.pump();
  view.setStreamingRadius(stream.graphicsReadyRadius(area.center, area.drawRadius));
  if (character) {
    accumulator += delta;
    let frameTicks = 0;
    while (accumulator >= fixedDt && frameTicks < 120) {
      const start = performance.now();
      world.advance(fixedDt);
      const elapsed = performance.now() - start;
      if (active) active.physicsStepMs.push(elapsed);
      accumulator -= fixedDt;
      tickCount++;
      frameTicks++;
    }
    if (accumulator >= fixedDt) failures.push('Physics backlog exceeds 120 ticks');
  }
  if (active) {
    active.framesMs.push(delta * 1000);
    active.hidden ||= document.hidden;
    if (now - lastDiagnostic >= 250) {
      const diagnostic = phase();
      active.diagnostics.push({ elapsedMs: now - active.started, ...diagnostic });
      lastDiagnostic = now;
    }
    if (stream.backgroundProblem) failures.push(stream.backgroundProblem);
  }
});
let renderStart;
view.scene.onBeforeRenderObservable.add(() => { renderStart = performance.now(); });
view.scene.onAfterRenderObservable.add(() => {
  if (active && renderStart !== undefined) active.sceneRenderCpuMs.push(performance.now() - renderStart);
});
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitReady() {
  const start = performance.now();
  while (!stream.criticalReady || !stream.backgroundReady) {
    if (stream.backgroundProblem) throw new Error(stream.backgroundProblem);
    if (performance.now() - start > 120000) throw new Error('Streaming preparation timed out');
    await nextFrame();
  }
}
await waitReady();
const position = world.findSpawn(undefined, spawn);
if (!position) throw new Error('Baseline spawn has no safe support');
character = world.createCharacter('baseline-controller', position);
// One neutral controller exercises the real local fixed-step implementation.
// The route moves the overview camera only; it does not claim walkability.
await nextFrame();
window.__RING_BASELINE__ = {
  snapshot: phase,
  async warmup() {
    const started = performance.now();
    await delay(config.warmupMs);
    await waitReady();
    return { elapsedMs: performance.now() - started, state: phase() };
  },
  async sample(kind) {
    const before = phase();
    const started = performance.now();
    const bucket = { started, framesMs: [], physicsStepMs: [], sceneRenderCpuMs: [], diagnostics: [], hidden: false };
    if (kind === 'camera-route') motion = { started, duration: config.sampleMs };
    active = bucket;
    await delay(config.sampleMs);
    active = undefined;
    motion = undefined;
    return { kind, elapsedMs: performance.now() - started, before, after: phase(), ...bucket, failures: [...new Set(failures)] };
  },
  async dispose() {
    disposed = true;
    stream.dispose();
    await delay(100);
    const remaining = world.staticDiagnostics();
    world.dispose();
    view.dispose();
    const { http, ...resourceSummary } = resources.diagnostics();
    return { remaining, resources: resourceSummary };
  },
};
`;

const server = await createServer({
  root: process.cwd(),
  configFile: false,
  logLevel: 'error',
  cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'ring-terrain-hardware-baseline',
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          const path = new URL(request.url ?? '/', 'http://localhost').pathname;
          try {
            if (path === '/baseline') {
              response.setHeader('content-type', 'text/html');
              response.end(
                '<!doctype html><title>Ring terrain hardware baseline</title><script type="module" src="/baseline-module.js"></script>',
              );
            } else if (path === '/baseline-module.js') {
              response.setHeader('content-type', 'text/javascript');
              response.end(browserModule);
            } else if (path === '/baseline-config')
              response.end(JSON.stringify({ warmupMs, sampleMs, route }));
            else if (path === '/baseline-manifest') response.end(JSON.stringify(manifest));
            else if (path === '/baseline-wasm') response.end(wasm);
            else if (path.startsWith('/baseline-assets/')) {
              const file = path.slice('/baseline-assets/'.length);
              if (!Object.hasOwn(manifest.files, file)) {
                response.statusCode = 404;
                response.end();
                return;
              }
              response.end(await readFile(join(directory, file)));
            } else next();
          } catch {
            response.statusCode = 500;
            response.end('Local fixture resource failed');
          }
        });
      },
    },
  ],
});
let browser: Browser | undefined;
let page: Page | undefined;
const errors: string[] = [];
const report: Record<string, any> = {
  date: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scope:
    'Real WorldView, CellStreamer and browser Havok over the current exported static layout. Stationary local neutral controller, no visible avatars or items, no room/network/database. Camera route is not a verified walking route. Not full city gameplay acceptance.',
  host: {
    platform: platform(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    node: process.version,
  },
  viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  quality: 'standard',
  fixedHour: 12,
  warmupMs,
  sampleMs,
  route,
  routeDescription:
    'Ring → Oktyabrsky landmarks → pilot edge → entrance approach → ring; camera only',
  preparationMs,
  mapVersion: manifest.mapVersion,
  assetReleaseVersion: snapshot.assetReleaseVersion,
  layoutHash: prepared.hash,
  layoutRevision: snapshot.revision,
  layoutSha256: sha(exportBytes),
  world: {
    cells: manifest.cells.length,
    assets: Object.keys(manifest.assets).length,
    buildings: prepared.world.buildings.length,
  },
  nominalFrameBudgetMs: 1000 / 60,
  strictFrameP95BudgetMs: 16.7,
  existingFrameP95BudgetMs: 20,
  fullGameplayAcceptance: { assessed: false, passed: false },
  instrumentation:
    'Visible-frame intervals from the production render-loop hook; Scene.render CPU wall time excludes asynchronous GPU completion. Fixed PhysicsWorld.advance(1/60) measured per tick. Diagnostics sampled every 250 ms. Vite module harness, production classes, no physics/network scheduling claims.',
  phases: [],
  errors,
};
try {
  await server.listen();
  browser = await launchTestBrowser({ renderer: 'default', channel: 'chromium' });
  report.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0] + 'baseline');
  await page.waitForFunction(() => !!(window as any).__RING_BASELINE__, undefined, {
    timeout: 180_000,
  });
  report.initial = await page.evaluate(() => (window as any).__RING_BASELINE__.snapshot());
  const renderer = report.initial.rendering.renderer;
  assert.match(JSON.stringify(renderer), /Apple M3 Pro/i, 'actual target Metal GPU is required');
  assert.doesNotMatch(JSON.stringify(renderer), /SwiftShader|llvmpipe|software/i);
  assert.deepEqual(report.initial.rendering.renderSize, { width: 1920, height: 1080 });
  assert.equal(report.initial.rendering.quality, 'standard');
  console.log(JSON.stringify({ phase: 'warmup', renderer, durationMs: warmupMs }));
  report.warmup = await page.evaluate(() => (window as any).__RING_BASELINE__.warmup());
  for (const kind of ['steady-ring', 'camera-route']) {
    console.log(JSON.stringify({ phase: kind, durationMs: sampleMs }));
    const raw: any = await page.evaluate(
      (kind) => (window as any).__RING_BASELINE__.sample(kind),
      kind,
    );
    assert.ok(raw.elapsedMs >= sampleMs && raw.framesMs.length >= 100);
    assert.equal(raw.hidden, false, 'measurement remained visible');
    assert.deepEqual(raw.failures, []);
    if (kind === 'steady-ring') {
      assert.equal(raw.before.streaming.backgroundReady, true);
      assert.equal(raw.after.streaming.backgroundReady, true);
      for (const state of raw.diagnostics)
        assert.deepEqual(state.streaming.graphicsActive, raw.before.streaming.graphicsActive);
    }
    const summary = {
      kind,
      elapsedMs: raw.elapsedMs,
      frameMs: distribution(raw.framesMs),
      averageFps:
        (raw.framesMs.length * 1000) / raw.framesMs.reduce((a: number, b: number) => a + b, 0),
      sceneRenderCpuMs: distribution(raw.sceneRenderCpuMs),
      physicsStepMs: distribution(raw.physicsStepMs),
      drawCalls: distribution(raw.diagnostics.map((x: any) => x.rendering.drawCalls)),
      framesAboveNominalBudget: raw.framesMs.filter((x: number) => x > 1000 / 60).length,
      framesAbove20Ms: raw.framesMs.filter((x: number) => x > 20).length,
      p95Within16_7Ms: (percentile(raw.framesMs, 0.95) ?? Infinity) <= 16.7,
      p95Within20Ms: (percentile(raw.framesMs, 0.95) ?? Infinity) <= 20,
    };
    report.phases.push({ summary, ...raw });
    console.log(JSON.stringify(summary));
    await page.screenshot({ path: join(output, kind + '.png') });
  }
  report.cleanup = await page.evaluate(() => (window as any).__RING_BASELINE__.dispose());
  assert.equal(report.cleanup.remaining.entities, 0);
  assert.equal(report.cleanup.resources.cacheBytes, 0);
  assert.deepEqual(errors, []);
  report.gates = {
    strictFrameP95Passed: report.phases.every((phase: any) => phase.summary.p95Within16_7Ms),
    existingFrameP95Passed: report.phases.every((phase: any) => phase.summary.p95Within20Ms),
    fullGameplayAssessed: false,
    fullGameplayPassed: false,
  };
  report.status = 'measured';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error);
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server.close();
  report.unchanged = {
    layout: sha(await readFile(layoutFile)) === sha(exportBytes),
    oldDistManifest: sha(await readFile('dist/worlds/ring-block/manifest.json')) === oldDistHash,
  };
  report.benchmarkSha256 = sha(await readFile('tests/ring-terrain-baseline.ts'));
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Hardware reference saved: ${join(output, 'result.json')}`);
}
