import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import type { WorldManifest } from '../packages/contracts/src/index.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { launchTestBrowser } from './helpers/browser.js';

const directory = resolve(process.env.SU_STATIC_WORLD_DIRECTORY ?? 'dist/worlds/ring-block');
const label = process.env.SU_STATIC_LABEL ?? 'after';
const wideOnly = process.env.SU_STATIC_WIDE_ONLY === '1';
const cancelOnly = process.env.SU_STATIC_CANCEL_ONLY as 'glb' | 'pack' | 'collision' | undefined;
const output = resolve('output/static-extraction', label);
await mkdir(output, { recursive: true });
const manifest: WorldManifest = JSON.parse(
  await readFile(join(directory, 'manifest.json'), 'utf8'),
);
const wasm = await loadServerWasm();
const server = await createServer({
  root: process.cwd(),
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'static-extraction-evidence',
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url === '/extraction') {
            response.setHeader('content-type', 'text/html');
            response.end(
              '<!doctype html><title>Static object extraction evidence</title><body></body>',
            );
          } else if (request.url === '/extraction-manifest') response.end(JSON.stringify(manifest));
          else if (request.url === '/extraction-wasm') response.end(wasm);
          else if (request.url?.startsWith('/extraction-assets/')) {
            const file = request.url.slice('/extraction-assets/'.length);
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
const browser = await launchTestBrowser();
const errors: string[] = [];
let page;
const phases: { phase: string; result: unknown }[] = [];
try {
  await server.listen();
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0] + 'extraction');
  await page.evaluate(async (cancelLate) => {
    const url = '/tests/static-extraction/browser.ts';
    (window as any).__EXTRACTION__ = await (
      await import(/* @vite-ignore */ url)
    ).createExtractionProbe({ cancelLate });
  }, cancelOnly);
  if (cancelOnly) {
    phases.push({
      phase: 'cancel-late-' + cancelOnly,
      result: await page.evaluate(() => (window as any).__EXTRACTION__),
    });
  } else {
    phases.push({
      phase: 'preview',
      result: await page.evaluate(() => (window as any).__EXTRACTION__.snapshot()),
    });
    if (wideOnly) {
      phases.push({
        phase: 'zoom30-sampled-four-views',
        result: await page.evaluate(() => (window as any).__EXTRACTION__.zoomWide(true)),
      });
      await page.screenshot({ path: join(output, 'zoom30.png') });
    } else {
      phases.push({
        phase: 'enter',
        result: await page.evaluate(() => (window as any).__EXTRACTION__.enter()),
      });
      for (const [name, x, z] of [
        ['ring', 0, 0],
        ['houses', -33, 47],
        ['traffic-light', 69.883, -24.949],
        ['fence-gate', -1.827, 91.422],
        ['bus-stop', -96.157, -161.625],
        ['trees', -72.925, 20.633],
        ['theatre-square', 210, -190],
      ] as const) {
        await page.evaluate(({ x, z }) => (window as any).__EXTRACTION__.focus({ x, z }), { x, z });
        const result = await page.evaluate(() => (window as any).__EXTRACTION__.sample());
        phases.push({ phase: name, result });
        await page.screenshot({ path: join(output, `${name}.png`) });
        console.log(`[static-extraction:${label}] ${name}`);
      }
      phases.push({
        phase: 'zoom30-four-views',
        result: await page.evaluate(() => (window as any).__EXTRACTION__.zoomWide()),
      });
      await page.screenshot({ path: join(output, 'zoom30.png') });
      phases.push({
        phase: 'zoom-close',
        result: await page.evaluate(() => (window as any).__EXTRACTION__.zoomClose()),
      });
      for (let cycle = 0; cycle < 2; cycle++) {
        for (const [corner, x, z] of [
          ['northwest', -260, -735],
          ['southeast', 325, 125],
        ] as const) {
          await page.evaluate(({ x, z }) => (window as any).__EXTRACTION__.focus({ x, z }), {
            x,
            z,
          });
          phases.push({
            phase: `${corner}-${cycle}`,
            result: await page.evaluate(() => (window as any).__EXTRACTION__.sample(5500, 500)),
          });
        }
        await page.evaluate(() => (window as any).__EXTRACTION__.focus({ x: 0, z: 0 }));
        phases.push({
          phase: `return-${cycle}`,
          result: await page.evaluate(() => (window as any).__EXTRACTION__.sample(5500, 1000)),
        });
      }
      phases.push({
        phase: 'leave-preview',
        result: await page.evaluate(() => (window as any).__EXTRACTION__.leave()),
      });
      phases.push({
        phase: 'reenter',
        result: await page.evaluate(() => (window as any).__EXTRACTION__.enter()),
      });
      phases.push({
        phase: 'leave-again',
        result: await page.evaluate(() => (window as any).__EXTRACTION__.leave()),
      });
    }
    phases.push({
      phase: 'dispose',
      result: await page.evaluate(() => (window as any).__EXTRACTION__.dispose()),
    });
  }
  if (!wideOnly && !cancelOnly) {
    const resourceSignature = (name: string) => {
      const state = phases.find((phase) => phase.phase === name)!.result as any;
      const { rendering, streaming, physics, resources } = state;
      return {
        cells: streaming.active.length,
        statics: streaming.entities,
        references: streaming.references,
        meshes: rendering.meshes,
        materials: rendering.materials,
        geometries: rendering.geometries,
        nodes: rendering.nodes,
        textures: rendering.textures,
        shadows: rendering.shadowCasters,
        models: rendering.buildings.assets,
        physics,
        cacheBytes: resources.cacheBytes,
        cacheEntries: resources.cacheEntries,
      };
    };
    for (const point of ['northwest', 'southeast', 'return']) {
      assert.deepEqual(
        resourceSignature(`${point}-0`),
        resourceSignature(`${point}-1`),
        `${point} route accumulates resources`,
      );
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        date: new Date().toISOString(),
        mapVersion: manifest.mapVersion,
        source: directory,
        browser: browser.version(),
        platform: platform(),
        cpu: cpus()[0].model,
        node: process.version,
        viewport: { width: 1920, height: 1080 },
        renderer: 'SwiftShader',
        quality: 'economy',
        warmupMs: 1500,
        sampleMs: 2000,
        scope:
          'Real GLB/WorldView/CellStreamer/Havok; camera relocation and adapter entry/exit, without network/player simulation. Full game is checked separately by dynamic-map-browser.',
        hardwareAcceptance: false,
        phases,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`[static-extraction:${label}] passed`);
} catch (error) {
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify({ error: String(error), phases, errors }, null, 2),
  );
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await server.close();
}
