import { describe, expect, it } from 'vitest';
import { initialItemState, type BuildingPhysicsAsset } from '@su/contracts';
import { createPhysicsWorld } from './physics-world.js';
import { loadServerWasm } from './server.js';
import { physicsFixture } from './test-fixture.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

const box = (id: string, x: number, y: number, z: number): BuildingPhysicsAsset => ({
  assetId: id,
  bounds: { min: { x: -x / 2, y: 0, z: -z / 2 }, max: { x: x / 2, y, z: z / 2 } },
  colliders: [
    {
      id: 'solid',
      kind: 'box',
      position: { x: 0, y: y / 2, z: 0 },
      size: { x, y, z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      friction: 0.6,
      restitution: 0,
    },
  ],
});
const instance = (entityId: string, assetId: string, x = 0, y = 0, z = 0) => ({
  entityId,
  assetId,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
});
async function fixture() {
  const definition = physicsFixture();
  definition.entities = definition.entities.filter((entity) => entity.entityId === 'floor');
  definition.initialItems = [];
  definition.buildingAssets = {
    owner: box('owner', 0.4, 1, 0.4),
    foundation: box('foundation', 8, 2, 8),
    approach: box('approach', 2, 1, 2),
  };
  definition.buildings = [
    instance('owner', 'owner', 0, 2),
    instance('derived-foundation', 'foundation'),
    instance('derived-approach', 'approach', 0, 0, 5),
  ];
  const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
  return { definition, world };
}
describe('atomic authoritative static replacement', () => {
  it('stages only a changed support, leaves it inactive and retains all other native bodies', async () => {
    const { definition, world } = await fixture();
    try {
      const owner = world.physics.getBodies().find((body) => body.transformNode.name === 'owner');
      const approach = world.physics
        .getBodies()
        .find((body) => body.transformNode.name === 'derived-approach');
      const retainedShapes = world.staticDiagnostics().buildings;
      const raised = box('foundation', 8, 3, 8);
      const next = {
        ...definition,
        buildingAssets: { ...definition.buildingAssets, foundation: raised },
      };
      const change = world.prepareStaticReplacement(next, new Set(['derived-foundation']));
      expect(world.staticDiagnostics().buildings).toEqual(retainedShapes);
      expect(world.surfaceRay({ x: -2, y: 5, z: 0 }, { x: -2, y: -1, z: 0 })!.point.y).toBeCloseTo(
        2,
        5,
      );
      change.commit();
      expect(world.physics.getBodies()).toContain(owner);
      expect(world.physics.getBodies()).toContain(approach);
      expect(world.surfaceRay({ x: -2, y: 5, z: 0 }, { x: -2, y: -1, z: 0 })!.point.y).toBeCloseTo(
        3,
        5,
      );
      expect(world.staticDiagnostics().buildings).toEqual(retainedShapes);
      expect(() =>
        world.prepareStaticReplacement(
          { ...next, buildings: next.buildings.filter((item) => item.entityId !== 'owner') },
          new Set(['derived-foundation']),
        ),
      ).toThrow('Unlisted static replacement');
    } finally {
      world.dispose();
    }
  });
  it('ignores designated terrain ground only during a placement query and restores its collision shape', async () => {
    const { world } = await fixture();
    try {
      const candidate = instance('candidate', 'owner', -2, 1, -2);
      const shape = box('owner', 0.4, 1, 0.4);
      expect(world.checkStaticPlacement(candidate, shape)).toBe('BLOCKED');
      expect(
        world.checkStaticPlacement(candidate, shape, new Set(['derived-foundation'])),
      ).toBeUndefined();
      expect(world.checkStaticPlacement(candidate, shape)).toBe('BLOCKED');
      expect(
        world.checkStaticPlacement(
          instance('candidate', 'owner', 0, 2, 0),
          shape,
          new Set(['derived-foundation']),
        ),
      ).toBe('BLOCKED');
    } finally {
      world.dispose();
    }
  });
  it('removes owner and every derived body while retaining live dynamics and current velocities', async () => {
    const { definition, world } = await fixture();
    try {
      const position = world.findSpawn(undefined, { x: -2, y: 2, z: -2 })!;
      const player = world.createCharacter('standing', position);
      player.input = { moveX: 1, moveZ: 0, sprint: true };
      const item = initialItemState({
        seedId: 'resting',
        typeId: 'wooden-crate',
        position: { x: 2, y: 2.52, z: 2 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      });
      world.replaceItems([item]);
      const body = world.objects.get(item.entityId)!.body;
      const controller = player.controller;
      const before = world.snapshot();
      const change = world.prepareStaticReplacement({ ...definition, buildings: [] });
      // A delayed COMMIT must not replay a captured older pose or velocity.
      body.setLinearVelocity(new Vector3(0.25, 0.1, 0));
      body.setAngularVelocity(new Vector3(0, 0.7, 0.1));
      const atCommit = world.snapshot();
      change.commit();
      change.dispose();
      expect(world.objects.get(item.entityId)!.body).toBe(body);
      expect(world.characters.get('standing')!.controller).toBe(controller);
      expect(world.characters.get('standing')!.input).toEqual({ moveX: 1, moveZ: 0, sprint: true });
      expect(world.snapshot()).toEqual(atCommit);
      expect(world.snapshot().players).toEqual(before.players);
      expect(world.staticDiagnostics().buildings.instances).toBe(0);
      expect(world.surfaceRay({ x: -2, y: 3, z: 0 }, { x: -2, y: -1, z: 0 })!.point.y).toBeCloseTo(
        0,
        5,
      );
      expect(world.surfaceRay({ x: 0, y: 3, z: 5 }, { x: 0, y: -1, z: 5 })!.point.y).toBeCloseTo(
        0,
        5,
      );
      for (let i = 0; i < 180; i++) world.advance(1 / 60);
      expect(world.state('standing').position.y).toBeLessThan(1.2);
      expect(world.snapshot().items[0].position.y).toBeLessThan(0.7);
    } finally {
      world.dispose();
    }
  });
  it('abandons a prepared layer and cleans a partially failed stage without changing the old world', async () => {
    const { definition, world } = await fixture();
    try {
      const before = world.staticDiagnostics();
      const added = instance('new-owner', 'owner', 10);
      const change = world.prepareStaticReplacement({
        ...definition,
        buildings: [...definition.buildings, added],
      });
      change.dispose();
      change.commit();
      expect(world.staticDiagnostics()).toEqual(before);
      expect(world.definition).toBe(definition);
      expect(() =>
        world.prepareStaticReplacement({
          ...definition,
          buildings: [...definition.buildings, added, instance('bad', 'missing')],
        }),
      ).toThrow('Unknown replacement asset');
      expect(world.staticDiagnostics()).toEqual(before);
      expect(world.surfaceRay({ x: -2, y: 3, z: 0 }, { x: -2, y: -1, z: 0 })!.point.y).toBeCloseTo(
        2,
        5,
      );
    } finally {
      world.dispose();
    }
  });
});
