/** Real WorldView + streamed collision at old/new terrain locations. No DB or game server. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { readAuthoringRelease } from '../apps/server/src/layout/release.js';
import { launchTestBrowser } from './helpers/browser.js';

const directory = resolve(process.argv[2] ?? 'output/ring-terrain-expansion/candidate-world');
const output = resolve('output/ring-terrain-expansion/browser');
await mkdir(output, { recursive: true });
const release = await readAuthoringRelease(directory);
const manifest = release.manifest;
const wasm = await loadServerWasm();
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
const view=new WorldView(canvas,labels,header,'standard');view.setTimeOfDay(12);
const stream=new CellStreamer(manifest,resources,world,view);
let stopped=false, frames=[];
view.onFrame((now,delta)=>{
  if(stopped)return;
  const area=view.graphicalArea();stream.setVisualArea(area.center,area.drawRadius);stream.pump();
  view.setStreamingRadius(stream.graphicsReadyRadius(area.center,area.drawRadius));frames.push(delta*1000);
});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function focus(x,z){
  const y=sampleTerrain(grid,x,z).height;
  view.target.set(x,y,z);view.scene.activeCamera.setTarget(view.target,false,false,true);
  stream.setArea({x,y,z});await delay(250);
  const started=performance.now();
  while(!stream.criticalReady||!stream.backgroundReady){
    if(stream.backgroundProblem)throw new Error(stream.backgroundProblem);
    if(performance.now()-started>120000)throw new Error('Terrain streaming timeout');
    await delay(50);
  }
  const hit=world.surfaceRay({x,y:y+3,z},{x,y:y-3,z});
  // Inside the old city a ray may hit a building/podium above the bare terrain.
  if((x < -269 || x > 331 || z < -745 || z > 131) && (!hit||Math.abs(hit.point.y-y)>.02))
    throw new Error('Streamed terrain is missing at '+x+','+z);
  frames=[];await delay(3000);
  const d=stream.diagnostics();
  return {focus:{x,y,z},hit,rendering:view.renderingDiagnostics(),
    graphicsCells:d.graphicsActive.length,physics:world.staticDiagnostics(),
    frames:frames.length,frameMaxMs:Math.max(...frames),backgroundReady:stream.backgroundReady};
}
await focus(0,0);
window.__EXPANSION__={focus,async dispose(){stopped=true;stream.dispose();await delay(100);const remaining=world.staticDiagnostics();world.dispose();view.dispose();return remaining;}};
`;
const server = await createServer({
  root: process.cwd(),
  configFile: false,
  logLevel: 'error',
  cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'terrain-expansion-preview',
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = new URL(req.url ?? '/', 'http://localhost').pathname;
          try {
            if (path === '/terrain-preview') {
              res.setHeader('content-type', 'text/html');
              res.end(
                '<!doctype html><title>Expanded ring terrain</title><script type="module" src="/terrain-preview.js"></script>',
              );
            } else if (path === '/terrain-preview.js') {
              res.setHeader('content-type', 'text/javascript');
              res.end(browserModule);
            } else if (path === '/terrain-manifest') res.end(JSON.stringify(manifest));
            else if (path === '/terrain-grid') res.end(JSON.stringify(release.terrain!.grid));
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
console.log('Local terrain preview server ready');
const browser = await launchTestBrowser({ renderer: 'default', channel: 'chromium' });
const errors: string[] = [];
const samples = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(m.text());
  });
  console.log('Chromium preview ready');
  await page.goto(server.resolvedUrls!.local[0] + 'terrain-preview');
  await page.waitForFunction(() => !!(window as any).__EXPANSION__, undefined, { timeout: 180000 });
  // Exercise the ordinary UI zoom range, including broad views of the blank extension.
  await page.mouse.move(960, 540);
  await page.mouse.wheel(0, Math.log(8) * 1000);
  for (const [name, x, z] of [
    ['ring', 0, 0],
    ['west', -1000, 0],
    ['join', 331, 0],
    ['east', 1450, 0],
    ['north', 0, -800],
    ['south', 0, 600],
  ] as const) {
    const result = await page.evaluate(
      ([x, z]) => (window as any).__EXPANSION__.focus(x, z),
      [x, z],
    );
    samples.push({ name, ...result });
    await page.screenshot({ path: join(output, name + '.png') });
    console.log(JSON.stringify({ name, focus: result.focus, graphicsCells: result.graphicsCells }));
  }
  const remaining = await page.evaluate(() => (window as any).__EXPANSION__.dispose());
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        mapVersion: manifest.mapVersion,
        scope:
          'Render/streaming smoke check, synthetic camera moves; no network game or sustained FPS measurement',
        browser: browser.version(),
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
    join(output, 'failure.json'),
    JSON.stringify({ error: String(error), errors }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await server.close();
}
