import { describe, expect, it } from 'vitest';
import { createAuthoritativeWorld } from './server.js';
import { physicsFixture } from './test-fixture.js';

describe('ground spawn for bus arrivals', () => {
  it('stands on the street next to the requested point', async () => {
    const world = await createAuthoritativeWorld(physicsFixture());
    try {
      const center = world.findGroundSpawn([{ x: -7, z: 4 }])!;
      expect(center).toMatchObject({ x: -7, z: 4 });
      expect(center.y).toBeCloseTo(0.92, 1);
      expect(world.checkPlayerSpawnPosition(center)).toEqual({ ok: true });
    } finally {
      world.dispose();
    }
  });

  it('prefers the ground beside a wall to the top of the wall', async () => {
    const world = await createAuthoritativeWorld(physicsFixture());
    try {
      // The fixture wall spans x 4.5…5.5 and is 3 m high; its top is also standable.
      const center = world.findGroundSpawn([{ x: 5, z: 0 }])!;
      expect(center.y).toBeCloseTo(0.92, 1);
      expect(Math.abs(center.x - 5)).toBeGreaterThan(0.5 + 0.35);
      expect(Math.hypot(center.x - 5, center.z)).toBeLessThanOrEqual(3.01);
      expect(world.checkPlayerSpawnPosition(center)).toEqual({ ok: true });
    } finally {
      world.dispose();
    }
  });

  it('steps aside from another player and fails outside the world', async () => {
    const world = await createAuthoritativeWorld(physicsFixture());
    try {
      world.addPlayerAtPosition('waiting', { x: -7, y: 0.92, z: 4 });
      const center = world.findGroundSpawn([{ x: -7, z: 4 }], 'arriving')!;
      expect(Math.hypot(center.x + 7, center.z - 4)).toBeGreaterThan(1);
      expect(world.findGroundSpawn([{ x: 500, z: 500 }])).toBeUndefined();
    } finally {
      world.dispose();
    }
  });
});
