import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { physicsFixture } from '../../packages/simulation/src/test-fixture.js';
import { STATIC_PLACEMENT_ASSET_ID } from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
/** Small authored release with the real selected bench and a flat foundation. */
export async function buildStaticPlacementWorld(directory: string) {
  const source = join(directory, 'source');
  await mkdir(source, { recursive: true });
  await cp(
    `content/buildings/ring-block/objects/${STATIC_PLACEMENT_ASSET_ID}`,
    join(source, 'bench'),
    { recursive: true },
  );
  await cp('content/items/catalog.json', join(source, 'items.json'));
  const {
    entities,
    buildings: _b,
    buildingAssets: _a,
    itemCatalog: _i,
    ...header
  } = physicsFixture();
  await writeFile(
    join(source, 'catalog.json'),
    JSON.stringify({
      formatVersion: 1,
      assets: { [STATIC_PLACEMENT_ASSET_ID]: 'bench/asset.json' },
    }),
  );
  await writeFile(
    join(source, 'cell.json'),
    JSON.stringify({
      formatVersion: 2,
      cellId: '0_0',
      statics: entities.map((i) => ({ ...i, color: '#ffffff' })),
      buildings: [],
    }),
  );
  await writeFile(
    join(source, 'world.json'),
    JSON.stringify({
      ...header,
      worldId: 'static-placement-lab',
      spawnPoints: [-12, -9, -6, -3, 0, 3, 6, 9].map((x) => ({ x, y: 0, z: -10 })),
      cellSize: 40,
      assetCatalog: 'catalog.json',
      placementPolicy: 'placement.json',
      itemCatalog: 'items.json',
      cells: ['cell.json'],
    }),
  );
  await writeFile(
    join(source, 'placement.json'),
    JSON.stringify({ formatVersion: 1, assetIds: [STATIC_PLACEMENT_ASSET_ID] }),
  );
  const worldDirectory = join(directory, 'world');
  await buildWorld(join(source, 'world.json'), worldDirectory);
  return worldDirectory;
}
