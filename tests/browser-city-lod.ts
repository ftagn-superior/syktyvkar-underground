import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { cpus, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { launchTestBrowser } from './helpers/browser.js';
import { cityLodScenes } from './helpers/city-lod-scenes.js';
import { adaptFrozenCityLodScript } from './helpers/frozen-city-lod-client.js';
import { PROTOCOL_VERSION, type WorldManifest } from '../packages/contracts/src/index.js';

const output = resolve(process.env.SU_LOD_OUTPUT ?? 'output/city-lod/browser');
await mkdir(output, { recursive: true });
const coldRuns = Number(process.env.SU_LOD_COLD_RUNS ?? 3),
  cycles = Number(process.env.SU_LOD_CYCLES ?? 10);
assert.ok(Number.isInteger(coldRuns) && coldRuns >= 1 && coldRuns <= 5);
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 10);
const viewport = {
  width: Number(process.env.SU_LOD_WIDTH ?? 1440),
  height: Number(process.env.SU_LOD_HEIGHT ?? 900),
};
assert.ok(viewport.width >= 640 && viewport.height >= 400);
const hardware = process.env.SU_TEST_RENDERER === 'hardware';
const baseline = resolve(process.env.SU_LOD_BASELINE ?? 'output/city-lod/baseline');
const savedBaseline = process.env.SU_LOD_BASELINE_RESULTS
  ? JSON.parse(await readFile(resolve(process.env.SU_LOD_BASELINE_RESULTS), 'utf8'))
  : undefined;
const candidates = [
  {
    name: 'baseline',
    world: join(baseline, 'worlds/ring-block'),
    client: join(baseline, 'app/client'),
    protocol: 21,
  },
  {
    name: 'candidate',
    world: resolve(process.env.SU_LOD_WORLD ?? 'dist/worlds/ring-block'),
    client: resolve('dist/client'),
    protocol: PROTOCOL_VERSION,
  },
].filter(
  (c) =>
    (!process.env.SU_LOD_ONLY || c.name === process.env.SU_LOD_ONLY) &&
    (!savedBaseline || c.name !== 'baseline'),
);
// The frozen baseline has no initial camera parameter or buffer counter. These two
// measurement adapters run in the HTTP fixture only; its streaming/render code is intact.
const results: any[] = savedBaseline?.results.filter((r: any) => r.candidate === 'baseline') ?? [];
const inputIdentities: Record<string, unknown> = savedBaseline?.inputIdentities ?? {};
const browser = await launchTestBrowser({ renderer: hardware ? 'default' : 'software' });
try {
  if (savedBaseline) {
    assert.deepEqual(savedBaseline.viewport, viewport);
    assert.equal(savedBaseline.hardware, hardware);
    assert.equal(savedBaseline.cpu, cpus()[0].model);
    assert.equal(savedBaseline.browser, browser.version());
    const manifest = JSON.parse(
      await readFile(join(baseline, 'worlds/ring-block/manifest.json'), 'utf8'),
    );
    assert.equal(savedBaseline.inputIdentities.baseline.mapVersion, manifest.mapVersion);
    assert.equal(
      savedBaseline.inputIdentities.baseline.simulationConfigHash,
      manifest.simulationConfigHash,
    );
    for (const zoom of [1, 30]) {
      assert.equal(results.filter((r) => r.zoom === zoom && r.cache === 'cold').length, coldRuns);
      assert.equal(results.filter((r) => r.zoom === zoom && r.cache === 'warm').length, 1);
    }
  }
  for (const candidate of candidates) {
    const manifest: WorldManifest = JSON.parse(
      await readFile(join(candidate.world, 'manifest.json'), 'utf8'),
    );
    inputIdentities[candidate.name] = {
      mapVersion: manifest.mapVersion,
      simulationConfigHash: manifest.simulationConfigHash,
      graphicsSource: manifest.graphics?.sourceVersion,
      policy: manifest.graphics?.policyVersion,
    };
    const server = createServer(async (req, res) => {
      try {
        const path = new URL(req.url!, 'http://local').pathname;
        if (path === '/api/world' || path === '/api/me') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(
            JSON.stringify(
              path === '/api/me'
                ? { enabled: false, account: null }
                : {
                    assetReleaseVersion: 'a'.repeat(64),
                    layoutRevision: 1,
                    layoutHash: 'b'.repeat(64),
                    roomId: 'lod-profile',
                    worldEpoch: 'lod-profile',
                    protocolVersion: candidate.protocol,
                    mapVersion: manifest.mapVersion,
                    simulationConfigHash: manifest.simulationConfigHash,
                    manifestUrl: '/worlds/lod/manifest.json',
                    maxPlayers: 8,
                    available: true,
                  },
            ),
          );
          return;
        }
        const world = path.startsWith('/worlds/lod/'),
          relative = world
            ? path.slice('/worlds/lod/'.length)
            : '.' + (path === '/' ? '/index.html' : path),
          directory = world ? candidate.world : candidate.client;
        if (world && relative !== 'manifest.json' && !Object.hasOwn(manifest.files, relative)) {
          res.writeHead(404).end();
          return;
        }
        const file = resolve(directory, relative);
        if (!file.startsWith(directory + sep)) throw new Error('Invalid path');
        await stat(file);
        let bytes = await readFile(file);
        if (candidate.name === 'baseline' && file.endsWith('.js')) {
          const script = adaptFrozenCityLodScript(bytes.toString());
          if (script) bytes = Buffer.from(script);
        }
        res.setHeader(
          'Content-Type',
          (
            {
              '.html': 'text/html',
              '.js': 'text/javascript',
              '.css': 'text/css',
              '.json': 'application/json',
              '.wasm': 'application/wasm',
              '.glb': 'model/gltf-binary',
            } as Record<string, string>
          )[extname(file)] ?? 'application/octet-stream',
        );
        res.setHeader(
          'Cache-Control',
          relative === 'manifest.json' ? 'no-cache' : 'public, max-age=31536000, immutable',
        );
        res.end(bytes);
      } catch {
        if (!res.headersSent) res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      for (const zoom of (process.env.SU_LOD_ZOOMS ?? '1,30').split(',').map(Number)) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
        try {
          for (let run = 0; run <= coldRuns; run++) {
            const selected =
              run === 0
                ? context
                : run === coldRuns
                  ? context
                  : await browser.newContext({ viewport, deviceScaleFactor: 1 });
            const page = await selected.newPage(),
              errors: string[] = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.addInitScript(
              "localStorage.setItem('su:render-quality:v1','economy');performance.setResourceTimingBufferSize(10000);",
            );
            const start = Date.now();
            const peaks = {
              geometryBytes: 0,
              triangles: 0,
              models: 0,
              httpActive: 0,
              cacheBytes: 0,
            };
            await page.goto(`http://127.0.0.1:${port}/?diagnostics=1&time=12&initialZoom=${zoom}`, {
              waitUntil: 'domcontentloaded',
            });
            const diagnosticTimer = setInterval(() => {
              void page
                .evaluate(() => {
                  const r = (window as any).__SU_DEBUG__?.report();
                  return r
                    ? {
                        connection: r.metrics.connection,
                        ready: r.streaming?.backgroundReady,
                        groups: r.streaming?.groups,
                        cells: r.streaming?.cells,
                        resources: r.streaming?.resources,
                        geometry: r.rendering.geometry,
                        models: r.rendering.buildings.assets,
                      }
                    : null;
                })
                .then((data) => {
                  peaks.geometryBytes = Math.max(
                    peaks.geometryBytes,
                    data?.geometry?.geometryBytes ?? 0,
                  );
                  peaks.triangles = Math.max(peaks.triangles, data?.geometry?.triangles ?? 0);
                  peaks.models = Math.max(peaks.models, data?.models ?? 0);
                  peaks.httpActive = Math.max(peaks.httpActive, data?.resources?.httpActive ?? 0);
                  peaks.cacheBytes = Math.max(peaks.cacheBytes, data?.resources?.cacheBytes ?? 0);
                  return writeFile(
                    join(output, `${candidate.name}-${zoom}-pending.json`),
                    JSON.stringify({ data, errors }),
                  );
                })
                .catch(() => {});
            }, 5000);
            try {
              await page.waitForFunction(
                () => {
                  const r = (window as any).__SU_DEBUG__?.report();
                  return (
                    r?.metrics.connection === 'ready' &&
                    r.streaming?.backgroundReady &&
                    r.rendering.streaming.readyRadius >= r.rendering.streaming.drawRadius - 0.01
                  );
                },
                undefined,
                { timeout: Number(process.env.SU_LOD_TIMEOUT_MS ?? 900_000), polling: 200 },
              );
            } finally {
              clearInterval(diagnosticTimer);
            }
            const readyMs = Date.now() - start;
            await page.waitForTimeout(hardware ? 10_000 : 1000);
            const frames: number[] = await page.evaluate(
              `new Promise(resolve=>{const frames=[];let previous,start;const step=now=>{start??=now;if(previous!==undefined)frames.push(now-previous);previous=now;if(now-start>=${hardware ? 30000 : 2000})resolve(frames);else requestAnimationFrame(step);};requestAnimationFrame(step);})`,
            );
            const data = await page.evaluate(() => ({
              report: (window as any).__SU_DEBUG__.report(),
              gpu: (() => {
                const gl = (document.querySelector('#world') as HTMLCanvasElement).getContext(
                  'webgl2',
                )!;
                const extension = gl.getExtension('WEBGL_debug_renderer_info');
                return extension
                  ? {
                      vendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL),
                      renderer: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL),
                    }
                  : null;
              })(),
              resources: performance.getEntriesByType('resource').map((e: any) => ({
                path: new URL(e.name).pathname,
                body: e.decodedBodySize,
                transfer: e.transferSize,
              })),
            }));
            assert.deepEqual(errors, []);
            assert.equal(data.resources.filter((r) => r.path.endsWith('.wasm')).length, 0);
            assert.equal(data.report.metrics.connection, 'ready');
            assert.equal(data.report.rendering.camera.zoom, zoom);
            const groups = data.report.streaming.groups ?? [];
            if (candidate.name === 'candidate') {
              const near = new Set(
                groups.filter((g: any) => g.current === 'near').map((g: any) => g.id),
              );
              const nearMembers = new Set(
                manifest
                  .graphics!.groups.filter((g) => near.has(g.groupId))
                  .flatMap((g) => g.memberIds),
              );
              // Every LOD0 request must have an actual near consumer; far never prefetches a cell pack.
              const allowed = new Set<string>();
              for (const cell of manifest.cells) {
                if (
                  !manifest.graphics!.groups.some(
                    (g) => g.ownerCellId === cell.cellId && near.has(g.groupId),
                  )
                )
                  continue;
                const body = JSON.parse(await readFile(join(candidate.world, cell.file), 'utf8'));
                for (const b of body.buildings)
                  if (nearMembers.has(b.entityId)) {
                    const a = manifest.assets[b.assetId];
                    allowed.add('/worlds/lod/' + a.partsFile);
                    if (a.modelFile) allowed.add('/worlds/lod/' + a.modelFile);
                  }
              }
              for (const r of data.resources.filter(
                (r) =>
                  r.path.startsWith('/worlds/lod/assets/') && !r.path.endsWith('colliders.json'),
              ))
                assert.ok(allowed.has(r.path), `LOD0 requested without near owner: ${r.path}`);
            }
            const sorted = frames.slice().sort((a, b) => a - b),
              worldResources = data.resources.filter((r) => r.path.startsWith('/worlds/lod/'));
            const result = {
              candidate: candidate.name,
              zoom,
              cache: run === coldRuns ? 'warm' : 'cold',
              run,
              readyMs,
              bodyBytes: worldResources.reduce((n, r) => n + r.body, 0),
              transferBytes: worldResources.reduce((n, r) => n + r.transfer, 0),
              p95: sorted[Math.floor(sorted.length * 0.95)],
              frames,
              sampledLoadingPeaks: peaks,
              ...data,
            };
            results.push(result);
            await page.screenshot({ path: join(output, `${candidate.name}-${zoom}-${run}.png`) });
            await writeFile(
              join(output, 'result.json'),
              JSON.stringify(
                {
                  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
                  browser: browser.version(),
                  cpu: cpus()[0].model,
                  platform: platform(),
                  hardware,
                  viewport,
                  baselineResultsReusedFrom: process.env.SU_LOD_BASELINE_RESULTS,
                  inputIdentities,
                  conditions:
                    'Authored seed preview, economy, noon, local HTTP, no compression, no room/physics. Baseline has two measurement adapters: initialZoom and unique buffer counters.',
                  results,
                },
                null,
                2,
              ),
            );
            console.log(
              JSON.stringify({
                candidate: candidate.name,
                zoom,
                run,
                readyMs,
                bodyBytes: result.bodyBytes,
                geometry: data.report.rendering.geometry,
                drawCalls: data.report.rendering.drawCalls,
                near: groups.filter((g: any) => g.current === 'near').length,
                far: groups.filter((g: any) => g.current === 'far').length,
              }),
            );
            if (candidate.name === 'candidate' && zoom === 30 && run === coldRuns) {
              const owners = (r: any) =>
                r.streaming.groups
                  .filter((g: any) => g.wanted)
                  .map((g: any) => [g.id, g.version, g.current])
                  .sort();
              const expectedOwners = owners(data.report);
              for (let cycle = 0; cycle < cycles; cycle++) {
                for (const z of [1, 30]) {
                  await page
                    .locator('#world')
                    .dispatchEvent('wheel', { deltaY: Math.log(z === 1 ? 1 / 30 : 30) * 1000 });
                  await page.evaluate(
                    'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
                  );
                  await page.waitForFunction(
                    (z) => {
                      const r = (window as any).__SU_DEBUG__.report();
                      return (
                        Math.abs(r.rendering.camera.zoom - z) < 1e-5 && r.streaming.backgroundReady
                      );
                    },
                    z,
                    { timeout: 300_000, polling: 100 },
                  );
                }
                const r = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
                assert.deepEqual(
                  owners(r),
                  expectedOwners,
                  'cycles restore the same group owners and levels',
                );
                assert.equal(
                  r.rendering.buildings.instances,
                  r.streaming.groups
                    .filter((g: any) => g.current === 'near')
                    .reduce((n: number, g: any) => n + g.nearInstances, 0),
                );
                assert.ok(r.streaming.groups.every((g: any) => g.current === g.wanted));
                assert.equal(
                  r.rendering.geometry.triangles,
                  data.report.rendering.geometry.triangles,
                  'cycles release all abandoned parsed geometry',
                );
                assert.equal(
                  r.rendering.geometry.geometryBytes,
                  data.report.rendering.geometry.geometryBytes,
                  'resident payloads return to the original far set',
                );
                if (!r.streaming.groups.some((g: any) => g.current === 'near')) {
                  assert.equal(
                    r.rendering.buildings.assets,
                    0,
                    'far releases every parsed near model',
                  );
                  assert.equal(
                    r.rendering.buildings.instances,
                    0,
                    'far releases every near instance',
                  );
                }
                await writeFile(join(output, `cycle-${cycle}.json`), JSON.stringify(r));
              }
              if (process.env.SU_LOD_SCENES === '1') {
                await page.close();
                await cityLodScenes(selected, `http://127.0.0.1:${port}`, output);
              }
            }
            await page.close();
            if (selected !== context) await selected.close();
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  }
  const mean = (name: string, zoom: number, metric: (r: any) => number) => {
    const values = results
      .filter((r) => r.candidate === name && r.zoom === zoom && r.cache === 'cold')
      .map(metric);
    return values.reduce((a, b) => a + b, 0) / values.length;
  };
  if (
    results.some((r) => r.candidate === 'baseline') &&
    results.some((r) => r.candidate === 'candidate')
  ) {
    if (results.some((r) => r.zoom === 30))
      for (const [name, metric, ratio] of [
        ['body bytes', (r: any) => r.bodyBytes, 0.5],
        ['buffer payloads', (r: any) => r.report.rendering.geometry.geometryBytes, 0.5],
        ['resident triangles', (r: any) => r.report.rendering.geometry.triangles, 0.25],
        ['draw calls', (r: any) => r.report.rendering.drawCalls, 0.5],
      ] as const) {
        const b = mean('baseline', 30, metric),
          n = mean('candidate', 30, metric);
        assert.ok(n <= ratio * b, `${name}: ${n}/${b} > ${ratio}`);
      }
    if (results.some((r) => r.zoom === 1))
      for (const [label, metric] of [
        ['close readiness', (r: any) => r.readyMs],
        ['close frame p95', (r: any) => r.p95],
      ] as const) {
        const b = mean('baseline', 1, metric),
          n = mean('candidate', 1, metric);
        assert.ok(n <= 1.1 * b, `${label}: ${n}/${b} > 1.1`);
      }
  }
} finally {
  await browser.close();
}
