import { prepareSdk } from '../helpers/prepare.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { MoveInputSchema, type WorldState } from '../../packages/protocol/src/index.js';
import {
  WORLD_ACTIVITY_MOVE_DURATION_MS,
  TICK_RATE,
  type ActionResult,
  type WorldInfo,
} from '../../packages/contracts/src/index.js';
import type { AuthoritativeWorld } from '../../packages/simulation/src/authoritative-world.js';
import type { PhysicsWorld } from '../../packages/simulation/src/physics-world.js';
import type { ItemRuntime } from '../../apps/server/src/items/runtime.js';
import { createGameServer } from '../helpers/game-server.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 3000) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeout) throw new Error('Timed out waiting for animation');
    await sleep(10);
  }
}
describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('authoritative cosmetic animations', () => {
  let app: Awaited<ReturnType<typeof createGameServer>>, info: WorldInfo;
  const rooms = new Set<Room<WorldState>>();
  const internals = () => app.room as unknown as { world: AuthoritativeWorld; items: ItemRuntime };
  async function join(ready = true) {
    const room = await new Client(app.url).joinById<WorldState>(info.roomId, { ...info });
    rooms.add(room);
    room.reconnection.enabled = false;
    room.onMessage('resync', () => {});
    room.onMessage('problem', () => {});
    const results: ActionResult[] = [];
    room.onMessage('actionResult', (result: ActionResult) => results.push(result));
    if (ready) {
      prepareSdk(room);
      await until(() => room.state?.players?.get(room.sessionId)?.grounded === true);
    } else await until(() => !!room.state?.worldEpoch);
    return { room, results, player: () => app.room.state.players.get(room.sessionId)! };
  }
  function request(room: Room<WorldState>, id: number, animationId = 'wave', extra = {}) {
    room.send('requestAnimation', {
      requestId: id,
      worldEpoch: info.worldEpoch,
      animationId,
      ...extra,
    });
  }
  beforeAll(async () => {
    app = await createGameServer({ port: 0, reconnectSeconds: 1 });
    info = await fetch(app.url + '/api/world').then((r) => r.json());
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...rooms].map((r) => r.leave().catch(() => {})));
    rooms.clear();
    await until(() => app.room.diagnostics().sessions === 0);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('replicates idle loops and movement deadlines, limits selection, and deduplicates after expiry and cache eviction', async () => {
    const { room, results, player } = await join();
    const observer = await join();
    const bodies = app.room.diagnostics().bodies;
    request(room, 1, 'wave', {
      entityId: observer.player().entityId,
      durationMs: 999999,
      startedAtTick: 0,
    });
    await until(
      () =>
        results.length === 1 &&
        observer.room.state.players.get(room.sessionId)?.animationId === 'wave',
    );
    expect(player().animationEndsAtTick).toBe(0);
    expect(observer.player().animationId).toBe('');
    const start = player().animationStartedAtTick;
    request(room, 1, 'dance');
    request(room, 2, 'clap');
    room.send('requestReaction', {
      requestId: 3,
      worldEpoch: info.worldEpoch,
      reactionId: 'hello',
    });
    await until(() => results.length === 4);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toMatchObject({ code: 'RATE_LIMITED', ok: false });
    expect(results[2].retryAfterMs).toBeGreaterThan(0);
    expect(player().reactionId).toBe('hello');
    expect(player().animationSequence).toBe(1);
    const late = await join();
    expect(late.room.state.players.get(room.sessionId)!.animationEndsAtTick).toBe(0);
    const observerToken = observer.room.reconnectionToken;
    observer.room.connection.close(1000);
    await until(() => !observer.player().connected);
    expect(player().animationId).toBe('wave');
    const recoveredObserver = await new Client(app.url).reconnect<WorldState>(observerToken);
    prepareSdk(recoveredObserver);
    recoveredObserver.reconnection.enabled = false;
    recoveredObserver.onMessage('resync', () => {});
    rooms.delete(observer.room);
    rooms.add(recoveredObserver);
    await until(
      () => recoveredObserver.state?.players?.get(room.sessionId)?.animationId === 'wave',
    );
    expect(recoveredObserver.state.players.get(room.sessionId)!.animationEndsAtTick).toBe(0);
    expect(recoveredObserver.state.players.get(room.sessionId)!.animationSequence).toBe(1);
    const input = room.input({ type: MoveInputSchema, mode: 'reliable' });
    input.data.moveX = 1;
    input.send();
    await until(() => player().animationEndsAtTick > 0);
    const end = player().animationEndsAtTick;
    expect(end - player().animationChangedAtTick).toBe(
      (WORLD_ACTIVITY_MOVE_DURATION_MS * TICK_RATE) / 1000,
    );
    expect(player().animationStartedAtTick).toBe(start);
    await until(() => player().animationId === '', WORLD_ACTIVITY_MOVE_DURATION_MS + 1500);
    expect(player().animationChangedAtTick).toBe(end);
    expect(player().animationSequence).toBe(1);
    request(room, 1);
    await until(() => results.length === 5);
    expect(results[4]).toEqual(results[0]);
    for (let id = 4; id <= 37; id++) request(room, id, 'missing');
    await until(() => results.length === 39);
    request(room, 1);
    await until(() => results.length === 40);
    expect(results.at(-1)!.code).toBe('ALREADY_PROCESSED');
    expect(player().animationId).toBe('');
    expect(app.room.diagnostics().bodies).toBe(bodies + 1); // late observer only
  });

  it('keeps chat, reactions and animations independent while sharing the action sequence', async () => {
    const { room, results, player } = await join();
    request(room, 1);
    room.send('requestChat', { requestId: 2, worldEpoch: info.worldEpoch, text: 'Привет!' });
    room.send('requestReaction', {
      requestId: 3,
      worldEpoch: info.worldEpoch,
      reactionId: 'hello',
    });
    await until(() => results.length === 3);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(player().animationId).toBe('wave');
    expect(player().chatText).toBe('Привет!');
    expect(player().reactionId).toBe('hello');
    const original = [...results];
    request(room, 2, 'clap');
    room.send('requestChat', { requestId: 1, worldEpoch: info.worldEpoch, text: 'Дубль' });
    request(room, 4, 'clap');
    await until(() => results.length === 6);
    expect(results[3]).toEqual(original[1]);
    expect(results[4]).toEqual(original[0]);
    expect(results[5]).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(player().animationSequence).toBe(1);
    expect(player().chatSequence).toBe(1);
    expect(player().reactionSequence).toBe(1);
    await sleep(WORLD_ACTIVITY_MOVE_DURATION_MS + 200);
    expect(player().chatText).toBe('Привет!');
    expect(player().reactionId).toBe('hello');
    expect(player().animationId).toBe('wave');
    expect(player().chatExpiresAtTick).toBe(0);
    expect(player().reactionExpiresAtTick).toBe(0);
    expect(player().animationEndsAtTick).toBe(0);
    request(room, 5, 'dance');
    room.send('requestReaction', { requestId: 6, worldEpoch: info.worldEpoch, reactionId: 'love' });
    await until(
      () =>
        results.length === 8 && player().animationId === 'dance' && player().reactionId === 'love',
    );
    expect(results.slice(-2).every((r) => r.ok)).toBe(true);
    expect(player().animationEndsAtTick).toBe(0);
    expect(player().reactionExpiresAtTick).toBe(0);
    const input = room.input({ type: MoveInputSchema, mode: 'reliable' });
    input.data.moveX = 1;
    input.send();
    await until(() => player().animationEndsAtTick > 0);
    const end = player().animationEndsAtTick;
    expect(player().reactionExpiresAtTick).toBe(end);
    expect(player().chatExpiresAtTick).toBe(end);
    input.data.moveX = 0;
    input.send();
    await sleep(150);
    input.data.moveX = 1;
    input.send();
    await sleep(150);
    expect(player().animationId).toBe('dance');
    expect(player().animationEndsAtTick).toBe(end);
    expect(player().reactionExpiresAtTick).toBe(end);
    expect(player().chatExpiresAtTick).toBe(end);
    const late = await join();
    await until(() => late.room.state.players.get(room.sessionId)?.animationEndsAtTick === end);
    expect(late.room.state.players.get(room.sessionId)!.reactionExpiresAtTick).toBe(end);
    await until(
      () => !player().animationId && !player().reactionId && !player().chatText,
      WORLD_ACTIVITY_MOVE_DURATION_MS + 1500,
    );
  });

  it('validates unknown input, epoch, readiness, support and rig', async () => {
    const { room, results, player } = await join(false);
    const problems: string[] = [];
    room.onMessage('problem', ({ code }: { code: string }) => problems.push(code));
    for (const input of [null, {}, { requestId: 0 }, { requestId: '1' }, { requestId: 1.2 }])
      room.send('requestAnimation', input);
    request(room, 1);
    await until(() => results.length === 1 && problems.length === 5);
    expect(results[0].code).toBe('WORLD_NOT_READY');
    prepareSdk(room);
    await until(() => player()?.grounded === true);
    request(room, 2, 'wave', { worldEpoch: 'stale' });
    request(room, 3, '__proto__');
    request(room, 4, 'wave', { animationId: { id: 'wave' } });
    await until(() => results.length === 4);
    expect(results.slice(1).map((r) => r.code)).toEqual([
      'STALE_WORLD',
      'INVALID_INPUT',
      'INVALID_INPUT',
    ]);
    player().skinId = 'incompatible';
    request(room, 5);
    await until(() => results.length === 5);
    expect(results.at(-1)!.code).toBe('ANIMATION_NOT_ALLOWED');
    player().skinId = 'minifigure';
    const world = internals().world;
    const physics = (world as unknown as { world: PhysicsWorld }).world;
    const actual = world.getSnapshot().players.find((p) => p.entityId === player().entityId)!;
    physics.restoreCharacter({
      ...actual,
      position: { ...actual.position, y: 5 },
      grounded: false,
    });
    request(room, 6);
    await until(() => results.length === 6);
    expect(results.at(-1)!.code).toBe('ANIMATION_NOT_ALLOWED');
  });

  it('rejects starting dance at a wall, keeps it for five seconds after movement, and permits sprint alone', async () => {
    const { room, results, player } = await join();
    const input = room.input({ type: MoveInputSchema, mode: 'reliable' });
    request(room, 1, 'dance');
    await until(() => player().animationId === 'dance');
    input.data.sprint = true;
    input.send();
    await sleep(100);
    expect(player().animationId).toBe('dance');
    input.data.moveX = 1;
    input.send();
    await until(() => player().animationEndsAtTick > 0);
    expect(player().animationId).toBe('dance');
    expect(player().animationSequence).toBe(1);
    await until(() => player().animationId === '', WORLD_ACTIVITY_MOVE_DURATION_MS + 1500);
    const physics = (internals().world as unknown as { world: PhysicsWorld }).world;
    const actual = internals()
      .world.getSnapshot()
      .players.find((p) => p.entityId === player().entityId)!;
    physics.restoreCharacter({
      ...actual,
      position: { x: 19.4, y: 0.915, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: true,
    });
    // Keep issuing the rejected request just after a physical step has consumed movement.
    const world = internals().world;
    const setInput = world.setInput.bind(world);
    const reject = vi.spyOn(world, 'setInput').mockImplementation((id, command) => {
      setInput(id, command);
      if (command.moveX) request(room, 2, 'dance');
    });
    input.send();
    await until(() => results.some((r) => r.requestId === 2));
    reject.mockRestore();
    expect(results.find((r) => r.requestId === 2)!.code).toBe('ANIMATION_NOT_ALLOWED');
    expect(Math.hypot(player().vx, player().vz)).toBeLessThan(0.08);
    input.data.moveX = 0;
    input.send();
    physics.restoreCharacter({ ...actual, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
    await until(() => player().grounded && Math.hypot(player().vx, player().vz) <= 0.08);
    request(room, 3, 'wave');
    await until(() => player().animationId === 'wave');
    input.data.moveX = -1;
    input.send();
    await sleep(100);
    expect(player().animationId).toBe('wave');
  });

  it('cancels on support loss, successful respawn, short reservations and disconnect; rejected respawn keeps the show', async () => {
    const { room, results, player } = await join();
    request(room, 1);
    await until(() => player().animationId === 'wave');
    const world = internals().world;
    const physics = (world as unknown as { world: PhysicsWorld }).world;
    const actual = world.getSnapshot().players.find((p) => p.entityId === player().entityId)!;
    physics.restoreCharacter({
      ...actual,
      position: { ...actual.position, y: 5 },
      grounded: false,
    });
    await until(() => player().animationId === '');
    await until(() => player().grounded);
    request(room, 2, 'clap');
    await until(() => player().animationId === 'clap');
    const failed = vi.spyOn(world, 'respawnPlayerAtPosition').mockReturnValueOnce(false);
    room.send('requestRespawn', { requestId: 3, worldEpoch: info.worldEpoch });
    await until(() => results.length === 3);
    expect(player().animationId).toBe('clap');
    failed.mockRestore();
    room.send('requestRespawn', { requestId: 4, worldEpoch: info.worldEpoch });
    await until(() => results.length === 4 && player().animationId === '');
    await until(() => player().revision > actual.revision && player().grounded);
    request(room, 5);
    await until(() => player().animationId === 'wave');
    const runtime = internals().items;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.spyOn(runtime.store, 'operation').mockImplementation(async () => {
      await gate;
      return { operationId: 'test', ok: false, code: 'ITEM_UNAVAILABLE' };
    });
    const pending = runtime.command(
      'unused',
      player().entityId,
      {
        operationId: 'test',
        worldEpoch: info.worldEpoch,
        action: { kind: 'pickup', itemId: 'missing' },
      },
      () => undefined,
    );
    expect(app.room.state.paused).toBe(true);
    expect(player().animationId).toBe('');
    const sequence = player().animationSequence;
    request(room, 6);
    await until(() => results.some((r) => r.requestId === 6));
    expect(results.find((r) => r.requestId === 6)!.code).toBe('WORLD_NOT_READY');
    release();
    await pending;
    operation.mockRestore();
    await until(() => !app.room.state.paused);
    expect(player().animationSequence).toBe(sequence);
    request(room, 7);
    await until(() => player().animationId === 'wave');
    const token = room.reconnectionToken;
    room.connection.close(1000);
    await until(() => !player().connected);
    expect(player().animationId).toBe('');
    const restored = await new Client(app.url).reconnect<WorldState>(token);
    prepareSdk(restored);
    restored.reconnection.enabled = false;
    restored.onMessage('resync', () => {});
    rooms.delete(room);
    rooms.add(restored);
    await until(() => restored.state?.players?.get(restored.sessionId)?.connected === true);
    expect(restored.state.players.get(restored.sessionId)!.animationId).toBe('');
  });
});
