import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchTestBrowser } from './helpers/browser.js';

// Isolate the cost of eight moving visual rigs. This is not a network load test.
const output = 'output/playwright/avatars';
const html = `<!doctype html><html><body style="margin:0">
<canvas style="width:1280px;height:720px;display:block"></canvas><div id="labels"></div>
<script type="module">
import { WorldView } from '/apps/client/src/rendering/world-view.ts';
import { physicsFixture } from '/packages/simulation/src/test-fixture.ts';
import { ANIMATIONS } from '/packages/contracts/src/index.ts';
const view = new WorldView(document.querySelector('canvas'), document.querySelector('#labels'), physicsFixture());
const colors = ['#65d6bc','#e5b867','#cb93db','#79b6ed'];
const entities = Array.from({length:8}, (_,i) => ({
  entityId:'avatar-'+i, kind:'player', revision:0, motionRevision:0, motionEnabled:true,
  grounded:true, name:'Игрок '+i, color:colors[i%4],
  skinId:i%2?'standard':'minifigure',
  position:{x:0,y:.915,z:0}, rotation:{x:0,y:0,z:0,w:1},
  velocity:{x:0,y:0,z:0}, angularVelocity:{x:0,y:0,z:0}
}));
let time = 0;
view.onFrame((now,delta) => {
  time += delta;
  entities.forEach((entity,i) => {
    const angle = time*4/1.4+i*.3;
    const yaw = Math.atan2(-Math.sin(angle),Math.cos(angle));
    entity.position = {x:(i%4-1.5)*4+1.4*Math.cos(angle),y:.915,z:(Math.floor(i/4)-.5)*6+1.4*Math.sin(angle)};
    entity.velocity = {x:-4*Math.sin(angle),y:0,z:4*Math.cos(angle)};
    entity.rotation = {x:0,y:Math.sin(yaw/2),z:0,w:Math.cos(yaw/2)};
    const selected = ANIMATIONS.find(a => a.id === window.avatarProfileAnimation);
    entity.animation = selected ? {worldEpoch:'profile', animationId:selected.id,
      sequence:Math.floor(time*1000/selected.durationMs), startedAtTick:0,
      endsAtTick:selected.durationMs*.06, changedAtTick:0,
      displayTick:(time*1000%selected.durationMs)*.06, displayTimeMs:time*1000} : undefined;
  });
  view.update(entities,'avatar-0',delta);
});
window.avatarProfile = view;
</script></body></html>`;

const gallery = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#101820;color:white;font:18px sans-serif">
<div style="position:absolute;top:12px;width:100%;display:flex;justify-content:space-around"><span>Помахать рукой</span><span>Хлопать</span><span>Танцевать</span></div>
<canvas style="width:1200px;height:800px;display:block"></canvas>
<script type="module" src="/tests/helpers/animation-gallery.ts"></script></body></html>`;

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'isolated-avatar-profile',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== '/avatar-profile' && request.url !== '/animation-gallery')
            return next();
          response.setHeader('content-type', 'text/html');
          response.end(request.url === '/animation-gallery' ? gallery : html);
        });
      },
    },
  ],
});
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
try {
  await server.listen();
  browser = await launchTestBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls!.local[0]}avatar-profile`);
  await page.waitForFunction(() => Boolean((window as any).avatarProfile));
  const profiles: {
    quality: string;
    animation: string;
    median: number;
    p95: number;
    samples: number;
    rendering: Record<string, unknown>;
  }[] = [];
  for (const quality of process.argv.includes('--gallery-only') ? [] : ['standard', 'economy']) {
    await page.evaluate((quality) => (window as any).avatarProfile.setQuality(quality), quality);
    await page.waitForTimeout(1500);
    for (const animation of ['base', 'wave', 'clap', 'dance']) {
      await page.evaluate((animation) => {
        (window as any).avatarProfileAnimation = animation;
      }, animation);
      await page.waitForTimeout(500);
      // Raw browser JavaScript avoids tsx function-name helpers inside evaluate.
      const timing = await page.evaluate<{
        median: number;
        p95: number;
        samples: number;
        rendering: Record<string, unknown>;
      }>(`new Promise(resolve => {
      const start = performance.now();
      let previous = start;
      const samples = [];
      function frame(now) {
        samples.push(now-previous);
        previous = now;
        if (now-start > 3000) {
          samples.sort((a,b) => a-b);
          resolve({median:samples[Math.floor(samples.length*.5)],p95:samples[Math.floor(samples.length*.95)],samples:samples.length,rendering:window.avatarProfile.renderingDiagnostics()});
        } else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    })`);
      assert.ok(timing.samples >= 10);
      profiles.push({ quality, animation, ...timing });
    }
  }
  await mkdir(output, { recursive: true });
  await mkdir('output/playwright/animations', { recursive: true });
  await page.screenshot({ path: `${output}/profile.png` });
  for (const quality of process.argv.includes('--gallery-only') ? [] : ['standard', 'economy']) {
    const baseline = profiles.find(
      (p) => p.quality === quality && p.animation === 'base',
    )!.rendering;
    for (const profile of profiles.filter((p) => p.quality === quality)) {
      for (const field of ['meshes', 'materials', 'transformNodes', 'drawCalls'])
        assert.equal(
          profile.rendering[field],
          baseline[field],
          `${quality}/${profile.animation}: ${field}`,
        );
    }
  }
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${server.resolvedUrls!.local[0]}animation-gallery`);
  await page.waitForFunction(() => (window as any).galleryReady);
  await page.waitForFunction(() => (window as any).galleryDiagnostics().active > 0);
  for (const [name, ms] of [
    ['contact', 825],
    ['open', 1100],
  ] as const) {
    await page.evaluate((ms) => (window as any).galleryPose(ms), ms);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `output/playwright/animations/gallery-${name}.png` });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    browser: browser.version(),
    experiment: profiles.length
      ? 'isolated eight moving avatars, both skins, base/wave/clap/dance, SwiftShader, 1280x720; not hardware acceptance'
      : 'six static clip poses on both skins, SwiftShader, 1200x800',
    profiles,
    errors,
  };
  await writeFile(
    profiles.length ? `${output}/profile.json` : 'output/playwright/animations/gallery.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
