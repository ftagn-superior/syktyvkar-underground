import { describe, expect, it } from 'vitest';
import { createAuthoritativeWorld } from './server';
import { physicsFixture } from './test-fixture';

describe('cosmetic ground animation space', () => {
  it('accepts a free static floor, rejects walls, items, players and boundaries, and never changes physics', async () => {
    const world = await createAuthoritativeWorld(physicsFixture());
    try {
      world.addPlayer('p');
      for (let i = 0; i < 90; i++) world.step();
      const before = world.getPlayerState('p');
      for (let i = 0; i < 60; i++) expect(world.checkAnimationSpace('p')).toBe(true);
      expect(world.getPlayerState('p')).toEqual(before);
      expect(world.checkAnimationSpace('missing')).toBe(false);
      world.addPlayer('near', { x: 1, y: 0, z: 0 });
      expect(world.checkAnimationSpace('p')).toBe(false);
      world.removePlayer('near');
      expect(world.checkAnimationSpace('p')).toBe(true);
      world.addPlayer('wall', { x: 3.6, y: 0, z: 0 });
      world.addPlayer('item', { x: 0, y: 0, z: 4.8 });
      world.addPlayer('edge', { x: 19, y: 0, z: -10 });
      for (let i = 0; i < 90; i++) world.step();
      for (const id of ['wall', 'item', 'edge'])
        expect(world.checkAnimationSpace(id), id).toBe(false);
      world.setInput('p', { moveX: 1, moveZ: 0 });
      for (let i = 0; i < 180; i++) world.step();
      expect(world.getPlayerState('p')!.position.x).toBeLessThan(4.3);
    } finally {
      world.dispose();
    }
  });
  it('rejects an upright capsule on a narrow ledge whose ground pose has no surrounding support', async () => {
    const definition = physicsFixture();
    definition.initialItems = [];
    definition.entities = [definition.entities[0]];
    definition.entities[0].size = { x: 2, y: 1, z: 2 };
    const world = await createAuthoritativeWorld(definition);
    try {
      world.addPlayer('p');
      for (let i = 0; i < 90; i++) world.step();
      expect(world.getPlayerState('p')!.grounded).toBe(true);
      expect(world.checkAnimationSpace('p')).toBe(false);
    } finally {
      world.dispose();
    }
  });
});
