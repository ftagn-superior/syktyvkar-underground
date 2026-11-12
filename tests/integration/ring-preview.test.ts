import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { renderRingPreview } from '../../tools/world-build/src/preview-ring.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('previews own catalog recipes and exports traces without any importer inputs or content writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ring-preview-'));
  directories.push(root);
  const inputs = new Map<string, string>();
  async function json(file: string, value: unknown) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    const bytes = JSON.stringify(value);
    inputs.set(path, bytes);
    await writeFile(path, bytes);
  }
  const ground = {
    entityId: 'terrain',
    assetId: 'own-ground',
    position: { x: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  const house = {
    entityId: 'house',
    assetId: 'own-house',
    position: { x: 10, z: 20 },
    rotation: { x: 0, y: 1, z: 0, w: 0 },
  };
  await json('world/world.json', {
    assetCatalog: '../models/catalog.json',
    cells: ['a.json', 'b.json'],
  });
  await json('world/a.json', { buildings: [ground, house] });
  await json('world/b.json', { buildings: [house] });
  await json('models/catalog.json', {
    assets: { 'own-ground': 'terrain/descriptor.json', 'own-house': 'house/descriptor.json' },
  });
  await json('models/terrain/descriptor.json', { source: { kind: 'ground', file: 'recipe.json' } });
  await json('models/terrain/recipe.json', {
    color: '#123456',
    layers: [
      {
        id: 'road',
        color: '#abcdef',
        polygons: [
          [
            [
              [-1, -1],
              [1, -1],
              [1, 1],
            ],
          ],
        ],
      },
    ],
  });
  await json('models/house/descriptor.json', {
    source: { kind: 'footprint', file: 'recipe.json' },
  });
  await json('models/house/recipe.json', {
    outline: [
      [0, 0],
      [2, 0],
      [2, 3],
      [0, 3],
    ],
  });
  const traces = [
    {
      name: 'ring:lane-dashed',
      points: [
        [1, 2],
        [3, 4],
      ],
    },
  ];
  await json('world/ring-trace.json', { formatVersion: 1, traces });
  const output = join(root, 'preview/ring.html');
  expect(await renderRingPreview(join(root, 'world/world.json'), output)).toBe(output);
  const html = await readFile(output, 'utf8');
  expect(html).toContain('fill="#123456"');
  expect(html).toContain('data-layer="road"');
  expect(html.match(/M10 20L8 20L8 17L10 17Z/g)).toHaveLength(1);
  expect(html).toContain(`const FILE=${JSON.stringify(traces)};`);
  expect(html).toContain("a.download='ring-trace.json'");
  for (const [path, bytes] of inputs) expect(await readFile(path, 'utf8')).toBe(bytes);
});
