import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATIC_PLACEMENT_ASSET_ID } from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { buildStaticPlacementWorld } from './static-placement-world.js';

export const REMOVAL_HOUSE_ASSET_ID = 'test-removal-house';
export const REMOVAL_SEED_OBJECTS = {
  benchA: { entityId: 'seed-bench-a', position: { x: -6, y: 0, z: -5 } },
  benchB: { entityId: 'seed-bench-b', position: { x: -2, y: 0, z: -5 } },
  house: { entityId: 'seed-house', position: { x: 0, y: 0, z: 3 } },
  tree: { entityId: 'seed-tree', position: { x: -10, y: 0, z: 3 } },
} as const;

/** Authored objects include a normal building and tree outside the placement palette. */
export async function buildStaticRemovalWorld(directory: string) {
  const output = await buildStaticPlacementWorld(directory);
  const source = join(directory, 'source');
  await mkdir(join(source, 'house'), { recursive: true });
  await cp('content/buildings/ring-block/objects/tree-birch-medium', join(source, 'tree'), {
    recursive: true,
  });
  await writeFile(
    join(source, 'house/asset.json'),
    JSON.stringify({
      formatVersion: 1,
      assetId: REMOVAL_HOUSE_ASSET_ID,
      source: { kind: 'house', file: 'source.json' },
      metadata: {
        name: 'Исходный дом',
        description: 'Исходное здание, отсутствующее в каталоге размещения.',
        category: 'buildings',
        tags: ['building'],
      },
    }),
  );
  await writeFile(
    join(source, 'house/source.json'),
    JSON.stringify({
      formatVersion: 1,
      width: 4,
      depth: 4,
      floors: 1,
      floorHeight: 2.5,
      roofHeight: 1,
      wallColor: '#bb936b',
      roofColor: '#654a3d',
      windowColor: '#7fbdcf',
      doorColor: '#594637',
    }),
  );
  const catalogFile = join(source, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  catalog.assets[REMOVAL_HOUSE_ASSET_ID] = 'house/asset.json';
  catalog.assets['tree-birch-medium'] = 'tree/asset.json';
  await writeFile(catalogFile, JSON.stringify(catalog));
  const cellFile = join(source, 'cell.json');
  const cell = JSON.parse(await readFile(cellFile, 'utf8'));
  const rotation = { x: 0, y: 0, z: 0, w: 1 };
  cell.buildings = [
    { ...REMOVAL_SEED_OBJECTS.benchA, assetId: STATIC_PLACEMENT_ASSET_ID, rotation },
    {
      ...REMOVAL_SEED_OBJECTS.benchB,
      assetId: STATIC_PLACEMENT_ASSET_ID,
      rotation: { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) },
    },
    { ...REMOVAL_SEED_OBJECTS.house, assetId: REMOVAL_HOUSE_ASSET_ID, rotation },
    { ...REMOVAL_SEED_OBJECTS.tree, assetId: 'tree-birch-medium', rotation },
  ];
  await writeFile(cellFile, JSON.stringify(cell));
  const worldFile = join(source, 'world.json');
  const world = JSON.parse(await readFile(worldFile, 'utf8'));
  world.bounds.max.y = 30;
  await writeFile(worldFile, JSON.stringify(world));
  await buildWorld(worldFile, output);
  return output;
}
