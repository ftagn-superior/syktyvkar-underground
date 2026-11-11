import { describe, expect, it } from 'vitest';
import { buildingFixture } from './test-fixture.js';
import { createAuthoritativeWorld, loadServerWasm } from './server.js';
import { createPredictionWorld } from './prediction.js';
import { createPhysicsWorld } from './physics-world.js';
import { pointInsideClosedMesh, validateClosedMeshTopology } from '@su/contracts';

describe('static building assets', () => {
  it('validates closed mesh topology with welded face vertices and preserves the arch opening', () => {
    const asset = buildingFixture('arch').buildingAssets.arch;
    const mesh = asset.colliders[0];
    if (mesh.kind !== 'mesh') throw new Error('Expected a triangle mesh fixture');
    expect(validateClosedMeshTopology(mesh.vertices, mesh.indices)).toBe(true);
    const separateVertices = mesh.indices.flatMap((index) =>
      mesh.vertices.slice(index * 3, index * 3 + 3),
    );
    const separateIndices = mesh.indices.map((_, index) => index);
    expect(validateClosedMeshTopology(separateVertices, separateIndices)).toBe(true);
    expect(validateClosedMeshTopology(mesh.vertices, mesh.indices.slice(3))).toBe(false);
    expect(validateClosedMeshTopology(mesh.vertices, [...mesh.indices].reverse())).toBe(false);
    expect(pointInsideClosedMesh({ x: -2, y: 1, z: 0 }, mesh.vertices, mesh.indices)).toBe(true);
    expect(pointInsideClosedMesh({ x: 0, y: 1, z: 0 }, mesh.vertices, mesh.indices)).toBe(false);
    expect(pointInsideClosedMesh({ x: -2.5 + 1e-6, y: 1, z: 0 }, mesh.vertices, mesh.indices)).toBe(
      true,
    );
    expect(pointInsideClosedMesh({ x: -2.5 - 1e-6, y: 1, z: 0 }, mesh.vertices, mesh.indices)).toBe(
      false,
    );
    expect(pointInsideClosedMesh({ x: 0, y: 3.25, z: 0 }, mesh.vertices, mesh.indices)).toBe(true);
    const cube = mesh.vertices.slice(0, 24);
    const overlapping = [
      ...cube,
      ...cube.map((value, index) => value + (index % 3 === 0 ? 0.5 : 0)),
    ];
    const unionIndices = [
      ...mesh.indices.slice(0, 36),
      ...mesh.indices.slice(0, 36).map((index) => index + 8),
    ];
    expect(validateClosedMeshTopology(overlapping, unionIndices)).toBe(true);
    expect(pointInsideClosedMesh({ x: -1.75, y: 1, z: 0 }, overlapping, unionIndices)).toBe(true);
    // One positive component must not hide an inward shell and create an empty
    // winding-number overlap where spawn would incorrectly be allowed.
    const smallerInward = cube.map((value, index) =>
      index % 3 === 0 ? -2 + (value + 2) * 0.5 : value * 0.5,
    );
    const mixedVertices = [...cube, ...smallerInward];
    const mixedIndices = [
      ...mesh.indices.slice(0, 36),
      ...mesh.indices
        .slice(0, 36)
        .reverse()
        .map((index) => index + 8),
    ];
    expect(validateClosedMeshTopology(mixedVertices, mixedIndices)).toBe(false);
  });

  it('keeps a compound courtyard open and applies collider and instance rotations', async () => {
    const world = await createAuthoritativeWorld(buildingFixture('courtyard'));
    try {
      expect(world.addPlayer('courtyard', { x: 0, y: 0, z: 0 })).toBeDefined();
      expect(world.addPlayer('wall', { x: -3, y: 0, z: 0 })).toBeUndefined();
      expect(world.addPlayer('rotated-courtyard', { x: 10, y: 0, z: 0 })).toBeDefined();
      expect(world.addPlayer('rotated-wall', { x: 10, y: 0, z: 3 })).toBeUndefined();
      expect(world.addPlayer('outside', { x: -6, y: 0, z: 0 })).toBeDefined();
      world.setInput('courtyard', { moveX: 0, moveZ: 1 });
      world.setInput('rotated-courtyard', { moveX: 1, moveZ: 0 });
      world.setInput('outside', { moveX: 1, moveZ: 0 });
      for (let i = 0; i < 90; i++) world.step();
      const players = new Map(
        world.getSnapshot().players.map((player) => [player.entityId, player]),
      );
      expect(players.get('courtyard')!.position.z).toBeGreaterThan(5.8);
      expect(players.get('rotated-courtyard')!.position.x).toBeGreaterThan(15.8);
      expect(players.get('outside')!.position.x).toBeGreaterThan(-4);
      expect(players.get('outside')!.position.x).toBeLessThan(-3.8);
    } finally {
      world.dispose();
    }
  });

  it('passes through a static triangle-mesh arch while blocking its pillars', async () => {
    const world = await createAuthoritativeWorld(buildingFixture('arch'));
    try {
      expect(world.addPlayer('pass', { x: 0, y: 0, z: -3 })).toBeDefined();
      expect(world.addPlayer('pillar', { x: -2, y: 0, z: -3 })).toBeDefined();
      expect(world.addPlayer('rotated-pass', { x: 7, y: 0, z: 0 })).toBeDefined();
      expect(world.addPlayer('rotated-pillar', { x: 7, y: 0, z: 2 })).toBeDefined();
      expect(world.addPlayer('occupied-pillar', { x: -2, y: 0, z: 0 })).toBeUndefined();
      expect(world.addPlayer('occupied-rotated-pillar', { x: 10, y: 0, z: 2 })).toBeUndefined();
      world.setInput('pass', { moveX: 0, moveZ: 1 });
      world.setInput('pillar', { moveX: 0, moveZ: 1 });
      world.setInput('rotated-pass', { moveX: 1, moveZ: 0 });
      world.setInput('rotated-pillar', { moveX: 1, moveZ: 0 });
      for (let i = 0; i < 90; i++) world.step();
      const players = new Map(
        world.getSnapshot().players.map((player) => [player.entityId, player]),
      );
      expect(players.get('pass')!.position.z).toBeGreaterThan(2.8);
      expect(players.get('pillar')!.position.z).toBeGreaterThan(-1);
      expect(players.get('pillar')!.position.z).toBeLessThan(-0.8);
      expect(players.get('rotated-pass')!.position.x).toBeGreaterThan(12.8);
      expect(players.get('rotated-pillar')!.position.x).toBeGreaterThan(9);
      expect(players.get('rotated-pillar')!.position.x).toBeLessThan(9.2);
    } finally {
      world.dispose();
    }
  });

  it('composes mesh collider translation and rotation with the instance pose', async () => {
    const definition = buildingFixture('arch');
    const asset = definition.buildingAssets.arch;
    asset.colliders[0].position = { x: 2, y: 0, z: 0 };
    asset.colliders[0].rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    asset.bounds = { min: { x: 1.5, y: 0, z: -2.5 }, max: { x: 2.5, y: 3.5, z: 2.5 } };
    const world = await createAuthoritativeWorld(definition);
    try {
      expect(world.addPlayer('solid', { x: 12, y: 0, z: -2 })).toBeUndefined();
      expect(world.addPlayer('surface', { x: 12, y: 0, z: -2.8 })).toBeUndefined();
      expect(world.addPlayer('opening', { x: 10, y: 0, z: -5 })).toBeDefined();
      world.setInput('opening', { moveX: 0, moveZ: 1 });
      for (let i = 0; i < 90; i++) world.step();
      expect(world.getSnapshot().players[0].position.z).toBeGreaterThan(0.8);
    } finally {
      world.dispose();
    }
  });

  it('shares shapes between instances while keeping separate worlds and their disposal independent', async () => {
    const wasm = await loadServerWasm();
    const first = await createPhysicsWorld(buildingFixture('arch'), wasm, false);
    const second = await createPhysicsWorld(buildingFixture('arch'), wasm, false);
    try {
      const buildings = first.physics
        .getBodies()
        .filter((body) => body.transformNode.name.startsWith('building-'));
      expect(buildings).toHaveLength(2);
      expect(buildings[0].shape).toBe(buildings[1].shape);
      expect(first.scene.meshes).toHaveLength(0); // temporary triangle topology was released
      first.dispose();
      first.dispose();
      expect(first.physics.getBodies()).toHaveLength(0);
      expect(second.findSpawn(undefined, { x: 0, y: 0, z: 0 })).toBeDefined();
      expect(second.findSpawn(undefined, { x: -2, y: 0, z: 0 })).toBeUndefined();
      second.createCharacter('live', { x: -2, y: 0.92, z: -3 });
      second.characters.get('live')!.input = { moveX: 0, moveZ: 1 };
      for (let i = 0; i < 90; i++) second.advance(1 / 60);
      expect(second.state('live').position.z).toBeLessThan(-0.8);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it.each(['courtyard', 'arch'] as const)(
    'replays contacts with a rotated %s in the shared prediction world',
    async (kind) => {
      const definition = buildingFixture(kind);
      const server = await createAuthoritativeWorld(definition);
      const prediction = await createPredictionWorld(definition, await loadServerWasm());
      try {
        const spawn = kind === 'arch' ? { x: 7, y: 0, z: 2 } : { x: 4, y: 0, z: 0 };
        expect(server.addPlayer('local', spawn)).toBeDefined();
        const input = { moveX: 1, moveZ: 0 };
        server.setInput('local', input);
        let maximumDrift = 0;
        for (let batch = 0; batch < 30; batch++) {
          const snapshot = server.getSnapshot();
          prediction.reconcile(snapshot.players[0], snapshot);
          for (let step = 0; step < 6; step++) {
            prediction.step(input);
            server.step();
          }
          const a = server.getSnapshot().players[0].position;
          const b = prediction.getState().position;
          maximumDrift = Math.max(maximumDrift, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
        }
        expect(maximumDrift).toBeLessThan(0.05);
        expect(server.getSnapshot().players[0].position.x).toBeLessThan(
          kind === 'arch' ? 9.2 : 6.2,
        );
      } finally {
        server.dispose();
        prediction.dispose();
      }
    },
  );
});
