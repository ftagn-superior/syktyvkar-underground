import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { cpus, platform } from 'node:os';
import { build } from 'vite';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  PROTOCOL_VERSION,
  distanceToBoundsXZ,
  type WorldInfo,
  type WorldManifest,
  type WorldHeader,
} from '../packages/contracts/src/index.js';
import { launchTestBrowser } from './helpers/browser.js';

// Production main.ts and renderer, with a local read-only HTTP fixture instead of a room/DB.
// No prototype patches, request interception, CPU throttling or streaming-budget overrides.
const directory = resolve(process.env.SU_PROFILE_WORLD_DIRECTORY ?? 'dist/worlds/ring-block');
const output = resolve(process.env.SU_PROFILE_OUTPUT ?? 'output/playwright/loading-profile');
const quality = process.env.SU_PROFILE_QUALITY ?? 'economy';
const coldRuns = Number(process.env.SU_PROFILE_COLD_RUNS ?? 3);
const timeoutMs = Number(process.env.SU_PROFILE_TIMEOUT_MS ?? 120_000);
const zoom = process.env.SU_PROFILE_ZOOM === '1';
const software = process.env.SU_TEST_RENDERER !== 'hardware';
assert.ok(quality === 'economy' || quality === 'standard');
assert.ok(Number.isInteger(coldRuns) && coldRuns >= 1 && coldRuns <= 5);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300_000);
await mkdir(output, { recursive: true });
const clientDirectory = join(output, 'client');
await build({
  configFile: 'apps/client/vite.config.ts',
  logLevel: 'warn',
  build: { outDir: clientDirectory, emptyOutDir: true },
});
const manifest: WorldManifest = JSON.parse(
  await readFile(join(directory, 'manifest.json'), 'utf8'),
);
const header: WorldHeader = JSON.parse(await readFile(join(directory, manifest.worldFile), 'utf8'));
const previewCenter =
  manifest.bounds.min.x <= 0 &&
  manifest.bounds.max.x >= 0 &&
  manifest.bounds.min.z <= 0 &&
  manifest.bounds.max.z >= 0
    ? { x: 0, y: 0, z: 0 }
    : { ...header.spawnPoints[0], y: 0 };
const worldPath = '/worlds/profile/';
const info: WorldInfo = {
  assetReleaseVersion: 'a'.repeat(64),
  layoutRevision: 1,
  layoutHash: 'b'.repeat(64),
  roomId: 'loading-profile',
  worldEpoch: 'loading-profile',
  protocolVersion: PROTOCOL_VERSION,
  mapVersion: manifest.mapVersion,
  simulationConfigHash: manifest.simulationConfigHash,
  manifestUrl: `${worldPath}manifest.json`,
  maxPlayers: 8,
  available: true,
};
const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
};
let responseDelayMs = 0;
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (responseDelayMs) await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    if (path === '/api/world' || path === '/api/me') {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      response.end(
        JSON.stringify(path === '/api/world' ? info : { enabled: false, account: null }),
      );
      return;
    }
    let file: string;
    if (path.startsWith(worldPath)) {
      const relative = path.slice(worldPath.length);
      if (relative !== 'manifest.json' && !Object.hasOwn(manifest.files, relative)) {
        response.writeHead(404).end();
        return;
      }
      file = resolve(directory, relative);
      if (!file.startsWith(directory + sep)) throw new Error('Invalid world path');
      response.setHeader(
        'Cache-Control',
        relative === 'manifest.json' ? 'no-cache' : 'public, max-age=31536000, immutable',
      );
    } else {
      file = resolve(clientDirectory, '.' + (path === '/' ? '/index.html' : path));
      if (!file.startsWith(clientDirectory + sep)) throw new Error('Invalid client path');
      response.setHeader('Cache-Control', 'public, max-age=0');
    }
    const metadata = await stat(file);
    const etag = `W/"${metadata.size.toString(16)}-${metadata.mtimeMs.toString(16)}"`;
    response.setHeader('ETag', etag);
    response.setHeader('Last-Modified', metadata.mtime.toUTCString());
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304).end();
      return;
    }
    const bytes = await readFile(file);
    response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    response.setHeader('Content-Length', bytes.byteLength);
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  }
});

type RunResult = Awaited<ReturnType<typeof collect>> & {
  label: string;
  responseDelayMs: number;
  errors: string[];
};
const runs: RunResult[] = [];
const zoomPhases: unknown[] = [];
let browser: Browser | undefined;

// Raw browser code avoids tsx's __name helper and samples diagnostics only every 100 ms.
// Marks are observed times since navigation, with 100 ms polling resolution, not exact CPU spans.
const probe = `(() => {
  performance.setResourceTimingBufferSize(10000);
  localStorage.setItem('su:render-quality:v1', ${JSON.stringify(quality)});
  const profile = window.__SU_LOADING_PROFILE__ = {
    marks: {}, frames: [], drawCalls: [], longTasks: [], bufferFull: 0, hidden: false,
    ready: false, stop: false
  };
  document.addEventListener('DOMContentLoaded', () => profile.marks.domContentLoaded = performance.now(), { once: true });
  window.addEventListener('load', () => profile.marks.load = performance.now(), { once: true });
  performance.addEventListener('resourcetimingbufferfull', () => profile.bufferFull++);
  try {
    new PerformanceObserver(list => profile.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: true });
  } catch {}
  let previous;
  const frame = (now) => {
    if (profile.stop) return;
    profile.hidden ||= document.hidden;
    if (previous !== undefined) profile.frames.push(now - previous);
    previous = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const poll = () => {
    if (profile.stop) return;
    const report = window.__SU_DEBUG__?.report();
    if (report) {
      const now = performance.now();
      const mark = (name, ready) => { if (ready && profile.marks[name] === undefined) profile.marks[name] = now; };
      const rendering = report.rendering, streaming = report.streaming;
      mark('debugReady', true);
      mark('previewReady', report.metrics.connection === 'ready');
      const active = !!streaming?.graphicsActive.length;
      mark('firstPositiveRadius', active && rendering?.streaming.readyRadius > 0);
      const visible = active && rendering?.streaming.readyRadius >= rendering?.streaming.drawRadius - 0.01;
      const shown = visible && rendering?.streaming.shownRadius >= rendering?.streaming.drawRadius - 1;
      mark('visibleReady', visible);
      mark('shownReady', shown);
      mark('backgroundReady', active && streaming?.backgroundReady);
      profile.ready = shown && streaming?.backgroundReady && report.metrics.connection === 'ready';
      if (rendering) profile.drawCalls.push(rendering.drawCalls);
    }
    setTimeout(poll, 100);
  };
  poll();
})()`;

async function collect(page: Page) {
  return page.evaluate(() => {
    const profile = (window as any).__SU_LOADING_PROFILE__;
    profile.stop = true;
    const resources = performance.getEntriesByType('resource').map((entry) => {
      const item = entry as PerformanceResourceTiming;
      return {
        path: new URL(item.name).pathname,
        startMs: item.startTime,
        durationMs: item.duration,
        responseEndMs: item.responseEnd,
        encodedBodyBytes: item.encodedBodySize,
        decodedBodyBytes: item.decodedBodySize,
        transferBytes: item.transferSize,
        initiatorType: item.initiatorType,
      };
    });
    return {
      profile,
      navigation: performance.getEntriesByType('navigation')[0]?.toJSON(),
      report: (window as any).__SU_DEBUG__?.report(),
      resources,
    };
  });
}
function summary(run: RunResult) {
  const world = run.resources.filter((entry) => entry.path.startsWith(worldPath));
  const sorted = (run.profile.frames as number[]).slice().sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
  return {
    label: run.label,
    responseDelayMs: run.responseDelayMs,
    marks: run.profile.marks,
    worldRequests: world.length,
    graphicsPackRequests: world.filter((entry) => entry.path.endsWith('.pack')).length,
    worldCacheHits: world.filter((entry) => entry.transferBytes === 0).length,
    worldTransferBytes: world.reduce((sum, entry) => sum + entry.transferBytes, 0),
    worldBodyBytes: world.reduce((sum, entry) => sum + entry.decodedBodyBytes, 0),
    lastWorldResponseMs: Math.max(0, ...world.map((entry) => entry.responseEndMs)),
    wasmRequests: run.resources.filter((entry) => entry.path.endsWith('.wasm')).length,
    graphicsCells: run.report?.streaming?.graphicsRequired.length,
    models: run.report?.rendering?.buildings.assets,
    meshes: run.report?.rendering?.meshes,
    materials: run.report?.rendering?.materials,
    drawCalls: run.report?.rendering?.drawCalls,
    frameMs: { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) },
    longTasks: run.profile.longTasks.length,
    errors: run.errors,
  };
}
async function save() {
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        source: directory,
        mapVersion: manifest.mapVersion,
        browser: browser?.version(),
        platform: platform(),
        cpu: cpus()[0].model,
        renderer: software ? 'SwiftShader' : 'browser default; see rendering.renderer',
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        quality,
        scope:
          'Unmodified production client preview, no room or database. Cold means fresh browser context/HTTP cache, not reset GPU/driver caches. Local HTTP, no compression/bandwidth limit; 20 ms is per-response synthetic delay, not real network RTT. Readiness marks use 100 ms sampling. Frame distributions cover loading, not steady gameplay or Safari hardware acceptance.',
        summaries: runs.map(summary),
        runs,
        zoomPhases,
      },
      null,
      2,
    ) + '\n',
  );
}
async function profile(label: string, context: BrowserContext, url: string) {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(probe);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForFunction(() => (window as any).__SU_LOADING_PROFILE__?.ready, undefined, {
      polling: 100,
      timeout: timeoutMs,
    });
    const data = await collect(page);
    const run = { label, responseDelayMs, errors, ...data };
    runs.push(run);
    await save();
    assert.deepEqual(errors, []);
    assert.equal(data.profile.hidden, false, 'loading profile must remain visible');
    assert.equal(data.profile.bufferFull, 0, 'resource timing buffer must not overflow');
    assert.equal(data.report.physics.bodies, 0, 'preview must have zero physics bodies');
    assert.equal(data.report.prediction.worlds, 0, 'preview must not initialize Havok');
    assert.equal(summary(run).wasmRequests, 0, 'preview must not download WASM');
    console.log(JSON.stringify(summary(run)));
    if (zoom && label === 'warm-cache') {
      for (const [phase, deltaY, expectedZoom] of [
        ['zoom30', 10000, 30],
        ['zoomClose', -Math.log(30) * 1000, 1],
      ] as const) {
        const previous = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
        await page.locator('#world').dispatchEvent('wheel', { deltaY });
        // A wheel event changes camera fields before the render loop updates the projection,
        // streaming plan and draw-call counter. Cross two RAF boundaries before inspecting it.
        await page.evaluate(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
        const planned = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
        assert.ok(Math.abs(planned.rendering.camera.zoom - expectedZoom) < 1e-6);
        const drawRadius: number = planned.rendering.streaming.drawRadius;
        if (manifest.worldId === 'ring-block')
          assert.ok(
            phase === 'zoom30'
              ? drawRadius > previous.rendering.streaming.drawRadius
              : drawRadius < previous.rendering.streaming.drawRadius,
            `${phase} must apply the new camera projection`,
          );
        const previousIds = new Set<string>(previous.streaming.graphicsRequired);
        // Zooming back keeps cells inside the retention margin. Its steady counts need not
        // equal a cold 1x preview, but cells outside that margin must actually be released.
        const expectedIds = manifest.cells
          .filter((cell) => {
            const distance = distanceToBoundsXZ(previewCenter, cell.bounds);
            return (
              distance <= drawRadius + 125 ||
              (previousIds.has(cell.cellId) && distance <= drawRadius + 300)
            );
          })
          .map((cell) => cell.cellId)
          .sort();
        if (phase === 'zoom30' && manifest.worldId === 'ring-block')
          assert.equal(
            expectedIds.length,
            manifest.cells.length,
            '30x must request all ring cells',
          );
        const expectedVersions = new Set(
          manifest.cells
            .filter((cell) => expectedIds.includes(cell.cellId))
            .flatMap((cell) => cell.assetIds.map((id) => manifest.assets[id].version)),
        );
        await page.evaluate(() => {
          (window as any).__SU_ZOOM_STEADY__ = undefined;
        });
        await page.waitForFunction(
          ({ expectedIds, expectedModels, expectedZoom, drawRadius }) => {
            const report = (window as any).__SU_DEBUG__.report();
            const { streaming, rendering } = report;
            const wanted = JSON.stringify(expectedIds);
            if (
              Math.abs(rendering.camera.zoom - expectedZoom) > 1e-6 ||
              Math.abs(rendering.streaming.drawRadius - drawRadius) > 1e-4 ||
              JSON.stringify(streaming.graphicsRequired.slice().sort()) !== wanted ||
              JSON.stringify(streaming.graphicsActive.slice().sort()) !== wanted ||
              !streaming.backgroundReady ||
              streaming.retained.length ||
              streaming.requested.length ||
              streaming.resources.pending ||
              streaming.resources.httpActive ||
              rendering.buildings.assets !== expectedModels ||
              Math.abs(rendering.streaming.readyRadius - drawRadius) > 1 ||
              Math.abs(rendering.streaming.shownRadius - drawRadius) > 1
            ) {
              (window as any).__SU_ZOOM_STEADY__ = undefined;
              return false;
            }
            const signature = JSON.stringify([
              streaming.staticCount,
              rendering.meshes,
              rendering.nodes,
              rendering.materials,
              rendering.geometries,
              rendering.shadowCasters,
              rendering.drawCalls,
            ]);
            const previous = (window as any).__SU_ZOOM_STEADY__;
            if (previous?.signature !== signature) {
              (window as any).__SU_ZOOM_STEADY__ = { signature, at: performance.now() };
              return false;
            }
            return performance.now() - previous.at >= 500;
          },
          { expectedIds, expectedModels: expectedVersions.size, expectedZoom, drawRadius },
          { timeout: timeoutMs, polling: 100 },
        );
        // Capture a rendered steady scene, never the last counter from before wheel dispatch.
        await page.evaluate(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
        const report = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
        assert.equal(report.physics.bodies, 0);
        assert.equal(report.prediction.worlds, 0);
        assert.deepEqual(report.streaming.graphicsActive.slice().sort(), expectedIds);
        assert.equal(report.rendering.buildings.assets, expectedVersions.size);
        zoomPhases.push({ phase, expectedIds, expectedModels: expectedVersions.size, report });
      }
      await save();
    }
  } catch (error) {
    await writeFile(
      join(output, 'failure.json'),
      JSON.stringify(
        { label, error: String(error), errors, data: await collect(page).catch(() => null) },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await page.close();
  }
}
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/?diagnostics=1`;
  browser = await launchTestBrowser({ renderer: software ? 'software' : 'default' });
  for (let index = 0; index < coldRuns; index++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    try {
      await profile(`cold-cache-${index + 1}`, context, url);
      if (index === coldRuns - 1) await profile('warm-cache', context, url);
    } finally {
      await context.close();
    }
  }
  responseDelayMs = 20;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    await profile('cold-cache-delay20', context, url);
  } finally {
    await context.close();
  }
  await save();
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
