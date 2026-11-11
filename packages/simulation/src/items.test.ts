import { describe, it, expect } from 'vitest';
import { createPhysicsWorld } from './physics-world.js';
import { createPredictionWorld } from './prediction.js';
import { loadServerWasm } from './server.js';
import { physicsFixture, buildingFixture } from './test-fixture.js';
import { initialItemState } from '@su/contracts';

describe('item placement and dynamic collections in Havok', () => {
  it('I03/I10: checks reach, obstruction, support, full rotated bounds, characters and item contacts', async () => {
    const definition = physicsFixture();
    const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
    const typeId = 'wooden-crate',
      q = { x: 0, y: 0, z: 0, w: 1 };
    try {
      world.createCharacter('a', world.spawnPosition({ x: 0, y: 0, z: 0 }));
      expect(
        world.checkPlacement(typeId, { position: { x: 0, y: 0.515, z: 2 }, rotation: q }, 'a'),
      ).toBeUndefined();
      expect(
        world.checkPlacement(typeId, { position: { x: 0, y: 0.515, z: 4 }, rotation: q }, 'a'),
      ).toBe('OUT_OF_REACH');
      expect(
        world.checkPlacement(typeId, { position: { x: 0, y: 2, z: 2 }, rotation: q }, 'a'),
      ).toBe('NO_SUPPORT');
      expect(
        world.checkPlacement(typeId, { position: { x: 0, y: 0.2, z: 2 }, rotation: q }, 'a'),
      ).toBe('BLOCKED');
      expect(
        world.checkPlacement(typeId, { position: { x: 0, y: 0.515, z: 0 }, rotation: q }, 'a'),
      ).toBe('BLOCKED');
      expect(
        world.checkPlacement(typeId, {
          position: { x: 19.4, y: 0.515, z: 2 },
          rotation: { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) },
        }),
      ).toBe('OUT_OF_BOUNDS');
      world.createCharacter('wall-player', world.spawnPosition({ x: 3.8, y: 0, z: 0 }));
      expect(
        world.checkPlacement(
          typeId,
          { position: { x: 6.2, y: 0.515, z: 0 }, rotation: q },
          'wall-player',
        ),
      ).toBe('BLOCKED');
      expect(world.canReach('wall-player', { x: 6.2, y: 0.515, z: 0 })).toBe('BLOCKED');
      world.addItem(
        initialItemState({
          seedId: 'support',
          typeId,
          position: { x: 0, y: 0.5, z: 2 },
          rotation: q,
        }),
      );
      expect(
        world.checkPlacement(typeId, { position: { x: 0, y: 1.515, z: 2 }, rotation: q }, 'a'),
      ).toBeUndefined();
      expect(
        world.checkPlacement(typeId, { position: { x: 0, y: 0.7, z: 2 }, rotation: q }, 'a'),
      ).toBe('BLOCKED');
      world.removeItem('support');
      world.removeItem('crate-01');
      expect(world.snapshot().items).toEqual([]);
      for (let tick = 0; tick < 30; tick++) world.advance(1 / 60);
      expect(world.state('a').grounded).toBe(true);
      const prediction = await createPredictionWorld(definition, await loadServerWasm());
      try {
        prediction.reconcile(world.state('a'), world.snapshot());
        expect(prediction.step({ moveX: 1, moveZ: 0 }).position.x).toBeGreaterThan(0);
      } finally {
        prediction.dispose();
      }
    } finally {
      world.dispose();
    }
  });

  it('rejects a box wholly inside a solid mesh while allowing an open passage', async () => {
    const definition = buildingFixture('arch');
    const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    try {
      expect(
        world.checkPlacement('wooden-crate', { position: { x: 2, y: 1.5, z: 0 }, rotation }),
      ).toBe('BLOCKED');
      expect(
        world.checkPlacement('wooden-crate', { position: { x: 0, y: 0.515, z: 0 }, rotation }),
      ).toBeUndefined();
    } finally {
      world.dispose();
    }
  });
});
