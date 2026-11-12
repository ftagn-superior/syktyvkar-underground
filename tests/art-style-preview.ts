/** Reproducible real-renderer art review, without multiplayer or a database.
 * pnpm world:build && SU_ART_LABEL=after node --import tsx tests/art-style-preview.ts
 * SU_ART_WORLD_DIRECTORY selects an immutable release; SU_ART_RENDERER=default uses the browser's default GPU.
 * Source geometry, materials, shadows, streaming and quality profiles are production code.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import type { WorldManifest } from '../packages/contracts/src/index.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { launchTestBrowser } from './helpers/browser.js';

const directory = resolve(process.env.SU_ART_WORLD_DIRECTORY ?? 'dist/worlds/ring-block');
const label = process.env.SU_ART_LABEL ?? 'after';
assert.match(label, /^[a-z0-9_-]+$/i);
const output = resolve('output/art-style', label);
await mkdir(output, { recursive: true });
const manifest: WorldManifest = JSON.parse(
  await readFile(join(directory, 'manifest.json'), 'utf8'),
);
const wasm = await loadServerWasm();
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: 'art-style-fixture.ts',
    loader: 'ts',
    contents: `
import { loadWorldHeader } from './packages/contracts/src/index.ts';
import { createPhysicsWorld } from './packages/simulation/src/physics-world.ts';
import { WorldView } from './apps/client/src/rendering/world-view.ts';
import { CellStreamer } from './apps/client/src/streaming/cells.ts';
import { VerifiedResources } from './apps/client/src/streaming/resources.ts';
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const manifest = await (await fetch('/manifest.json')).json();
const resources = new VerifiedResources(manifest, '/assets/');
const header = await loadWorldHeader(manifest, path => resources.read(path));
const world = await createPhysicsWorld(header, await (await fetch('/physics.wasm')).arrayBuffer(), true);
const canvas = document.querySelector('canvas');
const labels = document.createElement('div');
labels.style.display = 'none';
document.body.append(labels);
const initialQuality = new URLSearchParams(location.search).get('quality') === 'economy' ? 'economy' : 'standard';
const view = new WorldView(canvas, labels, header, initialQuality);
const stream = new CellStreamer(manifest, resources, world, view);
const camera = view.scene.activeCamera;
view.onFrame(() => {
  const area = view.graphicalArea();
  stream.setVisualArea(area.center, area.drawRadius);
  stream.pump();
  view.setStreamingRadius(stream.graphicsReadyRadius(area.center, area.drawRadius));
});
async function ready() {
  const started = performance.now();
  while (!stream.backgroundReady || view.renderingDiagnostics().camera.turning) {
    if (stream.backgroundProblem) throw new Error(stream.backgroundProblem);
    if (performance.now() - started > 120000) throw new Error('Art preview preparation deadline');
    await frame();
  }
  await delay(1200);
}
function compact(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
  return value;
}
function snapshot() {
  const ip = view.scene.imageProcessingConfiguration;
  return {
    rendering: view.renderingDiagnostics(), streaming: compact(stream.diagnostics()), resources: compact(resources.diagnostics()),
    avatars: view.avatarDiagnostics(),
    imageProcessing: {
      isEnabled: ip.isEnabled, applyByPostProcess: ip.applyByPostProcess,
      toneMappingEnabled: ip.toneMappingEnabled, toneMappingType: ip.toneMappingType,
      exposure: ip.exposure, contrast: ip.contrast, colorCurvesEnabled: ip.colorCurvesEnabled,
      saturation: ip.colorCurves?.globalSaturation, vignetteEnabled: ip.vignetteEnabled,
    },
    lights: view.scene.lights.map(light => ({
      name: light.name, intensity: light.intensity, diffuse: light.diffuse.asArray(),
      direction: light.direction?.asArray(), groundColor: light.groundColor?.asArray()
    })),
  };
}
window.__ART__ = {
  async shot({x = 0, y = 0, z = 0, zoom = 3.2, angle = Math.PI / 4, quality = 'standard'}) {
    view.setQuality(quality);
    // Test-only framing; the production orbit, zoom and streaming paths remain active.
    view.target.set(x, y, z);
    camera.setTarget(view.target, false, false, true);
    canvas.dispatchEvent(new WheelEvent('wheel', {deltaY: Math.log(zoom / view.cameraZoom) * 1000, cancelable: true}));
    view.rotateCameraBy(angle - view.cameraAngle);
    stream.setPreview({x, y: 0, z}, view.graphicalArea().drawRadius);
    await ready();
    return snapshot();
  },
  async showcase() {
    const center = {x: -16, z: 14};
    const types = Object.values(header.itemCatalog.types);
    const entities = [];
    const common = {revision: 0, velocity: {x: 0, y: 0, z: 0}, angularVelocity: {x: 0, y: 0, z: 0}, rotation: {x: 0, y: 0, z: 0, w: 1}, connected: true};
    const at = (index, y) => ({x: center.x + (index - 3) * 2.35 / Math.SQRT2, y, z: center.z - (index - 3) * 2.35 / Math.SQRT2});
    for (const [i, skinId] of ['standard', 'minifigure'].entries()) entities.push({
      ...common, entityId: 'art-' + skinId, kind: 'player', skinId,
      position: at(i, header.simulation.character.height / 2 + 0.05),
      motionRevision: 0, motionEnabled: false, grounded: true, color: i ? '#e5b867' : '#65d6bc',
    });
    for (const [i, type] of types.entries()) entities.push({
      ...common, entityId: 'art-' + type.typeId, kind: 'item', typeId: type.typeId,
      position: at(i + 2, type.size.y / 2 + 0.05),
    });
    view.update(entities, undefined, 1 / 60);
    return this.shot({...center, zoom: 0.6});
  },
  dispose() {stream.dispose(); world.dispose(); view.dispose();}
};
`,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
// Persist the exact runtime bundle alongside captures, independently of later source edits.
await writeFile(join(output, 'renderer.js'), bundle.outputFiles[0].contents);
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  try {
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Game art review</title><style>html,body{margin:0;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style><canvas></canvas><script type="module" src="/renderer.js"></script>',
      );
    } else if (path === '/renderer.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(bundle.outputFiles[0].contents);
    } else if (path === '/manifest.json') response.end(JSON.stringify(manifest));
    else if (path === '/physics.wasm') response.end(wasm);
    else if (path.startsWith('/assets/') && Object.hasOwn(manifest.files, path.slice(8)))
      response.end(await readFile(join(directory, path.slice(8))));
    else {
      response.statusCode = 404;
      response.end();
    }
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
const errors: string[] = [];
const shots: { name: string; state: any; [key: string]: unknown }[] = [];
try {
  browser = await launchTestBrowser({
    renderer: process.env.SU_ART_RENDERER === 'default' ? 'default' : 'software',
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => (window as any).__ART__, undefined, { timeout: 120000 });
  const views = [
    { name: 'ring-standard', quality: 'standard', zoom: 3.2, angle: Math.PI / 4 },
    { name: 'monument-standard', quality: 'standard', y: 8, zoom: 1.6, angle: Math.PI / 4 },
    { name: 'ring-east', quality: 'standard', zoom: 3.2, angle: (Math.PI * 3) / 4 },
    { name: 'ring-north', quality: 'standard', zoom: 3.2, angle: (Math.PI * 5) / 4 },
    { name: 'ring-west', quality: 'standard', zoom: 3.2, angle: (Math.PI * 7) / 4 },
    { name: 'ring-economy', quality: 'economy', zoom: 3.2, angle: Math.PI / 4 },
  ];
  for (const shot of views) {
    const state = await page.evaluate((shot) => (window as any).__ART__.shot(shot), shot);
    await page.screenshot({ path: join(output, shot.name + '.png') });
    shots.push({ ...shot, state });
    console.log(`Captured ${shot.name}`);
  }
  const standard = shots.find((shot) => shot.name === 'ring-standard')!.state;
  const economy = shots.find((shot) => shot.name === 'ring-economy')!.state;
  const returned = await page.evaluate(() => (window as any).__ART__.shot({ quality: 'standard' }));
  const tone = ({ applyByPostProcess: _post, ...config }: Record<string, unknown>) => config;
  assert.deepEqual(
    returned.imageProcessing,
    standard.imageProcessing,
    'Returning from economy preserves the standard tone curve and pipeline',
  );
  const showcase = await page.evaluate(() => (window as any).__ART__.showcase());
  await page.screenshot({ path: join(output, 'avatars-and-items.png') });
  shots.push({ name: 'avatars-and-items', state: showcase });
  console.log('Captured avatars-and-items');
  await page.evaluate(() => (window as any).__ART__.dispose());
  await page.goto(`http://127.0.0.1:${address.port}/?quality=economy`);
  await page.waitForFunction(() => (window as any).__ART__, undefined, { timeout: 120000 });
  const freshEconomy = await page.evaluate(() =>
    (window as any).__ART__.shot({ quality: 'economy' }),
  );
  await page.screenshot({ path: join(output, 'ring-economy-fresh.png') });
  shots.push({ name: 'ring-economy-fresh', state: freshEconomy });
  assert.deepEqual(
    freshEconomy.imageProcessing,
    economy.imageProcessing,
    'Fresh economy and standard-to-economy use identical color processing',
  );
  assert.deepEqual(
    tone(freshEconomy.imageProcessing),
    tone(standard.imageProcessing),
    'Both quality modes share the art direction',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        date: new Date().toISOString(),
        mapVersion: manifest.mapVersion,
        directory,
        browser: browser.version(),
        viewport: { width: 1600, height: 1000 },
        scope:
          'Production WorldView, verified GLBs, streaming, quality profiles; no network/player simulation or hardware performance acceptance.',
        knownLimitations: [
          'Pre-existing layered-ground interpolation artifacts on SwiftShader are also visible in the before capture.',
          'This run is not hardware performance acceptance; the renderer is recorded for every shot.',
        ],
        shots,
        qualityChecks: {
          standardRoundTrip: returned.imageProcessing,
          freshEconomy: freshEconomy.imageProcessing,
        },
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  await page.evaluate(() => (window as any).__ART__.dispose());
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
