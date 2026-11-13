/** Visual review of the complete pilot publication and its real saved owners. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { launchTestBrowser } from './helpers/browser.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';

const output = resolve(process.argv[2] ?? 'output/ring-terrain-stage4');
const directory = join(output, 'export-world');
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const wasm = await loadServerWasm();
const snapshot = JSON.parse(
  await readFile(join(output, 'static-preflight.json'), 'utf8'),
).targetSnapshot;
const owner = (id: string) => {
  const value = snapshot.instances.find((o: any) => o.entityId === id && o.enabled);
  assert.ok(value, `Missing visual witness owner: ${id}`);
  return value.position;
};
const pilot = owner('osm-way-1258973447');
const select = (prefix: string) =>
  prefix === 'bench-'
    ? snapshot.instances.find((o: any) => o.entityId === 'bench-e81b6a3635e6cc487a3b')
    : snapshot.instances.find(
        (o: any) =>
          o.enabled && o.assetId.startsWith(prefix) && o.position.y > 1 && o.position.x < 200,
      );
const framesToCapture = [
  { kind: 'overview', focus: { x: -105, y: pilot.y, z: -158 }, zoom: 4, angle: -0.8, beta: 0.55 },
  {
    kind: 'entrance',
    focus: { x: -92, y: pilot.y + 0.6, z: -119 },
    zoom: 0.8,
    angle: -0.6,
    beta: 1.12,
  },
  ...['monument-trudovaya-slava', 'monument-kuratov', 'theatre-fountain-west'].map((id) => ({
    kind: id,
    focus: owner(id),
    zoom: 2,
    angle: -0.8,
    beta: 0.65,
  })),
  ...['bus-stop-', 'bench-'].map((prefix) => {
    const o = select(prefix);
    assert.ok(o);
    return {
      kind: o.entityId,
      focus: { ...o.position, y: o.position.y + 1 },
      zoom: 0.65,
      angle: -0.8,
      beta: 1.1,
    };
  }),
];
const module = String.raw`
import { loadWorldHeader } from '/packages/contracts/src/index.ts';
import { createPhysicsWorld } from '/packages/simulation/src/physics-world.ts';
import { WorldView } from '/apps/client/src/rendering/world-view.ts';
import { CellStreamer } from '/apps/client/src/streaming/cells.ts';
import { VerifiedResources } from '/apps/client/src/streaming/resources.ts';
const manifest = await (await fetch('/witness-manifest')).json();
const resources = new VerifiedResources(manifest, '/witness-assets/');
const header = await loadWorldHeader(manifest, path => resources.read(path));
const world = await createPhysicsWorld(header, await (await fetch('/witness-wasm')).arrayBuffer(), true);
document.body.style.cssText = 'margin:0;overflow:hidden;background:#101820';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:100vw;height:100vh';
document.body.append(canvas);
const view = new WorldView(canvas, document.createElement('div'), header, 'standard');
view.setTimeOfDay(12);
const stream = new CellStreamer(manifest, resources, world, view);
const camera = view.scene.activeCamera;
const controls = await (await fetch('/witness-controls')).json();
const focus = controls[0].focus;
view.target.set(focus.x,focus.y,focus.z);
camera.setTarget(view.target, false, false, true);
view.onFrame(() => { stream.pump(); view.setStreamingRadius(350); });
stream.setArea(focus);
stream.setVisualArea(focus, 350);
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const start = performance.now();
while (!stream.criticalReady || !stream.backgroundReady) {
  if (stream.backgroundProblem) throw new Error(stream.backgroundProblem);
  if (performance.now()-start > 120000) throw new Error('Preview stream timed out');
  await frame();
}
window.__SUPPORT_PREVIEW__ = {
  async frame(control) {
    const {focus, zoom, angle, beta} = control;
    view.target.set(focus.x, focus.y, focus.z);
    camera.setTarget(view.target, false, false, true);
    view.zoom = zoom;
    view.sizeCamera();
    view.cameraOrbit.setAngle(angle);
    camera.beta = beta;
    stream.setArea(focus);
    stream.setVisualArea(focus, 350);
    for(let i=0;i<30;i++) await frame();
    const began=performance.now();
    while(!stream.criticalReady || !stream.backgroundReady) {
      if(stream.backgroundProblem) throw new Error(stream.backgroundProblem);
      if(performance.now()-began>120000) throw new Error('Visual region load timed out');
      await frame();
    }
    for(let i=0;i<30;i++) await frame();
    return {rendering:view.renderingDiagnostics(), physics:world.staticDiagnostics(), meshes:view.scene.meshes.length};
  },
  dispose() { stream.dispose(); world.dispose(); view.dispose(); }
};
`;
const server = await createServer({
  root: process.cwd(),
  configFile: false,
  logLevel: 'error',
  cacheDir: join(output, 'preview-vite-cache'),
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'terrain-support-witness',
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          const path = new URL(request.url ?? '/', 'http://localhost').pathname;
          try {
            if (path === '/witness') {
              response.setHeader('content-type', 'text/html');
              response.end(
                '<!doctype html><title>Terrain supports</title><script type="module" src="/witness-module.js"></script>',
              );
            } else if (path === '/witness-module.js') {
              response.setHeader('content-type', 'text/javascript');
              response.end(module);
            } else if (path === '/witness-manifest') response.end(JSON.stringify(manifest));
            else if (path === '/witness-controls') response.end(JSON.stringify(framesToCapture));
            else if (path === '/witness-wasm') response.end(wasm);
            else if (path.startsWith('/witness-assets/')) {
              const file = path.slice('/witness-assets/'.length);
              if (!Object.hasOwn(manifest.files, file)) {
                response.statusCode = 404;
                response.end();
                return;
              }
              response.end(await readFile(join(directory, file)));
            } else next();
          } catch {
            response.statusCode = 500;
            response.end('Witness resource failed');
          }
        });
      },
    },
  ],
});
await server.listen();
const browser = await launchTestBrowser({ renderer: 'default', channel: 'chromium' });
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (error) => errors.push(error.message));
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}/witness`);
  await page.waitForFunction(() => !!(window as any).__SUPPORT_PREVIEW__, undefined, {
    timeout: 120000,
  });
  const frames = [];
  for (const control of framesToCapture.filter(
    (c) => !process.argv[3] || c.kind === process.argv[3],
  )) {
    const result = await page.evaluate(
      (control) => (window as any).__SUPPORT_PREVIEW__.frame(control),
      control,
    );
    await page.screenshot({ path: join(output, `${control.kind}.png`) });
    frames.push({ ...control, ...result });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, process.argv[3] ? 'preview-extra-report.json' : 'preview-report.json'),
    JSON.stringify(
      {
        status: 'passed',
        mapVersion: manifest.mapVersion,
        browser: browser.version(),
        frames,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  await page.evaluate(() => (window as any).__SUPPORT_PREVIEW__.dispose());
} finally {
  await browser.close();
  await server.close();
}
