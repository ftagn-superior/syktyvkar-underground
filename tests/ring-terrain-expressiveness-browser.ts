/** Actual client rendering/streaming of an immutable release; no database or game server. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createServer } from 'vite';
import { readAuthoringRelease } from '../apps/server/src/layout/release.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { readWorldDirectory } from '../apps/server/src/world-bundle.js';
import { launchTestBrowser } from './helpers/browser.js';

const directory = resolve(process.argv[2] ?? 'output/terrain-expressiveness/candidate-world');
const output = resolve(process.argv[3] ?? 'output/playwright/terrain-expressiveness');
const publishedDirectory = resolve(
  process.argv[4] ?? join(dirname(directory), 'candidate-published'),
);
const rel = relative(directory, output);
const publicRelative = relative(publishedDirectory, output);
assert.ok(
  publicRelative === '..' || publicRelative.startsWith('..' + sep),
  'Evidence must be outside runtime publication',
);
assert.ok(rel === '..' || rel.startsWith('..' + sep), 'Evidence must be outside immutable release');
await mkdir(output, { recursive: true });
const authored = await readAuthoringRelease(directory);
const published = await readWorldDirectory(publishedDirectory);
assert.ok(
  authored.terrain && published.manifest.graphics,
  'Requires canonical terrain and near/far',
);
const wasm = await loadServerWasm();
const scenes = [
  {
    name: '01-dimitrova-overview',
    label: 'Димитрова → Морозова',
    x: -148.9,
    z: 563.47,
    towardX: -608.31,
    towardZ: 827.86,
    firstPerson: false,
    zoom: 3,
  },
  {
    name: '02-dimitrova-first-person',
    label: 'Димитрова → Морозова',
    x: 47.68,
    z: 450.47,
    towardX: -264.7,
    towardZ: 630.1,
    firstPerson: true,
    zoom: 1,
  },
  {
    name: '03-oplesnina-overview',
    label: 'Оплеснина / баня №4',
    x: -232.28,
    z: -591.67,
    towardX: -50,
    towardZ: -650,
    firstPerson: false,
    zoom: 3,
  },
  {
    name: '04-oplesnina-first-person',
    label: 'Оплеснина / баня №4',
    x: -436.06,
    z: -555.93,
    towardX: -50,
    towardZ: -650,
    firstPerson: true,
    zoom: 1,
  },
  {
    name: '05-river-overview',
    label: 'Спуск к Сысоле',
    x: 756.42,
    z: -376.32,
    towardX: 1397.86,
    towardZ: -705.28,
    firstPerson: false,
    zoom: 3,
  },
  {
    name: '06-river-first-person',
    label: 'Спуск к Сысоле',
    x: 671.78,
    z: -335.16,
    towardX: 853.81,
    towardZ: -423.9,
    firstPerson: true,
    zoom: 1,
  },
  {
    name: '07-city-near-far',
    preview: true,
    label: 'Крупные формы города',
    x: 250,
    z: -100,
    towardX: 1000,
    towardZ: -100,
    firstPerson: false,
    zoom: 30,
  },
];
const selectedScenes = process.env.SU_TERRAIN_SCENES?.split(',');
const activeScenes = selectedScenes
  ? scenes.filter((scene) => selectedScenes.includes(scene.name))
  : scenes;
assert.ok(activeScenes.length, 'No matching terrain camera scenes');
const browserModule = String.raw`
import { loadWorldHeader, sampleTerrain } from '/packages/contracts/src/index.ts';
import { createPhysicsWorld } from '/packages/simulation/src/physics-world.ts';
import { WorldView } from '/apps/client/src/rendering/world-view.ts';
import { CellStreamer } from '/apps/client/src/streaming/cells.ts';
import { VerifiedResources } from '/apps/client/src/streaming/resources.ts';
const manifest=await(await fetch('/expressive-manifest')).json();
const grid=await(await fetch('/expressive-grid')).json();
const resources=new VerifiedResources(manifest,'/expressive-assets/');
const header=await loadWorldHeader(manifest,p=>resources.read(p));
const world=await createPhysicsWorld(header,await(await fetch('/expressive-wasm')).arrayBuffer(),true);
document.body.style.cssText='margin:0;overflow:hidden;background:#101820';
const canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:100vw;height:100vh';document.body.append(canvas);
const labels=document.createElement('div');document.body.append(labels);
const caption=document.createElement('div');caption.style.cssText='position:absolute;left:16px;top:16px;padding:8px 12px;background:#fffffff0;color:#172b34;font:16px system-ui;pointer-events:none';document.body.append(caption);
const view=new WorldView(canvas,labels,header,'economy');view.setTimeOfDay(12);view.setWeatherOverride({clouds:false,precipitation:'none',fog:false});
const stream=new CellStreamer(manifest,resources,world,view);
let stopped=false,eye,frames=[];
view.onFrame((now,delta)=>{
  if(stopped)return;
  view.update([],undefined,delta,eye);
  const area=view.graphicalArea();stream.setVisualArea(area.center,area.drawRadius);stream.pump();
  view.setStreamingRadius(stream.graphicsReadyRadius(area.center,area.drawRadius));frames.push(delta*1000);
});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function focus(scene){
  const {x,z,towardX,towardZ,zoom,firstPerson,label,preview=false}=scene;
  const surface=sampleTerrain(grid,x,z);if(!surface)throw new Error('Camera outside canonical grid');
  const y=surface.height,center={x,y:y+header.simulation.character.height/2,z};
  eye=firstPerson?center:undefined;view.setFirstPerson(false);
  view.target.set(x,y,z);view.scene.activeCamera.setTarget(view.target,false,false,true);
  const yaw=Math.atan2(towardX-x,towardZ-z);view.cameraOrbit.setAngle(-Math.PI/2-yaw);
  view.zoom=zoom;view.sizeCamera();view.scene.activeCamera.beta=.8;
  view.setFirstPerson(firstPerson);view.update([],undefined,0,eye);
  caption.textContent=label+' · '+(firstPerson?'от первого лица':'игровая обзорная камера')+' · S-45';
  await delay(100);
  const area=view.graphicalArea();stream.setVisualArea(area.center,area.drawRadius);
  if(preview)stream.setPreview(center,area.drawRadius);else stream.setPreparationArea(center);
  const started=performance.now();
  while((!preview&&!stream.criticalReady)||!stream.backgroundReady){
    if(stream.backgroundProblem||stream.problem)throw new Error(stream.backgroundProblem||stream.problem);
    if(performance.now()-started>240000){const d=stream.diagnostics();throw new Error('Streaming timeout: '+JSON.stringify({criticalReady:d.criticalReady,backgroundReady:d.backgroundReady,error:d.error,graphicsRequired:d.graphicsRequired.length,graphicsActive:d.graphicsActive.length,physicsRequired:d.physicsRequired.length,physicsActive:d.physicsActive.length,groupsWaiting:d.groups.filter(g=>g.wanted!==g.current||g.error).slice(0,10),pendingPhysics:d.physicsRequired.filter(id=>!d.physicsActive.includes(id))}));}
    await delay(100);
  }
  frames=[];await delay(1000);
  const d=stream.diagnostics();
  if(d.failed||d.cleanupErrors||d.error||(!preview&&!d.criticalReady)||!d.backgroundReady)throw new Error('Streaming failed after readiness');
  if(!d.graphicsRequired.every(id=>d.graphicsActive.includes(id)))throw new Error('Missing visible graphics cells');
  if(d.groups.some(g=>g.wanted&&g.current!==g.wanted||g.error))throw new Error('Incomplete near/far transition');
  const hit=preview?undefined:world.surfaceRay({x,y:y+100,z},{x,y:grid.bottom+.001,z});
  if(!preview){if(!hit)throw new Error('Missing collision at camera');
  if(Math.abs(hit.point.y-y)>.05)throw new Error('Camera control is occluded or differs from canonical ground: '+JSON.stringify({expected:y,hit}));}
  const sorted=[...frames].sort((a,b)=>a-b);
  return {physicsScope:preview?'graphics-only city preview':'player-pinned route view with streamed physics',position:{x,y,z},camera:{firstPerson,zoom,yaw,eyeHeight:firstPerson?header.simulation.character.height-.2:undefined},hit,
    groups:{near:d.groups.filter(g=>g.current==='near').length,far:d.groups.filter(g=>g.current==='far').length},
    rendering:view.renderingDiagnostics(),physics:world.staticDiagnostics(),physicsCells:d.physicsActive.length,graphicsCells:d.graphicsActive.length,
    frames:frames.length,frameP95Ms:sorted[Math.ceil(sorted.length*.95)-1],criticalReadyRequired:!preview,criticalReady:d.criticalReady,backgroundReady:d.backgroundReady};
}
window.__EXPRESSIVENESS__={focus,diagnostics:()=>stream.diagnostics(),async dispose(){stopped=true;stream.dispose();await delay(100);const remaining=world.staticDiagnostics();world.dispose();view.dispose();return remaining;}};
`;
const server = await createServer({
  root: process.cwd(),
  configFile: false,
  logLevel: 'error',
  cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  optimizeDeps: {
    entries: [
      'apps/client/src/rendering/world-view.ts',
      'apps/client/src/streaming/cells.ts',
      'apps/client/src/streaming/resources.ts',
      'packages/simulation/src/physics-world.ts',
    ],
  },
  plugins: [
    {
      name: 'terrain-expressiveness-evidence',
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = new URL(req.url ?? '/', 'http://localhost').pathname;
          try {
            if (path === '/expressive-preview') {
              res.setHeader('content-type', 'text/html');
              res.end(
                '<!doctype html><title>S-45 terrain evidence</title><link rel="icon" href="data:,"><script type="module" src="/expressive-preview.js"></script>',
              );
            } else if (path === '/expressive-preview.js') {
              res.setHeader('content-type', 'text/javascript');
              res.end(browserModule);
            } else if (path === '/expressive-manifest') res.end(JSON.stringify(published.manifest));
            else if (path === '/expressive-grid') res.end(JSON.stringify(authored.terrain!.grid));
            else if (path === '/expressive-wasm') res.end(wasm);
            else if (path.startsWith('/expressive-assets/')) {
              const file = path.slice('/expressive-assets/'.length);
              if (!Object.hasOwn(published.manifest.files, file)) {
                res.statusCode = 404;
                res.end();
                return;
              }
              res.end(await readFile(join(publishedDirectory, file)));
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
const errors: string[] = [],
  samples: unknown[] = [];
let remaining: unknown;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
try {
  browser = await launchTestBrowser({ renderer: 'software' });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
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
  await page.goto(server.resolvedUrls!.local[0] + 'expressive-preview');
  await page.waitForFunction(() => !!(window as any).__EXPRESSIVENESS__, undefined, {
    timeout: 180000,
  });
  for (const scene of activeScenes) {
    console.log(JSON.stringify({ status: 'camera-started', name: scene.name }));
    const result = await page.evaluate((s) => (window as any).__EXPRESSIVENESS__.focus(s), scene);
    if (scene.name === '07-city-near-far') {
      assert.ok(result.groups.far > 0, 'City witness must activate actual far groups');
    } else assert.ok(result.groups.near > 0, 'Route witness must retain player-pinned near groups');
    samples.push({ name: scene.name, ...result });
    await page.screenshot({ path: join(output, scene.name + '.png') });
    console.log(
      JSON.stringify({ name: scene.name, position: result.position, groups: result.groups }),
    );
    await writeFile(
      join(output, 'result.json'),
      JSON.stringify({ status: 'running', samples, errors }, null, 2) + '\n',
    );
  }
  remaining = await page.evaluate(() => (window as any).__EXPRESSIVENESS__.dispose());
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(
    (remaining as { bodies: number }).bodies,
    0,
    'Stream disposal must release physical bodies',
  );
  assert.equal(
    (remaining as { references: number }).references,
    0,
    'Stream disposal must release physical references',
  );
  const result = {
    status: 'passed',
    scope:
      'Actual runtime publication of the authoring seed, including derived supports; real WorldView and CellStreamer, stationary route witnesses. Not a production-state migration or owner acceptance.',
    mapVersion: published.manifest.mapVersion,
    authoringMapVersion: authored.manifest.mapVersion,
    publishedDirectory,
    assetReleaseVersion: authored.metadata.assetReleaseVersion,
    viewport: { width: 1280, height: 720 },
    renderer: 'software',
    quality: 'economy',
    samples,
    remaining,
    errors,
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'failed',
        samples,
        errors,
        failure: error instanceof Error ? error.stack : String(error),
        remaining,
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
