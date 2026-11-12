import { createAuthoritativeWorld } from '../packages/simulation/src/authoritative-world.js';
import { createPredictionWorld } from '../packages/simulation/src/prediction.js';
import { buildingFixture, physicsFixture } from '../packages/simulation/src/test-fixture.js';
import { NEUTRAL_INPUT } from '../packages/contracts/src/index.js';

/** The exact same scenario runs in Node and in Chromium through Vite. */
export async function runPhysicsScenarios(wasmBinary: ArrayBuffer | Uint8Array) {
  const movement = [];
  const movementWorld = await createAuthoritativeWorld(physicsFixture(), wasmBinary);
  try {
    movementWorld.addPlayer('local');
    for (const sprint of [false, true, false]) {
      const start = movementWorld.getSnapshot().players[0].position;
      movementWorld.setInput('local', { moveX: -1, moveZ: -1, sprint });
      for (let step = 0; step < 30; step++) movementWorld.step();
      const { position, velocity } = movementWorld.getSnapshot().players[0];
      movement.push({
        sprint,
        distance: Math.hypot(position.x - start.x, position.z - start.z),
        speed: Math.hypot(velocity.x, velocity.z),
      });
    }
    movementWorld.setInput('local', NEUTRAL_INPUT);
    movementWorld.step();
    const { velocity } = movementWorld.getSnapshot().players[0];
    movement.push({ sprint: false, distance: 0, speed: Math.hypot(velocity.x, velocity.z) });
  } finally {
    movementWorld.dispose();
  }
  const cadence = [];
  for (const fps of [30, 60, 120]) {
    const definition = physicsFixture();
    definition.initialItems.find((item) => item.seedId === 'crate-01')!.position.y = 3;
    const world = await createAuthoritativeWorld(definition, wasmBinary);
    try {
      world.addPlayer('local');
      world.setInput('local', { moveX: 1, moveZ: 0 });
      let accumulator = 0;
      const samples = [];
      let steps = 0;
      for (let frame = 0; frame < fps * 3; frame++) {
        accumulator += 1 / fps;
        while (accumulator + 1e-10 >= 1 / 60) {
          world.step();
          accumulator -= 1 / 60;
          steps++;
          if (steps % 30 === 0) samples.push(world.getSnapshot());
        }
      }
      cadence.push({ fps, steps, samples });
    } finally {
      world.dispose();
    }
  }
  const definition = physicsFixture();
  const wall = definition.entities.find((entity) => entity.entityId === 'wall')!;
  wall.size.z = 40;
  definition.entities.push({
    ...wall,
    entityId: 'corner',
    position: { x: 0, y: 1.5, z: 3 },
    size: { x: 10, y: 3, z: 1 },
  });
  const server = await createAuthoritativeWorld(definition, wasmBinary);
  const prediction = await createPredictionWorld(definition, wasmBinary);
  let maximumReplayDrift = 0;
  try {
    server.addPlayer('local');
    for (let batch = 0; batch < 60; batch++) {
      const snapshot = server.getSnapshot();
      prediction.reconcile(snapshot.players[0], snapshot);
      const input = { moveX: 1, moveZ: batch < 40 ? 1 : -1, sprint: true };
      server.setInput('local', input);
      for (let step = 0; step < 6; step++) {
        prediction.step(input);
        server.step();
      }
      const a = server.getSnapshot().players[0].position;
      const b = prediction.getState().position;
      maximumReplayDrift = Math.max(
        maximumReplayDrift,
        Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
      );
    }
  } finally {
    server.dispose();
    prediction.dispose();
  }
  const buildings = [];
  for (const kind of ['courtyard', 'arch'] as const) {
    const definition = buildingFixture(kind);
    const server = await createAuthoritativeWorld(definition, wasmBinary);
    const prediction = await createPredictionWorld(definition, wasmBinary);
    try {
      const passSpawn = kind === 'arch' ? { x: 0, y: 0, z: -3 } : { x: 0, y: 0, z: 0 };
      const blockedSpawn = kind === 'arch' ? { x: 7, y: 0, z: 2 } : { x: 4, y: 0, z: 0 };
      const occupiedSpawn = kind === 'arch' ? { x: 10, y: 0, z: 2 } : { x: 10, y: 0, z: 3 };
      if (!server.addPlayer('local', blockedSpawn) || !server.addPlayer('pass', passSpawn))
        throw new Error(`${kind}: a clear spawn was rejected`);
      if (server.addPlayer('occupied', occupiedSpawn))
        throw new Error(`${kind}: spawn inside a rotated solid was accepted`);
      const input = { moveX: 1, moveZ: 0, sprint: true };
      server.setInput('local', input);
      server.setInput('pass', { moveX: 0, moveZ: 1 });
      let maximumReplayDrift = 0;
      const samples = [];
      for (let batch = 0; batch < 30; batch++) {
        const snapshot = server.getSnapshot();
        prediction.reconcile(
          snapshot.players.find((player) => player.entityId === 'local')!,
          snapshot,
        );
        for (let step = 0; step < 6; step++) {
          prediction.step(input);
          server.step();
        }
        const next = server.getSnapshot();
        const a = next.players.find((player) => player.entityId === 'local')!.position;
        const b = prediction.getState().position;
        maximumReplayDrift = Math.max(
          maximumReplayDrift,
          Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
        );
        if ((batch + 1) % 5 === 0) samples.push(next);
      }
      buildings.push({ kind, maximumReplayDrift, samples });
    } finally {
      server.dispose();
      prediction.dispose();
    }
  }
  return { movement, cadence, maximumReplayDrift, buildings };
}
