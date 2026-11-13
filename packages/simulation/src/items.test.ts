import { describe, it, expect } from 'vitest';
import { createPhysicsWorld } from './physics-world.js';
import { createPredictionWorld } from './prediction.js';
import { AuthoritativeWorld } from './authoritative-world.js';
import { loadServerWasm } from './server.js';
import { physicsFixture, buildingFixture } from './test-fixture.js';
import { initialItemState, itemSupportDistance } from '@su/contracts';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

describe('item placement and dynamic collections in Havok', () => {
  it('reconciles item placements without resetting live motion or touching static geometry', async () => {
    const definition = physicsFixture();
    const physics = await createPhysicsWorld(definition, await loadServerWasm(), false);
    const world = new AuthoritativeWorld(physics);
    try {
      const saved = world.getSnapshot().items[0];
      const floor = physics.objects.get(definition.entities[0].entityId);
      const body = physics.objects.get(saved.entityId)!.body;
      body.setLinearVelocity(new Vector3(2, 0, 0));
      for (let tick = 0; tick < 10; tick++) world.step();
      const moving = world.getSnapshot().items[0];
      expect(moving.position.x).toBeGreaterThan(saved.position.x);

      world.reconcileItems([saved]);
      expect(world.getSnapshot().items).toEqual([moving]);
      expect(physics.objects.get(saved.entityId)!.body).toBe(body);

      const placed = {
        ...saved,
        placementVersion: saved.placementVersion + 1,
        position: { x: -5, y: 2, z: -5 },
        velocity: { x: 1, y: 0, z: 0 },
      };
      world.reconcileItems([placed]);
      expect(world.getSnapshot().items[0]).toMatchObject({
        placementVersion: placed.placementVersion,
        position: placed.position,
        velocity: placed.velocity,
      });
      expect(physics.objects.get(saved.entityId)!.body).not.toBe(body);

      world.reconcileItems([]);
      expect(world.getSnapshot().items).toEqual([]);
      expect(physics.staticDiagnostics().items).toBe(0);
      expect(physics.objects.get(definition.entities[0].entityId)).toBe(floor);
      world.reconcileItems([placed]);
      expect(world.getSnapshot().items).toHaveLength(1);
      world.replaceItems([]);
      expect(physics.staticDiagnostics().items).toBe(0);
    } finally {
      world.dispose();
    }
    expect(physics.staticDiagnostics()).toMatchObject({ items: 0, bodies: 0 });
  });

  it('validates saved airborne dynamics separately from supported placement without changing state', async () => {
    const world = await createPhysicsWorld(physicsFixture(), await loadServerWasm(), false);
    try {
      const saved = initialItemState({
        seedId: 'airborne',
        typeId: 'wooden-crate',
        position: { x: -5, y: 3, z: -5 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      });
      saved.velocity = { x: 1, y: 2, z: 3 };
      saved.safePose = { position: { x: -5, y: 0.515, z: -5 }, rotation: saved.rotation };
      const before = structuredClone(saved);
      expect(world.checkSavedItem(saved)).toBeUndefined();
      expect(saved).toEqual(before);
      expect(world.checkPlacement(saved.typeId, saved)).toBe('NO_SUPPORT');
      expect(world.checkSavedItem({ ...saved, position: { x: 5, y: 1.5, z: 0 } })).toBe('BLOCKED');
      expect(
        world.checkSavedItem({
          ...saved,
          safePose: { ...saved.safePose, position: { x: 21, y: 1, z: 0 } },
        }),
      ).toBe('OUT_OF_BOUNDS');
      expect(world.checkSavedItem({ ...saved, typeId: 'removed-type' })).toBe('INVALID_INPUT');
    } finally {
      world.dispose();
    }
  });

  it('places the new shapes using their actual rotated support and rejects penetrations', async () => {
    const definition = physicsFixture();
    const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
    try {
      for (const typeId of [
        'confidence-monument',
        'giant-soap',
        'giant-domino',
        'watermelon-ball',
      ]) {
        const type = definition.itemCatalog.types[typeId];
        for (const angle of [0, Math.PI / 4, Math.PI / 2]) {
          const rotation = { x: Math.sin(angle / 2), y: 0, z: 0, w: Math.cos(angle / 2) };
          const height = itemSupportDistance(type, rotation, { x: 0, y: -1, z: 0 });
          const pose = { position: { x: -5, y: height + 0.015, z: -5 }, rotation };
          expect(world.checkPlacement(typeId, pose), `${typeId} at ${angle}`).toBeUndefined();
          expect(
            world.checkPlacement(typeId, {
              ...pose,
              position: { ...pose.position, y: height - 0.1 },
            }),
          ).toBe('BLOCKED');
          expect(
            world.checkPlacement(typeId, {
              ...pose,
              position: { ...pose.position, y: height + 0.5 },
            }),
          ).toBe('NO_SUPPORT');
          world.addItem(initialItemState({ seedId: 'shape', typeId, ...pose }));
          expect(world.checkPlacement(typeId, pose)).toBe('BLOCKED');
          expect(world.checkPlacement(typeId, pose, undefined, 'shape')).toBeUndefined();
          for (let tick = 0; tick < 60; tick++) {
            world.advance(1 / 60);
            const state = world.snapshot().items.find((item) => item.entityId === 'shape')!;
            const bottom =
              state.position.y - itemSupportDistance(type, state.rotation, { x: 0, y: -1, z: 0 });
            expect(bottom, `${typeId} must not fall through the floor at ${angle}`).toBeGreaterThan(
              -0.03,
            );
          }
          world.removeItem('shape');
        }
      }
    } finally {
      world.dispose();
    }
  });
  it('rejects round and compound items enclosed by a solid mesh and allows the open arch', async () => {
    const definition = buildingFixture('arch');
    definition.buildings = definition.buildings.slice(0, 1);
    const asset = definition.buildingAssets.arch;
    for (const bound of [asset.bounds.min, asset.bounds.max])
      for (const axis of ['x', 'y', 'z'] as const) bound[axis] *= 2;
    for (const collider of asset.colliders)
      if (collider.kind === 'mesh')
        collider.vertices = collider.vertices.map((coordinate) => coordinate * 2);
    const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    try {
      for (const typeId of ['watermelon-ball', 'confidence-monument']) {
        expect(world.checkPlacement(typeId, { position: { x: 4, y: 3, z: 0 }, rotation })).toBe(
          'BLOCKED',
        );
        expect(
          world.checkPlacement(typeId, {
            position: { x: 0, y: definition.itemCatalog.types[typeId].size.y / 2 + 0.015, z: 0 },
            rotation,
          }),
        ).toBeUndefined();
      }
    } finally {
      world.dispose();
    }
  });
  it('keeps the space around a compound silhouette empty on the server and in prediction', async () => {
    const definition = physicsFixture();
    definition.entities.push({
      entityId: 'narrow-post',
      kind: 'obstacle',
      position: { x: -4.25, y: 3.4, z: -5 },
      size: { x: 0.2, y: 0.8, z: 0.2 },
      mass: 0,
      friction: 0.6,
      restitution: 0,
      color: '#ffffff',
    });
    const pose = { position: { x: -5, y: 2.015, z: -5 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    for (const prediction of [false, true]) {
      const world = await createPhysicsWorld(definition, await loadServerWasm(), prediction);
      try {
        expect(world.checkPlacement('confidence-monument', pose)).toBeUndefined();
        expect(
          world.checkPlacement('confidence-monument', {
            ...pose,
            position: { ...pose.position, x: -4.65 },
          }),
        ).toBe('BLOCKED');
        world.addItem(
          initialItemState({ seedId: 'monument', typeId: 'confidence-monument', ...pose }),
        );
        expect(
          world.surfaceRay({ x: -4.3, y: 2.5, z: -7 }, { x: -4.3, y: 2.5, z: -3 }),
        ).toBeUndefined();
        expect(world.surfaceRay({ x: -5, y: 2.5, z: -7 }, { x: -5, y: 2.5, z: -3 })).toBeDefined();
        world.removeItem('monument');
        expect(
          world.surfaceRay({ x: -5, y: 2.5, z: -7 }, { x: -5, y: 2.5, z: -3 }),
        ).toBeUndefined();
      } finally {
        world.dispose();
      }
    }
  });
  it('allows a rotated sphere at the map edge without reserving imaginary box corners', async () => {
    const world = await createPhysicsWorld(physicsFixture(), await loadServerWasm(), false);
    const rotation = { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) };
    try {
      expect(
        world.checkPlacement('watermelon-ball', {
          position: { x: 19.39, y: 0.615, z: -5 },
          rotation,
        }),
      ).toBeUndefined();
      expect(
        world.checkPlacement('watermelon-ball', {
          position: { x: 19.5, y: 0.615, z: -5 },
          rotation,
        }),
      ).toBe('OUT_OF_BOUNDS');
    } finally {
      world.dispose();
    }
  });
  it('bounces and rolls the ball, slides the soap, and keeps the monument supported', async () => {
    const world = await createPhysicsWorld(physicsFixture(), await loadServerWasm(), false);
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    try {
      for (const [typeId, x, y, z] of [
        ['giant-soap', -12, 0.24, -10],
        ['wooden-crate', -12, 0.515, -7],
        ['watermelon-ball', -12, 3, -4],
        ['confidence-monument', -5, 2.015, -10],
      ] as const) {
        const state = initialItemState({ seedId: typeId, typeId, position: { x, y, z }, rotation });
        if (typeId !== 'confidence-monument') state.velocity.x = 3;
        world.addItem(state);
      }
      let bounced = false,
        rolled = false;
      for (let tick = 0; tick < 180; tick++) {
        world.advance(1 / 60);
        const ball = world.snapshot().items.find((item) => item.entityId === 'watermelon-ball')!;
        bounced ||= ball.velocity.y > 0.8;
        rolled ||= Math.abs(ball.angularVelocity.z) > 0.2;
        expect(ball.position.y).toBeGreaterThan(0.5);
      }
      const items = world.snapshot().items;
      expect(bounced).toBe(true);
      expect(rolled).toBe(true);
      expect(items.find((item) => item.entityId === 'giant-soap')!.position.x).toBeGreaterThan(
        items.find((item) => item.entityId === 'wooden-crate')!.position.x + 1,
      );
      expect(items.find((item) => item.entityId === 'confidence-monument')!.position.y).toBeCloseTo(
        2,
        1,
      );
      // Restoring a snapshot recreates the same compound and spherical collision geometry.
      const restored = await createPhysicsWorld(physicsFixture(), await loadServerWasm(), false);
      try {
        restored.replaceItems(items);
        for (const actual of restored.snapshot().items) {
          const expected = items.find((item) => item.entityId === actual.entityId)!;
          expect(actual.typeId).toBe(expected.typeId);
          expect(actual.safePose).toEqual(expected.safePose);
          for (const field of ['position', 'rotation', 'velocity', 'angularVelocity'] as const)
            for (const axis of Object.keys(
              expected[field],
            ) as (keyof (typeof expected)[typeof field])[])
              expect(actual[field][axis]).toBeCloseTo(expected[field][axis], 5);
        }
        expect(restored.surfaceRay({ x: -5, y: 3, z: -12 }, { x: -5, y: 3, z: -8 })).toBeDefined();
      } finally {
        restored.dispose();
      }
    } finally {
      world.dispose();
    }
  });
  it('transmits a toppling impulse through a chain of tall dominoes', async () => {
    const world = await createPhysicsWorld(physicsFixture(), await loadServerWasm(), false);
    try {
      for (let index = 0; index < 3; index++)
        world.addItem(
          initialItemState({
            seedId: `domino-${index}`,
            typeId: 'giant-domino',
            position: { x: -10, y: 1.015, z: -12 + index * 1.2 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          }),
        );
      for (let tick = 0; tick < 30; tick++) world.advance(1 / 60);
      world.objects
        .get('domino-0')!
        .body.applyImpulse(new Vector3(0, 0, 6), new Vector3(-10, 1.8, -12));
      for (let tick = 0; tick < 240; tick++) world.advance(1 / 60);
      for (const item of world.snapshot().items.filter((item) => item.typeId === 'giant-domino'))
        expect(Math.abs(item.rotation.x)).toBeGreaterThan(0.4);
    } finally {
      world.dispose();
    }
  });
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
