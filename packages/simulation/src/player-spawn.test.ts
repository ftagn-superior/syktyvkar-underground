import { describe, expect, it } from 'vitest';
import type { Vec3, WorldDefinition } from '@su/contracts';
import { createAuthoritativeWorld, loadServerWasm } from './server.js';
import { createPhysicsWorld } from './physics-world.js';
import { buildingFixture, physicsFixture } from './test-fixture.js';

const center = { x: 0, y: 0.92, z: 0 };

describe('safe player body-center spawns', () => {
  it('restores the exact center without adding authoring height and starts with neutral motion', async () => {
    const world = await createAuthoritativeWorld(physicsFixture());
    try {
      const saved = { x: -7.125, y: 0.92, z: 8.375 };
      expect(world.addPlayerAtPosition('saved', saved)?.position).toEqual(saved);
      expect(world.getPlayerState('saved')?.velocity).toEqual({ x: 0, y: 0, z: 0 });
      for (let i = 0; i < 60; i++) world.step();
      const settled = world.getPlayerState('saved')!.position;
      expect(settled.x).toBe(saved.x);
      expect(settled.z).toBe(saved.z);
      expect(Math.abs(settled.y - saved.y)).toBeLessThan(0.05);
      expect(world.checkPlayerSpawnPosition(settled, 'saved')).toEqual({ ok: true });
      world.setInput('saved', { moveX: 1, moveZ: 0, sprint: true });
      world.step();
      const revision = world.getPlayerState('saved')!.revision;
      expect(world.respawnPlayerAtPosition('saved', saved)).toBe(true);
      expect(world.getPlayerState('saved')!.revision).toBe(revision + 1);
      expect(world.getPlayerState('saved')!.velocity).toEqual({ x: 0, y: 0, z: 0 });
      world.step();
      expect(world.getPlayerState('saved')!.position.x).toBe(saved.x);
    } finally {
      world.dispose();
    }
  });

  it('checks the full capsule, finite values, wall, items and other characters', async () => {
    const world = await createAuthoritativeWorld(physicsFixture());
    try {
      for (const position of [
        { x: NaN, y: 0.92, z: 0 },
        { x: 0, y: Infinity, z: 0 },
        { x: 0, y: 0.92, z: -Infinity },
      ])
        expect(world.checkPlayerSpawnPosition(position)).toEqual({
          ok: false,
          reason: 'INVALID_POSITION',
        });
      for (const position of [
        { ...center, x: 19.66 },
        { ...center, x: -19.66 },
        { ...center, z: 19.66 },
        { ...center, z: -19.66 },
        { ...center, y: 9.11 },
        { ...center, y: -9.11 },
      ])
        expect(world.checkPlayerSpawnPosition(position)).toEqual({
          ok: false,
          reason: 'OUT_OF_BOUNDS',
        });
      expect(world.checkPlayerSpawnPosition({ ...center, x: 4.3 })).toEqual({
        ok: false,
        reason: 'BLOCKED',
      });
      expect(world.checkPlayerSpawnPosition({ ...center, z: 6 })).toEqual({
        ok: false,
        reason: 'BLOCKED',
      });
      expect(world.checkPlayerSpawnPosition({ ...center, y: 0.896 })).toEqual({ ok: true });
      expect(world.checkPlayerSpawnPosition({ ...center, y: 0.894 })).toEqual({
        ok: false,
        reason: 'BLOCKED',
      });
      expect(world.addPlayerAtPosition('first', center)).toBeDefined();
      expect(world.checkPlayerSpawnPosition(center)).toEqual({ ok: false, reason: 'BLOCKED' });
      expect(world.addPlayerAtPosition('second', center)).toBeUndefined();
      expect(world.checkPlayerSpawnPosition(center, 'first')).toEqual({ ok: true });
      expect(world.getSnapshot().players).toHaveLength(1);
    } finally {
      world.dispose();
    }
  });

  it('requires nearby static support, rejects suspended bodies and leaves queries side-effect free', async () => {
    const world = await createPhysicsWorld(physicsFixture(), await loadServerWasm(), false);
    try {
      world.createCharacter('support', center);
      const before = world.snapshot();
      const resources = world.staticDiagnostics();
      for (let i = 0; i < 20; i++) {
        expect(world.checkPlayerSpawnPosition({ x: -3, y: 0.92, z: 0 })).toEqual({ ok: true });
        expect(world.checkPlayerSpawnPosition({ x: -3, y: 1.1, z: 0 })).toEqual({
          ok: false,
          reason: 'NO_SUPPORT',
        });
        expect(world.checkPlayerSpawnPosition({ x: 0, y: 1.94, z: 6 })).toEqual({
          ok: false,
          reason: 'UNSTABLE_SUPPORT',
        });
        expect(world.checkPlayerSpawnPosition({ x: 0, y: 2.74, z: 0 })).toEqual({
          ok: false,
          reason: 'UNSTABLE_SUPPORT',
        });
      }
      expect(world.snapshot()).toEqual(before);
      expect(world.staticDiagnostics()).toEqual(resources);
    } finally {
      world.dispose();
    }
  });

  it('preserves old floorless probe semantics while refusing unsafe default spawns', async () => {
    const definition = physicsFixture();
    definition.entities = [];
    definition.initialItems = [];
    const world = await createAuthoritativeWorld(definition);
    try {
      expect(world.findDefaultPlayerSpawn()).toBeUndefined();
      expect(world.checkPlayerSpawnPosition(center)).toEqual({ ok: false, reason: 'NO_SUPPORT' });
      expect(world.addPlayerAtPosition('new', center)).toBeUndefined();
      expect(world.findSpawn()).toBeUndefined(); // Terrain/layout validation remains strict.
      expect(world.addPlayer('legacy')).toBeDefined();
      expect(world.addPlayer('overlapping-legacy', definition.spawnPoints[0])).toBeUndefined();
      expect(world.respawnPlayer('legacy')).toBe(true);
      expect(world.respawnPlayerAtPosition('legacy', center)).toBe(false);
    } finally {
      world.dispose();
    }
  });

  it('selects ordinary points in authoring order and skips occupied points', async () => {
    const world = await createAuthoritativeWorld(physicsFixture());
    try {
      expect(world.getDefaultPlayerSpawnPosition()).toEqual(center);
      expect(world.findDefaultPlayerSpawn()).toEqual(center);
      world.addPlayerAtPosition('first', center);
      expect(world.findDefaultPlayerSpawn()).toEqual({ x: -3, y: 0.92, z: 0 });
      world.addPlayerAtPosition('second', world.findDefaultPlayerSpawn()!);
      expect(world.findDefaultPlayerSpawn()).toEqual({ x: 0, y: 0.92, z: 3 });
      world.addPlayerAtPosition('third', world.findDefaultPlayerSpawn()!);
      expect(world.findDefaultPlayerSpawn()).toBeUndefined();
      expect(world.findDefaultPlayerSpawn('first')).toEqual(center);
    } finally {
      world.dispose();
    }
  });

  it('rejects a low ceiling and a capsule wholly enclosed by a closed building mesh', async () => {
    const definition = buildingFixture('arch');
    const mesh = definition.buildingAssets.arch.colliders[0];
    if (mesh.kind !== 'mesh') throw new Error('Expected a mesh');
    definition.buildingAssets.arch = {
      ...definition.buildingAssets.arch,
      colliders: [
        {
          ...mesh,
          vertices: mesh.vertices
            .slice(0, 24)
            .map((v, i) => (i % 3 === 0 ? v * 8 + 16 : i % 3 === 2 ? v * 8 : v * 4)),
          indices: mesh.indices.slice(0, 36),
        },
      ],
    };
    definition.buildings = definition.buildings.slice(0, 1);
    const enclosed = await createAuthoritativeWorld(definition);
    const lowCeiling = physicsFixture();
    lowCeiling.entities.push({
      ...lowCeiling.entities[1],
      entityId: 'ceiling',
      position: { x: -3, y: 1.75, z: 0 },
      size: { x: 3, y: 0.2, z: 3 },
    });
    const ceiling = await createAuthoritativeWorld(lowCeiling);
    try {
      expect(enclosed.checkPlayerSpawnPosition(center)).toEqual({ ok: false, reason: 'BLOCKED' });
      expect(ceiling.checkPlayerSpawnPosition({ ...center, x: -3 })).toEqual({
        ok: false,
        reason: 'BLOCKED',
      });
    } finally {
      enclosed.dispose();
      ceiling.dispose();
    }
  });

  it.each([30, 65])('uses actual static slope normals at %s degrees', async (angle) => {
    const definition: WorldDefinition = physicsFixture();
    definition.entities = [];
    definition.initialItems = [];
    const radians = (angle * Math.PI) / 180;
    definition.buildingAssets.slope = {
      assetId: 'slope',
      bounds: { min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } },
      colliders: [
        {
          id: 'slope',
          kind: 'box',
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: Math.sin(radians / 2), w: Math.cos(radians / 2) },
          size: { x: 20, y: 0.4, z: 20 },
          friction: 0.6,
          restitution: 0,
        },
      ],
    };
    definition.buildings = [
      {
        entityId: 'slope',
        assetId: 'slope',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    ];
    const world = await createAuthoritativeWorld(definition);
    const position: Vec3 = {
      x: 0,
      y: (0.2 + 0.35 + 0.55 * Math.cos(radians)) / Math.cos(radians) + 0.02,
      z: 0,
    };
    try {
      expect(world.checkPlayerSpawnPosition(position)).toEqual(
        angle === 30 ? { ok: true } : { ok: false, reason: 'STEEP_SUPPORT' },
      );
    } finally {
      world.dispose();
    }
  });
});
