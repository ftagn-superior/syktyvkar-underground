import { physicsFixture } from '../../packages/simulation/src/test-fixture.js';
import { generateHouse } from '../../tools/world-build/src/house.js';
import { compileGeneratedAsset } from '../../packages/terrain-build/src/assets.js';
import {
  VisualGroupBuilder,
  visualTemplate,
  type VisualSource,
} from '../../packages/visual-build/src/index.js';
import { createWorldPublication } from '../../packages/world-release/src/index.js';
import { GRAPHICS_POLICY_VERSION, createWorldGrid } from '../../packages/contracts/src/index.js';
export function cityLodFixture() {
  const world = physicsFixture();
  world.spawnPoints = Array.from({ length: 8 }, (_, i) => ({ x: i * 2, y: 0, z: -100 }));
  world.worldId = 'lod-test';
  world.bounds = { min: { x: -250, y: -10, z: -250 }, max: { x: 270, y: 80, z: 270 } };
  world.entities = [];
  world.initialItems = [];
  const generated = generateHouse('house', {
    formatVersion: 1,
    width: 12,
    depth: 8,
    floors: 2,
    floorHeight: 3,
    roofHeight: 2,
    wallColor: '#acacac',
    roofColor: '#775544',
    windowColor: '#9999bb',
    doorColor: '#554433',
  });
  const asset = compileGeneratedAsset('house', generated);
  world.buildingAssets = { house: asset.physics };
  world.buildings = [
    {
      entityId: 'west',
      assetId: 'house',
      position: { x: -127, y: 0, z: -30 },
      rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
    },
    {
      entityId: 'east',
      assetId: 'house',
      position: { x: 10, y: 0, z: 10 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
  ];
  const grid = createWorldGrid(world.bounds, 125);
  const source: VisualSource = {
    formatVersion: 1,
    policyVersion: GRAPHICS_POLICY_VERSION,
    worldId: world.worldId,
    templates: {
      house: visualTemplate(
        'silhouette',
        generated.parts.filter((p) => p.role !== 'detail'),
      ),
    },
  };
  const builder = new VisualGroupBuilder();
  const publish = () =>
    createWorldPublication(
      world,
      grid,
      { house: asset },
      { graphics: builder.build(world, grid, source) },
    );
  return { world, grid, source, asset, builder, publish, publication: publish() };
}
