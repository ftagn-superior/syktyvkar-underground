import { describe, expect, it } from 'vitest';
import { physicsFixture as fixture } from './test-fixture.js';
import { createAuthoritativeWorld, loadServerWasm } from './server.js';
import { createPredictionWorld } from './prediction.js';
import { createPhysicsWorld } from './physics-world.js';
import { NEUTRAL_INPUT } from '@su/contracts';

describe('Havok shared world', () => {
  it('identifies wall and peer ray hits while excluding the local collision body', async () => {
    const world = await createAuthoritativeWorld(fixture());
    const prediction = await createPredictionWorld(fixture(), await loadServerWasm());
    try {
      world.addPlayer('own');
      world.addPlayer('peer', { x: -3, y: 0, z: 0 });
      const snapshot = world.getSnapshot();
      prediction.reconcile(snapshot.players[0], snapshot);
      const eye = { x: 0, y: 1.6, z: 0 };
      expect(prediction.surfaceRay(eye, { x: -3, y: 1.6, z: 0 })?.entityId).toBe('peer');
      expect(prediction.surfaceRay(eye, { x: 8, y: 1.6, z: 0 })?.entityId).toBe('wall');
      expect(prediction.surfaceRay(eye, { x: 0, y: 1.6, z: -3 })).toBeUndefined();
    } finally {
      world.dispose();
      prediction.dispose();
    }
  });
  it('replays independent facing identically, preserves it on neutral and keeps overview movement facing', async () => {
    const definition = fixture();
    const server = await createAuthoritativeWorld(definition);
    const prediction = await createPredictionWorld(definition, await loadServerWasm());
    try {
      server.addPlayer('a');
      const snapshot = server.getSnapshot();
      prediction.reconcile(snapshot.players[0], snapshot);
      for (const input of [
        { moveX: 0, moveZ: 0, facingYaw: Math.PI / 2 },
        { moveX: 0, moveZ: -1, facingYaw: 0 },
        { moveX: -1, moveZ: 0, facingYaw: 0 },
        NEUTRAL_INPUT,
        { ...NEUTRAL_INPUT, facingYaw: NaN },
        { moveX: 1, moveZ: 0 },
      ]) {
        server.setInput('a', input);
        for (let step = 0; step < 6; step++) {
          server.step();
          prediction.step(input);
        }
        const actual = server.getSnapshot().players[0];
        expect(prediction.getState().rotation).toEqual(actual.rotation);
        expect(prediction.getState().position.x).toBeCloseTo(actual.position.x, 4);
        expect(prediction.getState().position.z).toBeCloseTo(actual.position.z, 4);
        const yaw = input.moveX === 1 || input.facingYaw === Math.PI / 2 ? Math.PI / 2 : 0;
        expect(actual.rotation.y).toBeCloseTo(Math.sin(yaw / 2));
        // Replay an authoritative correction followed by the same command.
        prediction.reconcile(actual, server.getSnapshot());
      }
    } finally {
      server.dispose();
      prediction.dispose();
    }
  });
  it('accepts structural input fields exposed through prototype accessors', async () => {
    class Input {
      get moveX() {
        return 1;
      }
      get moveZ() {
        return 0;
      }
      get sprint() {
        return true;
      }
    }
    const definition = fixture();
    const server = await createAuthoritativeWorld(definition);
    const prediction = await createPredictionWorld(definition, await loadServerWasm());
    try {
      server.addPlayer('a');
      prediction.reconcile(server.getSnapshot().players[0], server.getSnapshot());
      server.setInput('a', new Input());
      for (let i = 0; i < 30; i++) {
        server.step();
        prediction.step(new Input());
      }
      expect(server.getSnapshot().players[0].position.x).toBeGreaterThan(4);
      expect(prediction.getState().position.x).toBeGreaterThan(4);
    } finally {
      server.dispose();
      prediction.dispose();
    }
  });
  it.each([
    { moveX: -1, moveZ: 0 },
    { moveX: -1, moveZ: -1 },
  ])('switches between walking, sprinting and stopping with input %j', async (direction) => {
    const definition = fixture();
    const server = await createAuthoritativeWorld(definition);
    const prediction = await createPredictionWorld(definition, await loadServerWasm());
    try {
      server.addPlayer('a');
      const snapshot = server.getSnapshot();
      prediction.reconcile(snapshot.players[0], snapshot);
      for (const sprint of [false, true, false]) {
        const input = { ...direction, sprint };
        server.setInput('a', input);
        const start = server.getSnapshot().players[0].position;
        for (let i = 0; i < 30; i++) {
          server.step();
          prediction.step(input);
        }
        const actual = server.getSnapshot().players[0];
        const expectedSpeed = sprint ? 14 : 4;
        expect(Math.hypot(actual.velocity.x, actual.velocity.z)).toBeCloseTo(expectedSpeed, 3);
        expect(Math.hypot(actual.position.x - start.x, actual.position.z - start.z)).toBeCloseTo(
          expectedSpeed / 2,
          2,
        );
        const predicted = prediction.getState().position;
        expect(
          Math.hypot(actual.position.x - predicted.x, actual.position.z - predicted.z),
        ).toBeLessThan(0.001);
      }
      server.setInput('a', NEUTRAL_INPUT);
      server.step();
      prediction.step(NEUTRAL_INPUT);
      expect(server.getSnapshot().players[0].velocity.x).toBeCloseTo(0, 5);
      expect(server.getSnapshot().players[0].velocity.z).toBeCloseTo(0, 5);
      expect(prediction.getState().velocity.x).toBeCloseTo(0, 5);
      expect(prediction.getState().velocity.z).toBeCloseTo(0, 5);
    } finally {
      server.dispose();
      prediction.dispose();
    }
  });
  it('steps without rendering, blocks walls and releases all owned bodies', async () => {
    const world = await createAuthoritativeWorld(fixture());
    try {
      expect(world.addPlayer('a')).toBeDefined();
      world.setInput('a', { moveX: 1, moveZ: 0 });
      for (let i = 0; i < 180; i++) world.step();
      const player = world.getSnapshot().players[0];
      expect(player.position.x).toBeGreaterThan(4);
      expect(player.position.x).toBeLessThan(4.2);
      expect(player.position.y).toBeCloseTo(0.9, 1);
      const initial = world.diagnostics().bodies;
      for (let i = 0; i < 20; i++) {
        expect(world.addPlayer('b')).toBeDefined();
        world.removePlayer('b');
      }
      expect(world.diagnostics().bodies).toBe(initial);
    } finally {
      world.dispose();
    }
    expect(world.diagnostics()).toEqual({ bodies: 0, players: 0 });
  });
  it('keeps the same elapsed time with one and eight characters', async () => {
    const definition = fixture();
    definition.spawnPoints = Array.from({ length: 8 }, (_, n) => ({ x: -8 + n * 2, y: 0, z: -8 }));
    definition.initialItems[0].position.y = 5;
    const one = await createAuthoritativeWorld(definition);
    const eight = await createAuthoritativeWorld(definition);
    try {
      one.addPlayer('a');
      for (let i = 0; i < 8; i++) expect(eight.addPlayer(`p${i}`)).toBeDefined();
      for (let i = 0; i < 30; i++) {
        one.step();
        eight.step();
      }
      expect(eight.getSnapshot().items[0].position.y).toBeCloseTo(
        one.getSnapshot().items[0].position.y,
        5,
      );
    } finally {
      one.dispose();
      eight.dispose();
    }
  });
  it.each([false, true])('keeps head-on controllers separated (sprint: %s)', async (sprint) => {
    const world = await createAuthoritativeWorld(fixture());
    try {
      world.addPlayer('a', { x: -2, y: 0, z: 0 });
      world.addPlayer('b', { x: 2, y: 0, z: 0 });
      world.setInput('a', { moveX: 1, moveZ: 0, sprint });
      world.setInput('b', { moveX: -1, moveZ: 0, sprint });
      for (let i = 0; i < 240; i++) {
        world.step();
        if (i >= 120) {
          const [a, b] = world.getSnapshot().players;
          expect(b.position.x - a.position.x).toBeGreaterThan(0.695);
        }
      }
      const [a, b] = world.getSnapshot().players;
      expect(b.position.x - a.position.x).toBeGreaterThan(0.65);
      expect(Math.abs(a.position.x)).toBeLessThan(0.6);
      expect(Math.abs(b.position.x)).toBeLessThan(0.6);
    } finally {
      world.dispose();
    }
  });
  it.each([false, true])(
    'pushes the real dynamic crate and refuses occupied spawns (sprint: %s)',
    async (sprint) => {
      const world = await createAuthoritativeWorld(fixture());
      try {
        expect(world.addPlayer('a', { x: 0, y: 0, z: 3 })).toBeDefined();
        expect(world.addPlayer('b', { x: 0, y: 0, z: 3 })).toBeUndefined();
        world.setInput('a', { moveX: 0, moveZ: 1, sprint });
        // Sample sprint contact before the fast crate can leave the test world and reset.
        for (let i = 0; i < (sprint ? 60 : 120); i++) world.step();
        expect(world.getSnapshot().items[0].position.z).toBeGreaterThan(7);
        expect(world.respawnPlayer('a')).toBe(true);
        expect(world.getSnapshot().players[0].revision).toBe(1);
        world.step();
        expect(world.getSnapshot().players[0].velocity.x).toBeCloseTo(0, 5);
        expect(world.getSnapshot().players[0].velocity.z).toBeCloseTo(0, 5);
      } finally {
        world.dispose();
      }
    },
  );
  it('returns a lost instance near an occupied safe pose without replacing its ID', async () => {
    const definition = fixture();
    const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
    try {
      const item = world.objects.get('crate-01')!;
      const start = { ...item.definition.position };
      world.teleport(item.body, item.node, { x: definition.bounds.max.x + 2, y: 2, z: start.z });
      world.createCharacter('occupant', world.spawnPosition({ x: start.x, y: 0, z: start.z }));
      world.advance(1 / 60);
      const returned = world.snapshot().items[0];
      expect(returned.entityId).toBe('crate-01');
      expect(returned.position.x).toBeLessThan(definition.bounds.max.x);
      expect(returned.position).not.toEqual(start);
      expect(returned.revision).toBe(1);
      expect(world.snapshot().items).toHaveLength(1);
      expect(
        world.checkPlacement(
          returned.typeId,
          { position: returned.position, rotation: returned.rotation },
          undefined,
          returned.entityId,
        ),
      ).toBeUndefined();
    } finally {
      world.dispose();
    }
  });
  it.each([false, true])(
    'restores and replays at a wall without accumulating drift (sprint: %s)',
    async (sprint) => {
      const definition = fixture();
      const server = await createAuthoritativeWorld(definition);
      const prediction = await createPredictionWorld(definition, await loadServerWasm());
      try {
        server.addPlayer('a');
        const input = { moveX: 1, moveZ: 0, sprint };
        server.setInput('a', input);
        let maximumDrift = 0;
        for (let batch = 0; batch < 60; batch++) {
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
        expect(server.getSnapshot().players[0].position.x).toBeGreaterThan(4);
        expect(server.getSnapshot().players[0].position.x).toBeLessThan(4.2);
      } finally {
        server.dispose();
        prediction.dispose();
      }
    },
  );
  it.each([false, true])(
    'replays diagonal movement into an inside corner (sprint: %s)',
    async (sprint) => {
      const definition = fixture();
      definition.entities[1].size.z = 40;
      definition.entities.push({
        ...definition.entities[1],
        entityId: 'corner',
        position: { x: 0, y: 1.5, z: 3 },
        size: { x: 10, y: 3, z: 1 },
      });
      const server = await createAuthoritativeWorld(definition);
      const prediction = await createPredictionWorld(definition, await loadServerWasm());
      try {
        server.addPlayer('a');
        let maximumDrift = 0;
        for (let batch = 0; batch < 60; batch++) {
          const snapshot = server.getSnapshot();
          prediction.reconcile(snapshot.players[0], snapshot);
          const input = { moveX: 1, moveZ: batch < 40 ? 1 : -1, sprint };
          server.setInput('a', input);
          for (let step = 0; step < 6; step++) {
            prediction.step(input);
            server.step();
          }
          const a = server.getSnapshot().players[0].position;
          const b = prediction.getState().position;
          maximumDrift = Math.max(maximumDrift, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
          expect(a.x).toBeLessThan(4.2);
          expect(a.z).toBeLessThan(2.2);
        }
        expect(maximumDrift).toBeLessThan(0.05);
      } finally {
        server.dispose();
        prediction.dispose();
      }
    },
  );
  it('produces the same simulation when the outer render cadence is 30, 60 or 120 Hz', async () => {
    const results = [];
    for (const fps of [30, 60, 120]) {
      const world = await createAuthoritativeWorld(fixture());
      try {
        world.addPlayer('a');
        world.setInput('a', { moveX: 1, moveZ: 0 });
        let accumulator = 0;
        for (let frame = 0; frame < fps * 3; frame++) {
          accumulator += 1 / fps;
          while (accumulator + 1e-10 >= 1 / 60) {
            world.step();
            accumulator -= 1 / 60;
          }
        }
        results.push(world.getSnapshot());
      } finally {
        world.dispose();
      }
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });
  it.each([3, 6, 12])(
    'bounds crate-proxy replay discrepancy for %i unacknowledged steps',
    async (steps) => {
      const definition = fixture();
      const server = await createAuthoritativeWorld(definition);
      const prediction = await createPredictionWorld(definition, await loadServerWasm());
      try {
        server.addPlayer('a', { x: -0.25, y: 0, z: 3 });
        server.addPlayer('b', { x: 0.5, y: 0, z: 3 });
        const input = { moveX: 0, moveZ: 1 };
        server.setInput('a', input);
        server.setInput('b', input);
        const corrections = [];
        for (let batch = 0; batch < 40; batch++) {
          const snapshot = server.getSnapshot();
          prediction.reconcile(snapshot.players[0], snapshot);
          for (let step = 0; step < steps; step++) {
            prediction.step(input);
            server.step();
          }
          const a = server.getSnapshot().players[0].position;
          const b = prediction.getState().position;
          corrections.push(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
        }
        corrections.sort((a, b) => a - b);
        expect(corrections[Math.floor(corrections.length * 0.95)]).toBeLessThan(
          steps === 12 ? 1 : 0.5,
        );
        expect(server.getSnapshot().items[0].position.z).toBeGreaterThan(6);
      } finally {
        server.dispose();
        prediction.dispose();
      }
    },
  );
});
