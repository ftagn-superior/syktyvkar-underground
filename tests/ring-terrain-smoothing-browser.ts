/** Exact saved-layout render/streaming witness. No database, room or saved-state access. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { readAuthoringRelease } from '../apps/server/src/layout/release.js';
import { readWorldDirectory } from '../apps/server/src/world-bundle.js';
import { hash } from '../packages/world-release/src/index.js';
import { launchTestBrowser } from './helpers/browser.js';

const base = resolve(process.argv[2] ?? 'output/terrain-smoothing-20261114');
const directory = join(base, 'export-world');
const output = join(base, 'browser');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'running' }) + '\n');
// Read and hash-check the exact publication with the adapted saved objects, not its seed.
const published = await readWorldDirectory(directory);
const authored = await readAuthoringRelease(join(base, 'authoring-world'));
assert.ok(authored.terrain, 'Smoothing authoring release must include its private terrain');
assert.equal(published.definition.worldId, authored.definition.worldId);
assert.deepEqual(published.definition.bounds, authored.definition.bounds);
const manifest = published.manifest;
const manifestSha256 = hash(await readFile(join(directory, 'manifest.json')));
const wasm = await loadServerWasm();
const scenes = [
  { name: '01-ring', label: 'Кольцо «Трудовая слава»', x: 0, z: 0, zoom: 7, beta: 0.8 },
  { name: '02-syktsu', label: 'СыктГУ', x: -105, z: -158, zoom: 5, beta: 0.9 },
  { name: '03-bath4', label: 'Оплеснина / баня №4', x: -168.27, z: -545.6, zoom: 9, beta: 0.8 },
  { name: '04-house-of-services', label: 'Дом быта', x: 587.99, z: -351.04, zoom: 10, beta: 0.8 },
  { name: '05-stadium', label: 'Центральный стадион', x: 598.06, z: -57.92, zoom: 10, beta: 0.8 },
  { name: '06-dimitrova', label: 'Подъём по Димитрова', x: -250, z: 620, zoom: 23, beta: 0.65 },
  // This last authoring camera intentionally exceeds the ordinary UI zoom limit of 30.
  { name: '07-overview', label: 'Общий вид всей карты', x: 250, z: 0, zoom: 70, beta: 0.45 },
];
const browserModule = String.raw`
import { loadWorldHeader, sampleTerrain } from '/packages/contracts/src/index.ts';
import { createPhysicsWorld } from '/packages/simulation/src/physics-world.ts';
import { WorldView } from '/apps/client/src/rendering/world-view.ts';
import { CellStreamer } from '/apps/client/src/streaming/cells.ts';
import { VerifiedResources } from '/apps/client/src/streaming/resources.ts';
const manifest = await (await fetch('/terrain-manifest')).json();
const grid = await (await fetch('/terrain-grid')).json();
const resources = new VerifiedResources(manifest, '/terrain-assets/');
const header = await loadWorldHeader(manifest, path => resources.read(path));
const world = await createPhysicsWorld(header, await (await fetch('/terrain-wasm')).arrayBuffer(), true);
document.body.style.cssText='margin:0;overflow:hidden;background:#101820';
const canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:100vw;height:100vh';
document.body.append(canvas);
const labels=document.createElement('div');document.body.append(labels);
const caption=document.createElement('div');caption.style.cssText='position:absolute;left:24px;top:20px;padding:10px 16px;background:#ffffffdf;color:#172b34;font:18px system-ui;border-radius:4px;pointer-events:none';document.body.append(caption);
const view=new WorldView(canvas,labels,header,'standard');view.setTimeOfDay(12);
view.setWeatherOverride({clouds:false,precipitation:'none',fog:false});
const stream=new CellStreamer(manifest,resources,world,view);
let stopped=false, frames=[];
view.onFrame((now,delta)=>{
  if(stopped)return;
  const area=view.graphicalArea();stream.setVisualArea(area.center,area.drawRadius);stream.pump();
  view.setStreamingRadius(stream.graphicsReadyRadius(area.center,area.drawRadius));frames.push(delta*1000);
});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function focus(scene){
  const {x,z,zoom,beta,label}=scene;
  const surface=sampleTerrain(grid,x,z);
  if(!surface)throw new Error('Focus outside approved terrain');
  const y=surface.height;
  caption.textContent=label+' · сглаженный рельеф · текущие объекты';
  view.target.set(x,y,z);view.scene.activeCamera.setTarget(view.target,false,false,true);
  view.zoom=zoom;view.sizeCamera();view.cameraOrbit.setAngle(-Math.PI/2);view.scene.activeCamera.beta=beta;
  stream.setArea({x,y,z});
  const area=view.graphicalArea();stream.setVisualArea(area.center,area.drawRadius);
  await delay(250);
  const started=performance.now();
  while(!stream.criticalReady||!stream.backgroundReady){
    if(stream.backgroundProblem||stream.problem)throw new Error(stream.backgroundProblem||stream.problem);
    if(performance.now()-started>180000)throw new Error('Terrain streaming timeout: '+JSON.stringify(stream.diagnostics()));
    await delay(50);
  }
  frames=[];await delay(2500);
  const d=stream.diagnostics();
  if(d.failed||d.cleanupErrors||d.error||!d.criticalReady||!d.backgroundReady)throw new Error('Terrain streaming failed after readiness');
  if(!d.graphicsRequired.every(id=>d.graphicsActive.includes(id)))throw new Error('Incomplete visible terrain cells');
  const hit=world.surfaceRay({x,y:y+100,z},{x,y:grid.bottom+.001,z});
  if(!hit)throw new Error('Missing streamed collision under focus '+x+','+z);
  const samples=[...frames].sort((a,b)=>a-b);
  return {focus:{x,y,z},camera:{zoom,beta},hit,rendering:view.renderingDiagnostics(),
    graphicsCells:d.graphicsActive.length,graphicsRequired:d.graphicsRequired.length,
    physicsCells:d.physicsActive.length,physics:world.staticDiagnostics(),
    frames:frames.length,frameMaxMs:Math.max(...frames),frameP95Ms:samples[Math.ceil(samples.length*.95)-1],
    criticalReady:d.criticalReady,backgroundReady:d.backgroundReady,streamingErrors:d.cells.filter(c=>c.error)};
}
window.__SMOOTHING__={focus,async dispose(){stopped=true;stream.dispose();await delay(100);const remaining=world.staticDiagnostics();world.dispose();view.dispose();return remaining;}};
`;
const server = await createServer({
  root: process.cwd(),
  configFile: false,
  logLevel: 'error',
  cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'terrain-smoothing-preview',
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = new URL(req.url ?? '/', 'http://localhost').pathname;
          try {
            if (path === '/terrain-preview') {
              res.setHeader('content-type', 'text/html');
              res.end(
                '<!doctype html><title>Smoothed ring terrain</title><link rel="icon" href="data:,"><script type="module" src="/terrain-preview.js"></script>',
              );
            } else if (path === '/terrain-preview.js') {
              res.setHeader('content-type', 'text/javascript');
              res.end(browserModule);
            } else if (path === '/terrain-manifest') res.end(JSON.stringify(manifest));
            else if (path === '/terrain-grid') res.end(JSON.stringify(authored.terrain!.grid));
            else if (path === '/terrain-wasm') res.end(wasm);
            else if (path.startsWith('/terrain-assets/')) {
              const file = path.slice('/terrain-assets/'.length);
              if (!Object.hasOwn(manifest.files, file)) {
                res.statusCode = 404;
                res.end();
                return;
              }
              res.end(await readFile(join(directory, file)));
            } else next();
          } catch (error) {
            res.statusCode = 500;
            res.end(String(error));
          }
        });
      },
    },
  ],
});
await server.listen();
console.log('Exact smoothed-layout preview server ready');
const errors: string[] = [];
const samples: unknown[] = [];
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
try {
  browser = await launchTestBrowser({ renderer: 'default', channel: 'chromium' });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText;
    if (failure && failure !== 'net::ERR_ABORTED') errors.push(`${failure}: ${request.url()}`);
  });
  await page.goto(server.resolvedUrls!.local[0] + 'terrain-preview');
  await page.waitForFunction(() => !!(window as any).__SMOOTHING__, undefined, { timeout: 180000 });
  for (const scene of scenes) {
    const result = await page.evaluate(
      (scene) => (window as any).__SMOOTHING__.focus(scene),
      scene,
    );
    samples.push({ name: scene.name, label: scene.label, ...result });
    await page.screenshot({ path: join(output, scene.name + '.png') });
    console.log(
      JSON.stringify({
        name: scene.name,
        focus: result.focus,
        graphicsCells: result.graphicsCells,
      }),
    );
  }
  const remaining = await page.evaluate(() => (window as any).__SMOOTHING__.dispose());
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        mapVersion: manifest.mapVersion,
        manifestSha256,
        exportDirectory: directory,
        authoringDirectory: authored.directory,
        databaseAccess: false,
        scope:
          'Exact saved-layout render and streaming smoke; synthetic authoring cameras, no gameplay session or sustained FPS acceptance. Overview zoom 70 exceeds normal UI range.',
        browser: browser.version(),
        weather: 'clear (local visual inspection override)',
        samples,
        remaining,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'failed',
        mapVersion: manifest.mapVersion,
        manifestSha256,
        error: String(error),
        errors,
        samples,
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
