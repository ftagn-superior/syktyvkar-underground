import { describe, expect, it } from 'vitest';
import { physicsFixture as fixture } from './test-fixture.js';
import { createAuthoritativeWorld, loadServerWasm } from './server.js';
import { createPredictionWorld } from './prediction.js';
import { createPhysicsWorld } from './physics-world.js';

describe('Havok shared world', () => {
  it('accepts structural input fields exposed through prototype accessors', async () => {
    class Input {
      get moveX() {
        return 1;
      }
      get moveZ() {
        return 0;
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
      expect(server.getSnapshot().players[0].position.x).toBeGreaterThan(1.9);
      expect(prediction.getState().position.x).toBeGreaterThan(1.9);
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
    definition.entities[2].position.y = 5;
    const one = await createAuthoritativeWorld(definition);
    const eight = await createAuthoritativeWorld(definition);
    try {
      one.addPlayer('a');
      for (let i = 0; i < 8; i++) expect(eight.addPlayer(`p${i}`)).toBeDefined();
      for (let i = 0; i < 30; i++) {
        one.step();
        eight.step();
      }
      expect(eight.getSnapshot().crate.position.y).toBeCloseTo(
        one.getSnapshot().crate.position.y,
        5,
      );
    } finally {
      one.dispose();
      eight.dispose();
    }
  });
  it('keeps head-on controllers separated', async () => {
    const world = await createAuthoritativeWorld(fixture());
    try {
      world.addPlayer('a', { x: -2, y: 0, z: 0 });
      world.addPlayer('b', { x: 2, y: 0, z: 0 });
      world.setInput('a', { moveX: 1, moveZ: 0 });
      world.setInput('b', { moveX: -1, moveZ: 0 });
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
  it('pushes the real dynamic crate and refuses occupied spawn positions', async () => {
    const world = await createAuthoritativeWorld(fixture());
    try {
      expect(world.addPlayer('a', { x: 0, y: 0, z: 3 })).toBeDefined();
      expect(world.addPlayer('b', { x: 0, y: 0, z: 3 })).toBeUndefined();
      world.setInput('a', { moveX: 0, moveZ: 1 });
      for (let i = 0; i < 120; i++) world.step();
      expect(world.getSnapshot().crate.position.z).toBeGreaterThan(7);
      expect(world.respawnPlayer('a')).toBe(true);
      expect(world.getSnapshot().players[0].revision).toBe(1);
    } finally {
      world.dispose();
    }
  });
  it.each([false, true])(
    'returns a lost crate only when its starting position is free (occupied: %s)',
    async (occupied) => {
      const definition = fixture();
      const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
      try {
        const crate = world.objects.get('crate-01')!;
        const start = crate.definition.position;
        world.teleport(crate.body, crate.node, {
          x: definition.bounds.max.x + 2,
          y: 2,
          z: start.z,
        });
        if (occupied) {
          world.createCharacter('occupant', world.spawnPosition({ x: start.x, y: 0, z: start.z }));
          for (let i = 0; i < 30; i++) world.advance(1 / 60);
          expect(world.snapshot().crate.position.x).toBeGreaterThan(definition.bounds.max.x);
          expect(world.snapshot().crate.revision).toBe(0);
          world.removeCharacter('occupant');
        }
        world.advance(1 / 60);
        const returned = world.snapshot().crate;
        expect(returned.position).toEqual(start);
        expect(returned.velocity).toEqual({ x: 0, y: 0, z: 0 });
        expect(returned.revision).toBe(1);
        for (let i = 0; i < 30; i++) world.advance(1 / 60);
        expect(world.snapshot().crate.revision).toBe(1);
        expect(world.physics.getBodies()).toHaveLength(definition.entities.length);
      } finally {
        world.dispose();
      }
    },
  );
  it('restores and replays a controller at a wall without accumulating drift', async () => {
    const definition = fixture();
    const server = await createAuthoritativeWorld(definition);
    const prediction = await createPredictionWorld(definition, await loadServerWasm());
    try {
      server.addPlayer('a');
      const input = { moveX: 1, moveZ: 0 };
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
    } finally {
      server.dispose();
      prediction.dispose();
    }
  });
  it('replays diagonal movement into an inside corner with bounded drift', async () => {
    const definition = fixture();
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
        const input = { moveX: 1, moveZ: batch < 40 ? 1 : -1 };
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
  });
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
        expect(server.getSnapshot().crate.position.z).toBeGreaterThan(6);
      } finally {
        server.dispose();
        prediction.dispose();
      }
    },
  );
});
