import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cpus, platform } from 'node:os';
import { createServer } from 'vite';
import { buildWorld } from '../tools/world-build/src/index.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { hash } from './large-map/content.js';
const output = resolve(process.env.SU_L2_OUTPUT ?? 'output/large-map/l2');
await mkdir(output, { recursive: true });
const directory = join(output, 'world');
const manifest = await buildWorld(resolve('content/worlds/streaming-lab/world.json'), directory);
const wasm = await loadServerWasm();
const harness = await createServer({
  root: process.cwd(),
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'large-map-l2',
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url === '/l2') {
            response.setHeader('content-type', 'text/html');
            response.end('<!doctype html><title>L2 cell streaming</title><body></body>');
          } else if (request.url === '/l2-manifest') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(manifest));
          } else if (request.url === '/l2-wasm') response.end(wasm);
          else if (request.url?.startsWith('/l2-assets/')) {
            const file = request.url.slice('/l2-assets/'.length);
            if (!Object.hasOwn(manifest.files, file)) {
              response.statusCode = 404;
              response.end();
              return;
            }
            try {
              response.end(await readFile(join(directory, file)));
            } catch {
              response.statusCode = 500;
              response.end();
            }
          } else next();
        });
      },
    },
  ],
});
let browser;
try {
  await harness.listen();
  browser = await launchTestBrowser();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.text().startsWith('[L2]')) console.log(message.text());
  });
  await page.goto(`${harness.resolvedUrls!.local[0]}l2`);
  const result: Awaited<
    ReturnType<(typeof import('./large-map/streaming-browser.js'))['runStreamingProbe']>
  > = await page.evaluate(async () => {
    const url = '/tests/large-map/streaming-browser.ts';
    return (await import(/* @vite-ignore */ url)).runStreamingProbe();
  });
  assert.deepEqual(errors, []);
  assert.equal(result.hidden, false);
  await page.screenshot({ path: join(output, 'cleanup.png') });
  await page.evaluate(async () => {
    const url = '/tests/large-map/streaming-browser.ts';
    (await import(/* @vite-ignore */ url)).disposeProbe();
  });
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        'apps/client/src/streaming/resources.ts',
        'apps/client/src/streaming/cells.ts',
        'apps/client/src/rendering/buildings.ts',
        'apps/client/src/rendering/statics.ts',
        'apps/client/src/rendering/spatial-index.ts',
        'apps/client/src/rendering/world-view.ts',
        'packages/simulation/src/physics-world.ts',
        'packages/simulation/src/prediction.ts',
        'tests/large-map-l2.ts',
        'tests/large-map/streaming-browser.ts',
      ].map(async (path) => [path, hash(await readFile(path))]),
    ),
  );
  await writeFile(
    join(output, 'browser.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        mapVersion: manifest.mapVersion,
        simulationConfigHash: manifest.simulationConfigHash,
        browser: browser.version(),
        node: process.version,
        platform: platform(),
        cpu: cpus()[0].model,
        sourceHashes,
        result,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        status: result.status,
        initial: result.initial.resources,
        cycles: result.cycles,
        operationPeakMs: result.diagnostics.peakOperationMs,
        pumpPeakMs: result.diagnostics.peakPumpMs,
        resources: result.diagnostics.resources,
        cleanup: result.cleanup,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    const failure = await page
      .evaluate(() => (globalThis as unknown as { __L2_FAILURE__?: unknown }).__L2_FAILURE__)
      .catch(() => undefined);
    if (failure) await writeFile(join(output, 'failure.json'), JSON.stringify(failure, null, 2));
  }
  throw error;
} finally {
  await browser?.close();
  await harness.close();
}
