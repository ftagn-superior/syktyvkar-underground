import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { generateKit } from '../../../tools/world-build/src/kit.js';
import { createAuthoritativeWorld, loadServerWasm } from './server.js';
import { createPhysicsWorld } from './physics-world.js';
import { physicsFixture, buildingFixture } from './test-fixture.js';
import {
  placedStaticInstance,
  initialItemState,
  STATIC_PLACEMENT_ASSET_ID,
  type PlaceStaticRequest,
} from '@su/contracts';
const request = (x: number, z: number, yawStep = 0): PlaceStaticRequest => ({
  operationId: '12345678-1234-4567-8123-123456789abc',
  worldEpoch: 'e',
  assetReleaseVersion: 'a'.repeat(64),
  expectedLayoutRevision: 1,
  position: { x, z },
  yawStep,
});
async function bench() {
  return generateKit(
    STATIC_PLACEMENT_ASSET_ID,
    JSON.parse(
      await readFile(
        `content/buildings/ring-block/objects/${STATIC_PLACEMENT_ASSET_ID}/source.json`,
        'utf8',
      ),
    ),
  ).physics;
}
describe('one-box live static validation', () => {
  it('allows ground contact and rejects actual box, character, item and rotated boundary intersections', async () => {
    const asset = await bench();
    const world = await createAuthoritativeWorld(physicsFixture());
    try {
      expect(
        world.checkStaticPlacement(placedStaticInstance(request(10, 10)), asset),
      ).toBeUndefined();
      expect(world.checkStaticPlacement(placedStaticInstance(request(5, 0)), asset)).toBe(
        'BLOCKED',
      );
      expect(world.checkStaticPlacement(placedStaticInstance(request(19.7, 10, 3)), asset)).toBe(
        'OUT_OF_BOUNDS',
      );
      expect(world.checkStaticPlacement(placedStaticInstance(request(0, 6)), asset)).toBe(
        'BLOCKED',
      );
      world.addPlayer('person', { x: -10, y: 0, z: -10 });
      expect(world.checkStaticPlacement(placedStaticInstance(request(-10, -10)), asset)).toBe(
        'BLOCKED',
      );
    } finally {
      world.dispose();
    }
  });
  it('uses triangle surfaces and the interior-volume check for closed mesh', async () => {
    const asset = await bench(),
      definition = buildingFixture('arch');
    const mesh = definition.buildingAssets.arch.colliders[0];
    if (mesh.kind !== 'mesh') throw new Error('mesh fixture');
    const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
    try {
      expect(world.checkStaticPlacement(placedStaticInstance(request(-2, 0)), asset)).toBe(
        'BLOCKED',
      );
    } finally {
      world.dispose();
    }
    const cube = {
      ...mesh,
      vertices: mesh.vertices
        .slice(0, 24)
        .map((v, i) => (i % 3 === 0 ? v * 8 + 16 : i % 3 === 2 ? v * 8 : v * 4)),
      indices: mesh.indices.slice(0, 36),
    };
    definition.buildingAssets.arch = {
      assetId: 'arch',
      bounds: { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 12, z: 5 } },
      colliders: [cube],
    };
    definition.buildings = definition.buildings.slice(0, 1);
    const enclosed = await createPhysicsWorld(definition, await loadServerWasm(), false);
    try {
      expect(enclosed.checkStaticPlacement(placedStaticInstance(request(0, 0)), asset)).toBe(
        'BLOCKED',
      );
    } finally {
      enclosed.dispose();
    }
  });
  it('preserves spawns and safePose while accepting airborne item motion', async () => {
    const asset = await bench(),
      definition = physicsFixture();
    definition.entities = [];
    definition.initialItems = [];
    definition.buildings = [placedStaticInstance(request(10, 10))];
    definition.buildingAssets = { [asset.assetId]: asset };
    const probe = await createAuthoritativeWorld(definition);
    try {
      expect(probe.findSpawn(undefined, [{ x: 10, y: 0, z: 10 }])).toBeUndefined();
      const item = initialItemState({
        seedId: 'airborne',
        typeId: 'wooden-crate',
        position: { x: 10, y: 5, z: 10 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      });
      item.safePose = { position: { x: 10, y: 0.52, z: 10 }, rotation: item.rotation };
      expect(probe.checkSavedItem(item)).toBe('BLOCKED');
      item.safePose.position = { x: -10, y: 0.52, z: -10 };
      expect(probe.checkSavedItem(item)).toBeUndefined();
    } finally {
      probe.dispose();
    }
  });
});
