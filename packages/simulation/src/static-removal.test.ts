import { describe, expect, it } from 'vitest';
import { initialItemState } from '@su/contracts';
import { createAuthoritativeWorld } from './server.js';
import { buildingFixture, physicsFixture } from './test-fixture.js';

describe('live whole-instance removal', () => {
  it.each(['courtyard', 'arch'] as const)(
    'removes all %s colliders of one instance and preserves shared peers',
    async (kind) => {
      const definition = buildingFixture(kind);
      const world = await createAuthoritativeWorld(definition);
      try {
        const wall = kind === 'arch' ? 2 : 3;
        const bodies = world.diagnostics().bodies;
        expect(world.findSpawn(undefined, [{ x: -wall, y: 0, z: 0 }])).toBeUndefined();
        const next = { ...definition, buildings: definition.buildings.slice(1) };
        world.removeStatic('building-a', next);
        expect(world.diagnostics().bodies).toBe(bodies - 1);
        expect(world.findSpawn(undefined, [{ x: -wall, y: 0, z: 0 }])).toBeDefined();
        expect(world.findSpawn(undefined, [{ x: 10, y: 0, z: wall }])).toBeUndefined();
        // Releasing an already absent instance must not release its peer's shared asset.
        world.removeStatic('building-a', next);
        expect(world.diagnostics().bodies).toBe(bodies - 1);
        world.removeStatic('building-b', { ...next, buildings: [] });
        expect(world.diagnostics().bodies).toBe(bodies - 2);
        expect(world.findSpawn(undefined, [{ x: 10, y: 0, z: wall }])).toBeDefined();
      } finally {
        world.dispose();
      }
    },
  );

  it('lets resting items and a supported player fall after removing their support', async () => {
    const definition = physicsFixture();
    definition.entities = definition.entities.filter((i) => i.entityId === 'floor');
    definition.initialItems = [];
    const platform = {
      assetId: 'platform',
      bounds: { min: { x: -4, y: 0, z: -4 }, max: { x: 4, y: 2, z: 4 } },
      colliders: [
        {
          id: 'support',
          kind: 'box' as const,
          position: { x: 0, y: 1, z: 0 },
          size: { x: 8, y: 2, z: 8 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          friction: 0.6,
          restitution: 0,
        },
      ],
    };
    definition.buildingAssets = { platform };
    definition.buildings = [
      {
        entityId: 'platform-a',
        assetId: 'platform',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    ];
    const world = await createAuthoritativeWorld(definition);
    try {
      expect(world.addPlayer('standing', { x: -2, y: 2.1, z: -2 })).toBeDefined();
      const item = initialItemState({
        seedId: 'resting',
        typeId: 'wooden-crate',
        position: { x: 2, y: 2.52, z: 2 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      });
      world.replaceItems([item]);
      for (let i = 0; i < 600; i++) world.step();
      expect(world.getSnapshot().items[0].position.y).toBeGreaterThan(2.4);
      expect(world.getPlayerState('standing')!.position.y).toBeGreaterThan(2.8);
      world.removeStatic('platform-a', { ...definition, buildings: [] });
      for (let i = 0; i < 180; i++) world.step();
      expect(world.getSnapshot().items[0].position.y).toBeLessThan(0.7);
      expect(world.getPlayerState('standing')!.position.y).toBeLessThan(1);
    } finally {
      world.dispose();
    }
  });
});
