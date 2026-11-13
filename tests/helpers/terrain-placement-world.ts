import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  STATIC_PLACEMENT_ASSET_ID,
  sampleTerrain,
  type TerrainGrid,
} from '../../packages/contracts/src/index.js';
import {
  createWorldPublication,
  writeWorldPublication,
  writeAuthoringMetadata,
  jsonBytes,
  type CompiledWorldAsset,
} from '../../packages/world-release/src/index.js';
import { compileGeneratedAsset } from '../../packages/terrain-build/src/assets.js';
import { generateTerrainTile, rectangle } from '../../packages/terrain-build/src/index.js';
import { readAuthoringRelease } from '../../apps/server/src/layout/release.js';
import {
  createWorldModelCatalog,
  readWorldModelSources,
  writeWorldModelCatalog,
} from '../../tools/world-build/src/model-catalog.js';
import { buildStaticPlacementWorld } from './static-placement-world.js';

/** A real sloped release, explicit model placement policy and one derived entrance ramp. */
export async function buildTerrainPlacementWorld(directory: string) {
  const plain = await readAuthoringRelease(await buildStaticPlacementWorld(directory));
  const grid: TerrainGrid = {
    formatVersion: 1,
    origin: { x: -20, z: -20 },
    spacing: 2,
    columns: 21,
    rows: 21,
    heights: Array.from({ length: 441 }, (_, i) => 0.5 + (i % 21) * 0.02),
    bottom: -1,
  };
  const assets: Record<string, CompiledWorldAsset> = {};
  for (const [id, descriptor] of Object.entries(plain.manifest.assets))
    assets[id] = {
      version: descriptor.version,
      bounds: descriptor.bounds,
      physics: plain.definition.buildingAssets[id],
      model: descriptor.modelFile
        ? await readFile(join(plain.directory, descriptor.modelFile))
        : undefined,
      collision: await readFile(join(plain.directory, descriptor.collisionFile)),
      parts: await readFile(join(plain.directory, descriptor.partsFile)),
    };
  const groundId = 'placement-terrain';
  assets[groundId] = compileGeneratedAsset(
    groundId,
    generateTerrainTile(groundId, grid, rectangle(0, 0, 40, 40), []),
  );
  const asset = assets[STATIC_PLACEMENT_ASSET_ID];
  const { min, max } = asset.bounds;
  const terrain = {
    formatVersion: 2,
    generatorVersion: 'terrain-build/2',
    worldId: plain.definition.worldId,
    grid,
    supports: [
      {
        kind: 'foundation-v2',
        assetId: STATIC_PLACEMENT_ASSET_ID,
        components: [
          {
            outline: [
              [min.x, min.z],
              [max.x, min.z],
              [max.x, max.z],
              [min.x, max.z],
            ],
          },
        ],
        jointY: 0,
        clearance: 0.08,
        burial: 0.1,
        color: '#888888',
        approaches: [
          {
            id: 'entry',
            edge: [
              [min.x, max.z],
              [max.x, max.z],
            ],
            outward: [0, 1],
            length: 1.2,
            targetY: 0,
            color: '#aaaaaa',
          },
        ],
      },
    ],
    placementModels: [
      {
        assetId: STATIC_PLACEMENT_ASSET_ID,
        policy: { kind: 'foundation', maximumVisibleHeight: 1 },
      },
    ],
    placementGroundIds: [groundId],
  };
  const world = {
    ...plain.definition,
    entities: [],
    initialItems: [],
    buildingAssets: { ...plain.definition.buildingAssets, [groundId]: assets[groundId].physics },
    buildings: [
      {
        entityId: groundId,
        assetId: groundId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    ],
    spawnPoints: plain.definition.spawnPoints.map((p) => ({
      ...p,
      y: sampleTerrain(grid, p.x, p.z)!.height,
    })),
  };
  const publication = createWorldPublication(world, plain.manifest.grid, assets, {
    physicsPacks: true,
  });
  const output = join(directory, 'terrain-world');
  await writeWorldPublication(publication, output);
  const bytes = jsonBytes(terrain);
  await writeAuthoringMetadata(world, publication.manifest, [groundId], output, bytes);
  const metadata = (await readAuthoringRelease(output)).metadata;
  const catalog = createWorldModelCatalog(
    await readWorldModelSources(join(directory, 'source/catalog.json')),
    publication.manifest,
    metadata.assetReleaseVersion,
    { [STATIC_PLACEMENT_ASSET_ID]: [STATIC_PLACEMENT_ASSET_ID] },
    [groundId],
  );
  await writeWorldModelCatalog(catalog, join(output, 'model-catalog'), {
    formatVersion: 1,
    worldId: world.worldId,
    assetReleaseVersion: metadata.assetReleaseVersion,
    assetIds: [STATIC_PLACEMENT_ASSET_ID],
  });
  return output;
}
