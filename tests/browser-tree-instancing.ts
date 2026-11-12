import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { launchTestBrowser } from './helpers/browser.js';
import { generateKit, type KitRecipe } from '../tools/world-build/src/kit.js';
import { treeRenderRecipe } from '../tools/world-build/src/tree-instances.js';
import { encodeStaticGlb, inspectStaticGlb } from '../tools/world-build/src/glb.js';
import { mergeParts } from '../tools/world-build/src/merge.js';

const output = resolve('output/playwright/tree-instancing-visual');
await mkdir(output, { recursive: true });
await build({
  entryPoints: ['tests/fixtures/tree-scene.ts'],
  outfile: `${output}/app.js`,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
const payloads = new Map<string, Uint8Array>();
const assets: Record<string, unknown> = {};
const palettes = new Set<string>();
const addAsset = (id: string, recipe: KitRecipe, unoccluded = false) => {
  const tree = treeRenderRecipe(id, recipe)!;
  const generated = generateKit(id, recipe);
  if (unoccluded) {
    delete tree.ambientOcclusion;
    // Emulate an already-published pre-AO GLB, retaining its exact original colours.
    generated.parts = mergeParts(
      generateKit(id, { ...recipe, merge: false }).parts.map((part) => ({
        ...part,
        colors: undefined,
      })),
    );
  }
  const model = encodeStaticGlb(generated.parts);
  const parts = { ...inspectStaticGlb(model, id).parts, tree };
  payloads.set(`/${id}/model.glb`, model);
  payloads.set(`/${id}/parts.json`, new TextEncoder().encode(JSON.stringify(parts)));
  assets[id] = {
    assetId: id,
    version: id,
    modelFile: `${id}/model.glb`,
    partsFile: `${id}/parts.json`,
    bounds: generated.physics.bounds,
  };
};
let legacyAdded = false;
for (const id of (await readdir('content/buildings/ring-block/objects'))
  .filter((id) => id.startsWith('tree-'))
  .sort()) {
  const recipe: KitRecipe = JSON.parse(
    await readFile(`content/buildings/ring-block/objects/${id}/source.json`, 'utf8'),
  );
  const tree = treeRenderRecipe(id, recipe)!;
  const palette = `${tree.crownColor}:${tree.trunkColor}:${tree.foliage ?? 'conical'}`;
  if (palettes.has(palette)) continue;
  palettes.add(palette);
  addAsset(id, recipe);
  // Same colors, different profile: old streamed metadata must not reuse a broadleaf template.
  if (!legacyAdded && recipe.foliage) {
    const legacy = structuredClone(recipe);
    delete legacy.foliage;
    addAsset(`${id}-legacy`, legacy);
    addAsset(`${id}-pre-ao`, recipe, true);
    legacyAdded = true;
  }
}
assert.equal(palettes.size, 3, 'birch, leafy and spruce palettes remain represented');
assert.equal(
  Object.keys(assets).length,
  5,
  'include old conical and pre-AO broadleaf bundles with the same colors',
);
payloads.set('/manifest.json', new TextEncoder().encode(JSON.stringify({ assets })));
payloads.set('/app.js', await readFile(`${output}/app.js`));
payloads.set(
  '/',
  new TextEncoder().encode(
    '<!doctype html><style>body{margin:0}canvas{display:block;width:800px;height:600px}</style><canvas width="800" height="600"></canvas><script type="module" src="/app.js"></script>',
  ),
);
const server = createServer((request, response) => {
  const path = new URL(request.url!, 'http://localhost').pathname;
  const data = payloads.get(path);
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
const results: unknown[] = [];
const errors: string[] = [];
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
  await page.waitForFunction(() => (window as any).__TREE_TEST__);
  for (const [shadows, faded] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const before = await page.evaluate(
      ([shadows, faded]) => (window as any).__TREE_TEST__.setup(false, shadows, faded),
      [shadows, faded],
    );
    await page.evaluate(() => (window as any).__TREE_TEST__.compare());
    await page.screenshot({ path: `${output}/legacy-${shadows}-${faded}.png` });
    const after = await page.evaluate(
      ([shadows, faded]) => (window as any).__TREE_TEST__.setup(true, shadows, faded),
      [shadows, faded],
    );
    const comparison = await page.evaluate(() => (window as any).__TREE_TEST__.compare());
    await page.screenshot({ path: `${output}/instanced-${shadows}-${faded}.png` });
    results.push({ shadows, faded, before, after, comparison });
    await writeFile(`${output}/result.json`, JSON.stringify({ results, errors }, null, 2));
    assert.deepEqual(errors, []);
    assert.equal(before.instances, 144);
    assert.equal(after.treeInstances, 144);
    assert.equal(after.modelLoads, 0);
    assert.ok(after.ready);
    assert.deepEqual(
      after.trees.map((t: any) => [t.entityId, t.opacity, t.occluded]),
      before.trees.map((t: any) => [t.entityId, t.opacity, t.occluded]),
    );
    assert.ok(after.drawCalls < before.drawCalls / 2, 'tree draw calls must fall by at least half');
    assert.ok(comparison.changed < 0.01, `visible difference: ${JSON.stringify(comparison)}`);
    const unloaded = await page.evaluate(() => (window as any).__TREE_TEST__.unload());
    assert.equal(unloaded.treeInstances, 0);
    assert.equal(unloaded.treeBatches, 0);
    const reloaded = await page.evaluate(() => (window as any).__TREE_TEST__.reload());
    assert.equal(reloaded.treeInstances, 144);
    assert.equal(reloaded.meshes, after.meshes);
    assert.equal(reloaded.materials, after.materials);
  }
  await page.evaluate(() => (window as any).__TREE_TEST__.dispose());
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      results.map((r: any) => ({
        shadows: r.shadows,
        faded: r.faded,
        drawCalls: [r.before.drawCalls, r.after.drawCalls],
        comparison: r.comparison,
      })),
      null,
      2,
    ),
  );
} finally {
  await writeFile(`${output}/result.json`, JSON.stringify({ results, errors }, null, 2));
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
