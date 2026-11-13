import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { build } from 'esbuild';
import { launchTestBrowser } from './helpers/browser.js';
import { generateKit, type KitRecipe } from '../tools/world-build/src/kit.js';
import { encodeStaticGlb, inspectStaticGlb } from '../tools/world-build/src/glb.js';

const output = resolve('output/playwright/static-glb-instancing');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: ['tests/fixtures/static-glb-scene.ts'],
  outfile: `${output}/app.js`,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
const payloads = new Map<string, Uint8Array>();
const assets: Record<string, unknown> = {},
  references: Record<string, unknown> = {};
const catalog = JSON.parse(await readFile('content/buildings/ring-block/catalog.json', 'utf8'));
for (const [id, path] of Object.entries(catalog.assets) as [string, string][]) {
  const directory = `content/buildings/ring-block/${dirname(path)}`;
  const descriptor = JSON.parse(await readFile(`${directory}/asset.json`, 'utf8'));
  if (descriptor.renderMode !== 'thin-instance') continue;
  const recipe: KitRecipe = JSON.parse(await readFile(`${directory}/source.json`, 'utf8'));
  const generated = generateKit(id, recipe),
    model = encodeStaticGlb(generated.parts);
  const referenceParts = inspectStaticGlb(model, id).parts;
  payloads.set(`/${id}/model.glb`, model);
  payloads.set(
    `/${id}/parts.json`,
    new TextEncoder().encode(JSON.stringify({ ...referenceParts, renderMode: 'thin-instance' })),
  );
  payloads.set(
    `/${id}/reference-parts.json`,
    new TextEncoder().encode(JSON.stringify(referenceParts)),
  );
  const common = {
    assetId: id,
    version: id,
    modelFile: `${id}/model.glb`,
    bounds: generated.physics.bounds,
  };
  assets[id] = { ...common, partsFile: `${id}/parts.json` };
  references[id] = { ...common, partsFile: `${id}/reference-parts.json` };
}
assert.equal(
  Object.keys(assets).length,
  13,
  'all canonical GLBs must use the measured instancing path',
);
payloads.set('/manifest.json', new TextEncoder().encode(JSON.stringify({ assets })));
payloads.set('/reference.json', new TextEncoder().encode(JSON.stringify({ assets: references })));
payloads.set('/app.js', await readFile(`${output}/app.js`));
payloads.set(
  '/',
  new TextEncoder().encode(
    '<!doctype html><style>body{margin:0}canvas{display:block;width:800px;height:600px}</style><canvas width="800" height="600"></canvas><script type="module" src="/app.js"></script>',
  ),
);
const server = createServer((request, response) => {
  const path = new URL(request.url!, 'http://localhost').pathname,
    data = payloads.get(path);
  response.writeHead(data ? 200 : 404, {
    'Content-Type':
      path === '/'
        ? 'text/html'
        : path.endsWith('.js')
          ? 'text/javascript'
          : 'application/octet-stream',
  });
  response.end(data);
});
const browser = await launchTestBrowser();
const results: any[] = [],
  errors: string[] = [];
const conditions = {
  viewport: [800, 600],
  warmupFrames: 20,
  samples: 60,
  chunkMetres: 125,
  world: 'canonical-library-control-scene',
  codeRevision: process.env.SU_CODE_REVISION ?? 'working-tree',
  quality: '1024 blur exponential shadow map',
  assets: Object.keys(assets),
  bytes: [...payloads.entries()]
    .filter(([path]) => path.endsWith('.glb'))
    .reduce((n, [, bytes]) => n + bytes.byteLength, 0),
};
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => (window as any).__STATIC_GLB_TEST__);
  for (const scenario of [
    { shadows: false },
    { shadows: true },
    { shadows: true, perspective: true },
    { shadows: true, night: true },
    { shadows: true, fog: true },
  ]) {
    const before = await page.evaluate(
      (scenario) => (window as any).__STATIC_GLB_TEST__.setup(false, scenario),
      scenario,
    );
    await page.evaluate(() => (window as any).__STATIC_GLB_TEST__.compare());
    const name = Object.entries(scenario)
      .map(([key, value]) => `${key}-${value}`)
      .join('-');
    await page.screenshot({ path: `${output}/reference-${name}.png` });
    const after = await page.evaluate(
      (scenario) => (window as any).__STATIC_GLB_TEST__.setup(true, scenario),
      scenario,
    );
    const comparison = await page.evaluate(() => (window as any).__STATIC_GLB_TEST__.compare());
    await page.screenshot({ path: `${output}/instanced-${name}.png` });
    results.push({ scenario, before, after, comparison });
    await writeFile(
      `${output}/result.json`,
      JSON.stringify({ conditions, results, errors }, null, 2),
    );
    assert.deepEqual(errors, []);
    assert.equal(before.instances, 208);
    assert.equal(after.instances, 208);
    assert.equal(after.glbInstances, 208);
    assert.equal(after.modelLoads, 13);
    assert.ok(after.ready, 'all active shaders must compile');
    assert.ok(
      after.drawCalls < before.drawCalls / 2,
      `draw calls did not fall: ${before.drawCalls} -> ${after.drawCalls}`,
    );
    assert.ok(comparison.changed < 0.01, `visible difference: ${JSON.stringify(comparison)}`);
    const unloaded = await page.evaluate(() => (window as any).__STATIC_GLB_TEST__.unload());
    assert.equal(unloaded.glbInstances, 0);
    assert.equal(unloaded.glbBatches, 0);
    assert.equal(unloaded.assets, 0);
    assert.equal(unloaded.geometries, 1);
    assert.equal(unloaded.meshes, 1);
    assert.equal(unloaded.materials, 1);
    const reloaded = await page.evaluate(() => (window as any).__STATIC_GLB_TEST__.reload());
    assert.equal(reloaded.glbInstances, 208);
    assert.equal(reloaded.meshes, after.meshes);
    assert.equal(reloaded.geometries, after.geometries);
    assert.equal(reloaded.materials, after.materials);
  }
  await page.evaluate(() => (window as any).__STATIC_GLB_TEST__.dispose());
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      results.map(({ scenario, before, after, comparison }) => ({
        scenario,
        drawCalls: [before.drawCalls, after.drawCalls],
        meshes: [before.meshes, after.meshes],
        frameCpuMedianMs: [before.frameCpuMedianMs, after.frameCpuMedianMs],
        frameCpuP95Ms: [before.frameCpuP95Ms, after.frameCpuP95Ms],
        comparison,
      })),
      null,
      2,
    ),
  );
} finally {
  await writeFile(
    `${output}/result.json`,
    JSON.stringify({ conditions, results, errors }, null, 2),
  );
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
