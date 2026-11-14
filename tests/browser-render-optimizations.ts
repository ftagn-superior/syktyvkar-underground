import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { launchTestBrowser } from './helpers/browser.js';

const output = resolve('output/playwright/render-optimizations');
await mkdir(output, { recursive: true });
await build({
  entryPoints: ['tests/fixtures/render-optimizations-scene.ts'],
  outfile: `${output}/app.js`,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
const app = await readFile(`${output}/app.js`);
const server = createServer((request, response) => {
  if (request.url === '/app.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(app);
  } else if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      '<!doctype html><style>body{margin:0}canvas{display:block}</style><canvas width="640" height="480"></canvas><script type="module" src="/app.js"></script>',
    );
  } else {
    response.writeHead(404);
    response.end();
  }
});
const browser = await launchTestBrowser();
const errors: string[] = [];
const result: Record<string, unknown> = {};
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => (window as any).__RENDER_OPTIMIZATIONS__);
  const call = (method: string, ...args: unknown[]) =>
    page.evaluate(({ method, args }) => (window as any).__RENDER_OPTIMIZATIONS__[method](...args), {
      method,
      args,
    });
  if (process.argv.includes('--chunks-only')) {
    const chunks = await call('buildingChunks');
    result.buildingChunks = chunks;
    for (const comparison of chunks.comparisons) {
      assert.ok(comparison.mergedCalls < comparison.originalCalls / 2, JSON.stringify(comparison));
      assert.equal(comparison.originalsEnabled, 0);
      assert.ok(comparison.changed < 0.01, JSON.stringify(comparison));
    }
    assert.equal(chunks.restored, true);
  } else {
    result.initial = await call('warmup');
    await call('snapshot', 'opaque');
    await page.screenshot({ path: `${output}/opaque.png` });
    await call('shadows', false);
    await call('frames', 15);
    await call('snapshot', 'unshadowed');
    await page.screenshot({ path: `${output}/unshadowed.png` });
    result.shadowDifference = await call('compare', 'opaque');
    const maskPixels = await call('markShadowMask');
    result.maskPixels = maskPixels;
    assert.ok(maskPixels > 100, `shadow reference must cover enough ground pixels: ${maskPixels}`);
    await call('shadows', true);
    const base = await call('frames', 15);
    assert.equal(base.webglVersion, 2);
    await call('snapshot', 'baseline');
    await page.screenshot({ path: `${output}/baseline.png` });

    await call('reject', true);
    await call('follow', 20, -10);
    const held = await call('frames', 1);
    const heldPixels = await call('compare', 'baseline');
    result.held = { base, held, heldPixels };
    assert.equal(held.staticDiscarded, base.staticDiscarded + 1);
    assert.deepEqual(
      held.lightPosition,
      base.lightPosition,
      'rejected map must retain its matching projection',
    );
    assert.ok(
      heldPixels.changed < 0.0001,
      `incomplete map became visible: ${JSON.stringify(heldPixels)}`,
    );
    await page.screenshot({ path: `${output}/held.png` });

    await call('reject', false);
    const recovered = await call('frames', 15);
    assert.notDeepEqual(
      recovered.lightPosition,
      base.lightPosition,
      'ready map must publish the requested projection',
    );
    assert.equal(recovered.staticDiscarded, held.staticDiscarded);
    result.recovery = recovered;

    await call('reject', true);
    await call('hour', 15);
    const beforeTurn = await call('stats');
    const turnedHeld = await call('frames', 1);
    assert.deepEqual(
      turnedHeld.lightDirection,
      recovered.lightDirection,
      'failed sun turn must use the held projection',
    );
    assert.notDeepEqual(beforeTurn.lightDirection, turnedHeld.lightDirection);
    await call('reject', false);
    const turned = await call('frames', 15);
    assert.notDeepEqual(turned.lightDirection, recovered.lightDirection);
    result.sunTurn = { turnedHeld, turned };

    await call('reject', true);
    const fallback = await call('frames', 7);
    assert.ok(
      fallback.staticFallbacks > turned.staticFallbacks,
      'permanently unready caster must not freeze shadows indefinitely',
    );
    await call('reject', false);
    await call('frames', 15);
    result.fallback = fallback;

    if (!process.argv.includes('--shadows-only')) {
      await call('hour', 12);
      await call('follow', 0, 0);
      await call('frames', 15);
      await call('alpha', 0.25);
      await call('frames', 20);
      const transparent = await call('compare', 'opaque', true);
      assert.ok(
        transparent.mean < 4,
        `transparent house lost its ground shadow: ${JSON.stringify(transparent)}`,
      );
      result.transparent = { maskPixels, transparent };
      await page.screenshot({ path: `${output}/transparent.png` });
      await call('alpha', 1);

      const extents = [];
      for (const [width, expected] of [
        [0, 90],
        [100, 180],
        [220, 360],
        [600, 720],
      ]) {
        await call('follow', 0, 0, width);
        const state = await call('frames', 15);
        assert.equal(state.extent, expected);
        extents.push({ width, ...state });
      }
      for (const firstPerson of [true, false, true]) {
        await call('firstPerson', firstPerson);
        const before = await call('stats');
        const state = await call('frames', 1);
        assert.equal(state.extent, firstPerson ? 90 : 720);
        assert.equal(
          state.shadowPasses - before.shadowPasses,
          1,
          'camera switch must render one composed map',
        );
      }
      result.extents = extents;
      const chunks = await call('buildingChunks');
      for (const comparison of chunks.comparisons) {
        assert.ok(
          comparison.mergedCalls < comparison.originalCalls / 2,
          `distant houses did not reduce draw calls: ${JSON.stringify(comparison)}`,
        );
        assert.equal(comparison.originalsEnabled, 0);
        assert.ok(
          comparison.changed < 0.01,
          `merged house appearance changed at hour ${comparison.hour}: ${JSON.stringify(comparison)}`,
        );
      }
      assert.equal(chunks.restored, true, 'near houses must restore individual meshes');
      result.buildingChunks = chunks;
    }
  }
  result.final = await call('stats');
  assert.deepEqual((result.final as { gpuErrors: number[] }).gpuErrors, []);
  assert.deepEqual(errors, []);
  await call('dispose');
  console.log(
    JSON.stringify(
      { passed: Object.keys(result), report: `${output}/result.json`, errors },
      null,
      2,
    ),
  );
} finally {
  await writeFile(`${output}/result.json`, JSON.stringify({ ...result, errors }, null, 2));
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
