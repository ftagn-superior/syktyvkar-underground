import { prepareSdk } from '../helpers/prepare.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, CloseCode, type Room } from '@colyseus/sdk';
import { createGameServer } from '../helpers/game-server.js';
import { MoveInputSchema, type WorldState } from '../../packages/protocol/src/index.js';
import {
  RESPAWN_COOLDOWN_MS,
  REACTION_COOLDOWN_MS,
  CHAT_MAX_LENGTH,
  WORLD_ACTIVITY_MOVE_DURATION_MS,
  CHAT_MIN_COOLDOWN_MS,
  CHAT_MAX_COOLDOWN_MS,
  TICK_RATE,
  type ActionResult,
  type WorldInfo,
} from '../../packages/contracts/src/index.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 2500): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeout) throw new Error('Timed out waiting for state');
    await sleep(15);
  }
}

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('authoritative WebSocket world', () => {
  let app: Awaited<ReturnType<typeof createGameServer>>;
  let info: WorldInfo;
  let sdk: Client;
  const rooms = new Set<Room<WorldState>>();
  async function join(ready = true, skinId?: string): Promise<Room<WorldState>> {
    const room = await sdk.joinById<WorldState>(info.roomId, {
      protocolVersion: info.protocolVersion,
      mapVersion: info.mapVersion,
      simulationConfigHash: info.simulationConfigHash,
      skinId,
    });
    room.reconnection.enabled = false;
    room.onMessage('problem', () => {});
    room.onMessage('resync', () => {});
    room.onMessage('actionResult', () => {});
    rooms.add(room);
    if (ready) {
      prepareSdk(room);
      await until(() => !!room.state?.players?.has(room.sessionId));
    } else await until(() => !!room.state?.worldEpoch);
    return room;
  }
  beforeAll(async () => {
    app = await createGameServer({ port: 0, prepareTimeoutMs: 800, reconnectSeconds: 0.8 });
    info = (await (await fetch(app.url + '/api/world')).json()) as WorldInfo;
    sdk = new Client(app.url);
  });
  afterEach(async () => {
    await Promise.all([...rooms].map((room) => room.leave().catch(() => undefined)));
    rooms.clear();
    await until(() => app.room.diagnostics().sessions === 0, 2000);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('replicates facing while idle and backward, without starting chat expiry on a turn', async () => {
    const first = await join();
    const second = await join();
    const input = first.input({ type: MoveInputSchema, mode: 'reliable' });
    first.send('requestChat', { requestId: 1, worldEpoch: info.worldEpoch, text: 'Лицом к лицу' });
    await until(() => !!first.state.players.get(first.sessionId)?.chatText);
    const send = (yaw: number, moveZ = 0) => {
      input.data.hasFacing = true;
      input.data.facingYaw = yaw;
      input.data.moveZ = moveZ;
      input.send();
    };
    send(Math.PI / 2);
    await until(
      () => Math.abs((second.state.players.get(first.sessionId)?.qy ?? 0) - Math.SQRT1_2) < 0.001,
    );
    expect(second.state.players.get(first.sessionId)?.chatExpiresAtTick).toBe(0);
    const repeat = setInterval(() => send(0, -1), 16);
    try {
      await until(() => Math.abs(second.state.players.get(first.sessionId)?.vz ?? 0) > 1);
    } finally {
      clearInterval(repeat);
    }
    expect(second.state.players.get(first.sessionId)?.qy).toBeCloseTo(0);
    expect(second.state.players.get(first.sessionId)?.qw).toBeCloseTo(1);
    input.data.moveZ = 0;
    input.data.hasFacing = false;
    input.send();
    await until(() => Math.abs(second.state.players.get(first.sessionId)?.vz ?? 100) < 0.01);
    expect(second.state.players.get(first.sessionId)?.qy).toBeCloseTo(0);
  });

  it('shares one epoch and crate, spawns only once after ready', async () => {
    const first = await join(false);
    expect(app.room.state.players.size).toBe(0);
    const input = first.input({ type: MoveInputSchema, mode: 'reliable' });
    input.data.moveX = 1;
    input.send();
    await sleep(80);
    expect(app.room.state.players.size).toBe(0);
    const preparation = prepareSdk(first);
    await until(() => preparation.plans.length > 0);
    preparation.ready();
    await until(() => first.state.players?.has(first.sessionId));
    const second = await join();
    await until(() => first.state.players.size === 2 && second.state.players.size === 2);
    expect(first.state.worldEpoch).toBe(second.state.worldEpoch);
    expect(first.state.items.size).toBe(1);
    expect(first.state.items.values().next().value!.entityId).toBe(
      second.state.items.values().next().value!.entityId,
    );
    expect(app.room.diagnostics().players).toBe(2);
    expect((await fetch(app.url + '/health/ready')).status).toBe(200);
  });

  it('rejects incompatible versions and room creation', async () => {
    await expect(
      sdk.joinById(info.roomId, {
        protocolVersion: info.protocolVersion - 1,
        mapVersion: info.mapVersion,
        simulationConfigHash: info.simulationConfigHash,
      }),
    ).rejects.toThrow('VERSION_MISMATCH');
    await expect(sdk.create('world')).rejects.toThrow();
    expect(app.room.diagnostics().players).toBe(0);
    expect((await (await fetch(app.url + '/api/world')).json()).roomId).toBe(info.roomId);
  });

  it('replicates the selected guest skin to everyone and rejects unknown IDs', async () => {
    const first = await join();
    const second = await join(true, 'standard');
    await until(() => first.state.players?.has(second.sessionId));
    expect(first.state.players.get(first.sessionId)!.skinId).toBe('minifigure');
    expect(first.state.players.get(second.sessionId)!.skinId).toBe('standard');
    expect(second.state.players.get(second.sessionId)!.skinId).toBe('standard');
    await expect(join(true, 'missing')).rejects.toThrow('INVALID_SKIN');
  });

  it('counts preparing seats toward eight and frees them on timeout', async () => {
    const waiting = await Promise.all(Array.from({ length: 8 }, () => join(false)));
    expect(app.room.diagnostics().sessions).toBe(8);
    await expect(join(false)).rejects.toThrow();
    await until(() => app.room.diagnostics().sessions === 0, 2500);
    expect(app.room.diagnostics().players).toBe(0);
    for (const room of waiting) rooms.delete(room);
    const next = await join();
    expect(next.roomId).toBe(info.roomId);
  });

  it('bounds movement and diagonal speed, and neutralizes missing input', async () => {
    const room = await join();
    const input = room.input({ type: MoveInputSchema, mode: 'reliable' });
    const player = room.state.players.get(room.sessionId)!;
    const initial = { x: player.x, z: player.z };
    for (let i = 0; i < 30; i++) {
      input.data.moveX = 1;
      input.data.moveZ = 1;
      input.send();
      await sleep(1000 / 60);
    }
    await sleep(200);
    const moved = Math.hypot(player.x - initial.x, player.z - initial.z);
    expect(moved).toBeGreaterThan(1.4);
    expect(moved).toBeLessThan(2.2);
    const stopped = { x: player.x, z: player.z };
    await sleep(300);
    expect(Math.hypot(player.x - stopped.x, player.z - stopped.z)).toBeLessThan(0.03);
  });

  it('replicates sprint changes without changing axes and stops stale sprint input', async () => {
    const room = await join();
    const input = room.input({ type: MoveInputSchema, mode: 'reliable' });
    const player = room.state.players.get(room.sessionId)!;
    const initialX = player.x;
    // From the first spawn this short westward path is clear at both speeds.
    input.data.moveX = -1;
    for (const sprint of [false, true, false, true]) {
      input.data.sprint = sprint;
      let observedSpeed = false;
      for (let i = 0; i < 12; i++) {
        input.send();
        await sleep(1000 / 60);
        if (Math.abs(Math.hypot(player.vx, player.vz) - (sprint ? 14 : 4)) < 0.01)
          observedSpeed = true;
      }
      // Sample the phase: timer jitter may publish a neutral tick after its last packet.
      expect(observedSpeed).toBe(true);
    }
    expect(player.x).toBeLessThan(initialX - 3);
    await until(() => Math.hypot(player.vx, player.vz) < 0.01);
    const stopped = { x: player.x, z: player.z };
    await sleep(150);
    expect(Math.hypot(player.x - stopped.x, player.z - stopped.z)).toBeLessThan(0.03);
  });

  it('makes respawn requests idempotent, rate limited, and epoch scoped', async () => {
    const room = await join();
    const results: ActionResult[] = [];
    room.onMessage('actionResult', (result: ActionResult) => results.push(result));
    room.send('requestRespawn', { requestId: 1, worldEpoch: info.worldEpoch });
    await until(() => results.length === 1);
    expect(results[0].ok).toBe(true);
    expect(results[0].retryAfterMs).toBeGreaterThan(0);
    expect(results[0].retryAfterMs).toBeLessThanOrEqual(RESPAWN_COOLDOWN_MS);
    await until(() => room.state.players.get(room.sessionId)!.revision === 1);
    room.send('requestRespawn', { requestId: 1, worldEpoch: info.worldEpoch });
    room.send('requestRespawn', { requestId: 2, worldEpoch: info.worldEpoch });
    room.send('requestRespawn', { requestId: 3, worldEpoch: 'stale' });
    await until(() => results.length === 4);
    expect(results[1]).toEqual(results[0]);
    expect(results[2].code).toBe('RATE_LIMITED');
    expect(results[2].retryAfterMs).toBeGreaterThan(0);
    expect(results[2].retryAfterMs).toBeLessThan(results[0].retryAfterMs!);
    expect(results[3].code).toBe('STALE_WORLD');
    expect(results[3].retryAfterMs).toBeUndefined();
    expect(room.state.players.get(room.sessionId)!.revision).toBe(1);
    await sleep(results[2].retryAfterMs! + 25);
    room.send('requestRespawn', { requestId: 4, worldEpoch: info.worldEpoch });
    await until(() => results.length === 5);
    expect(results[4].ok).toBe(true);
    await until(() => room.state.players.get(room.sessionId)!.revision === 2);
  });

  it('restores the same entity from a stored token, then releases expired seats', async () => {
    const room = await join();
    const entityId = room.state.players.get(room.sessionId)!.entityId;
    const token = room.reconnectionToken;
    room.connection.close(1000);
    await until(() => app.room.diagnostics().reserved === 1);
    const recovered = await sdk.reconnect<WorldState>(token);
    prepareSdk(recovered);
    recovered.reconnection.enabled = false;
    recovered.onMessage('resync', () => {});
    rooms.delete(room);
    rooms.add(recovered);
    await until(() => recovered.state?.players?.get(recovered.sessionId)?.connected === true);
    expect(recovered.state.players.get(recovered.sessionId)!.entityId).toBe(entityId);
    expect(app.room.diagnostics().players).toBe(1);
    recovered.connection.close(1000);
    await until(() => app.room.diagnostics().sessions === 0, 2500);
    rooms.delete(recovered);
    await expect(sdk.reconnect(token)).rejects.toThrow();
    const fresh = await join();
    expect(fresh.state.players.get(fresh.sessionId)!.entityId).not.toBe(entityId);
  });

  it('shares one reaction until movement, deduplicates requests, and keeps respawn independent', async () => {
    const sender = await join();
    const observer = await join();
    const results: ActionResult[] = [];
    sender.onMessage('actionResult', (result: ActionResult) => results.push(result));
    const request = (requestId: number, reactionId = 'hello', worldEpoch = info.worldEpoch) =>
      sender.send('requestReaction', {
        requestId,
        worldEpoch,
        reactionId,
        entityId: observer.sessionId,
        durationMs: 999_999,
      });
    request(1);
    await until(
      () =>
        results.length === 1 &&
        observer.state.players.get(sender.sessionId)?.reactionId === 'hello',
    );
    const player = observer.state.players.get(sender.sessionId)!;
    const expires = player.reactionExpiresAtTick;
    expect(results[0]).toMatchObject({ ok: true, retryAfterMs: REACTION_COOLDOWN_MS });
    expect(player.reactionSequence).toBe(1);
    expect(expires).toBe(0);
    expect(observer.state.players.get(observer.sessionId)!.reactionId).toBe('');
    request(1, 'love');
    request(2, 'love');
    sender.send('requestRespawn', { requestId: 3, worldEpoch: info.worldEpoch });
    await until(() => results.length === 4);
    request(4, 'love', 'old-world');
    request(5, '__proto__');
    await until(() => results.length === 6);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(results[2].retryAfterMs).toBeGreaterThan(0);
    expect(results[3].ok).toBe(true);
    expect(results[4].code).toBe('STALE_WORLD');
    expect(results[5].code).toBe('INVALID_INPUT');
    expect(player.reactionSequence).toBe(1);
    expect(player.reactionExpiresAtTick).toBe(expires);
    const input = sender.input({ type: MoveInputSchema, mode: 'reliable' });
    input.data.moveX = 1;
    input.send();
    await until(() => player.reactionExpiresAtTick > 0);
    expect(player.reactionExpiresAtTick - observer.state.serverTick).toBeLessThanOrEqual(
      (WORLD_ACTIVITY_MOVE_DURATION_MS * TICK_RATE) / 1000,
    );
    await until(
      () =>
        player.reactionId === '' && sender.state.players.get(sender.sessionId)!.reactionId === '',
      WORLD_ACTIVITY_MOVE_DURATION_MS + 1500,
    );
    expect(player.reactionExpiresAtTick).toBe(0);
    // Retrying an old successful request after expiry must never replay the sticker.
    request(1);
    await until(() => results.length === 7);
    expect(results[6]).toEqual(results[0]);
    expect(app.room.state.players.get(sender.sessionId)!.reactionId).toBe('');
    request(6);
    await until(() => player.reactionId === 'hello' && player.reactionSequence === 2);
  });

  it('rejects malformed reactions and reactions before the character is ready', async () => {
    const room = await join(false);
    const results: ActionResult[] = [];
    const problems: string[] = [];
    room.onMessage('actionResult', (result: ActionResult) => results.push(result));
    room.onMessage('problem', ({ code }: { code: string }) => problems.push(code));
    for (const request of [null, {}, { requestId: -1 }, { requestId: 1.5 }, { requestId: '1' }])
      room.send('requestReaction', request);
    room.send('requestReaction', {
      requestId: 1,
      worldEpoch: info.worldEpoch,
      reactionId: 'hello',
    });
    await until(() => problems.length === 5 && results.length === 1);
    expect(problems.every((code) => code === 'INVALID_INPUT')).toBe(true);
    expect(results[0].code).toBe('WORLD_NOT_READY');
    prepareSdk(room);
    await until(() => room.state.players?.has(room.sessionId));
    room.send('requestReaction', {
      requestId: 2,
      worldEpoch: info.worldEpoch,
      reactionId: { id: 'hello' },
    });
    room.send('requestReaction', {
      requestId: 3,
      worldEpoch: info.worldEpoch,
      reactionId: 'missing',
    });
    await until(() => results.length === 3);
    expect(results.slice(1).every((result) => result.code === 'INVALID_INPUT')).toBe(true);
    expect(app.room.state.players.get(room.sessionId)!.reactionSequence).toBe(0);
  });

  it('gives late joiners and reconnected clients only the remaining reaction lifetime', async () => {
    const sender = await join();
    sender.send('requestReaction', {
      requestId: 1,
      worldEpoch: info.worldEpoch,
      reactionId: 'love',
    });
    await until(() => sender.state.players.get(sender.sessionId)?.reactionId === 'love');
    expect(sender.state.players.get(sender.sessionId)!.reactionExpiresAtTick).toBe(0);
    const input = sender.input({ type: MoveInputSchema, mode: 'reliable' });
    input.data.moveX = 1;
    input.send();
    await until(() => sender.state.players.get(sender.sessionId)!.reactionExpiresAtTick > 0);
    const expires = sender.state.players.get(sender.sessionId)!.reactionExpiresAtTick;
    await sleep(300);
    const late = await join();
    expect(late.state.players.get(sender.sessionId)!.reactionExpiresAtTick).toBe(expires);
    const token = late.reconnectionToken;
    late.connection.close(1000);
    await until(() => app.room.diagnostics().reserved === 1);
    const recovered = await sdk.reconnect<WorldState>(token);
    prepareSdk(recovered);
    recovered.reconnection.enabled = false;
    recovered.onMessage('resync', () => {});
    rooms.delete(late);
    rooms.add(recovered);
    await until(() => recovered.state?.players?.get(sender.sessionId)?.reactionId === 'love');
    expect(recovered.state.players.get(sender.sessionId)!.reactionExpiresAtTick).toBe(expires);
    expect(recovered.state.players.get(sender.sessionId)!.reactionSequence).toBe(1);
    await until(
      () => recovered.state.players.get(sender.sessionId)!.reactionId === '',
      WORLD_ACTIVITY_MOVE_DURATION_MS + 1500,
    );
    const after = await join();
    expect(after.state.players.get(sender.sessionId)!.reactionId).toBe('');
  });

  it('keeps stationary chat until movement, shares one five-second deadline, and protects sending and authorship', async () => {
    const sender = await join();
    const observer = await join();
    const results: ActionResult[] = [];
    sender.onMessage('actionResult', (result: ActionResult) => results.push(result));
    const send = (requestId: number, text: unknown, worldEpoch = info.worldEpoch) =>
      sender.send('requestChat', {
        requestId,
        worldEpoch,
        text,
        entityId: observer.sessionId,
        durationMs: 999_999,
      });
    send(1, '  Привет,\n <b>сосед</b>! 🙂  ');
    await until(() => observer.state.players.get(sender.sessionId)?.chatSequence === 1);
    const player = observer.state.players.get(sender.sessionId)!;
    const expires = player.chatExpiresAtTick;
    expect(player.chatText).toBe('Привет, <b>сосед</b>! 🙂');
    expect(observer.state.players.get(observer.sessionId)!.chatText).toBe('');
    expect(results[0]).toMatchObject({ ok: true, retryAfterMs: CHAT_MIN_COOLDOWN_MS });
    expect(expires).toBe(0);
    send(1, 'Повтор');
    send(2, 'Следующее');
    sender.send('requestReaction', {
      requestId: 3,
      worldEpoch: info.worldEpoch,
      reactionId: 'hello',
    });
    send(4, 'Старый мир', 'old-world');
    for (const [index, text] of [null, {}, '', ' \n\t ', 'я'.repeat(CHAT_MAX_LENGTH + 1)].entries())
      send(5 + index, text);
    await until(() => results.length === 10);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(results[2].retryAfterMs).toBeGreaterThan(0);
    expect(results[3].ok).toBe(true);
    expect(results[4].code).toBe('STALE_WORLD');
    expect(results.slice(5).every((result) => result.code === 'INVALID_INPUT')).toBe(true);
    expect(player.chatExpiresAtTick).toBe(expires);
    expect(player.chatSequence).toBe(1);
    expect(JSON.stringify(results)).not.toContain('сосед');

    const late = await join();
    expect(late.state.players.get(sender.sessionId)!.chatExpiresAtTick).toBe(expires);
    expect(late.state.players.get(sender.sessionId)!.chatText).toBe(player.chatText);
    await sleep(CHAT_MIN_COOLDOWN_MS + 200);
    expect(player.chatText).toBe('Привет, <b>сосед</b>! 🙂');
    expect(player.chatExpiresAtTick).toBe(0);
    send(10, 'Новое сообщение без движения');
    await until(() => player.chatSequence === 2 && results.length === 11);
    expect(player.chatText).toBe('Новое сообщение без движения');
    expect(player.chatExpiresAtTick).toBe(0);

    const input = sender.input({ type: MoveInputSchema, mode: 'reliable' });
    input.data.moveX = 1;
    input.send();
    await until(() => player.chatExpiresAtTick > 0);
    const movementExpires = player.chatExpiresAtTick;
    expect(movementExpires - observer.state.serverTick).toBeGreaterThan(
      (WORLD_ACTIVITY_MOVE_DURATION_MS * TICK_RATE) / 1000 - 15,
    );
    expect(movementExpires - observer.state.serverTick).toBeLessThanOrEqual(
      (WORLD_ACTIVITY_MOVE_DURATION_MS * TICK_RATE) / 1000,
    );
    input.data.moveX = 0;
    input.send();
    await sleep(150);
    expect(player.chatExpiresAtTick).toBe(movementExpires);
    input.data.moveX = 1;
    input.send();
    await sleep(150);
    expect(player.chatExpiresAtTick).toBe(movementExpires);
    const movingLate = await join();
    expect(movingLate.state.players.get(sender.sessionId)!.chatExpiresAtTick).toBe(movementExpires);
    await until(
      () => player.chatText === '' && sender.state.players.get(sender.sessionId)!.chatText === '',
      WORLD_ACTIVITY_MOVE_DURATION_MS + 1500,
    );
    expect(player.chatExpiresAtTick).toBe(0);
    send(1, 'Повтор после окончания');
    await until(() => results.length === 12);
    expect(app.room.state.players.get(sender.sessionId)!.chatText).toBe('');
    // A message sent during movement starts the same five-second countdown.
    input.send();
    send(11, 'я'.repeat(CHAT_MAX_LENGTH));
    await until(() => player.chatSequence === 3 && player.chatExpiresAtTick > 0);
    expect(player.chatText).toHaveLength(CHAT_MAX_LENGTH);
    expect(results.at(-1)).toMatchObject({ ok: true, retryAfterMs: CHAT_MAX_COOLDOWN_MS });
    expect(player.chatExpiresAtTick - observer.state.serverTick).toBeLessThanOrEqual(
      (WORLD_ACTIVITY_MOVE_DURATION_MS * TICK_RATE) / 1000,
    );
  });

  it('rejects malformed chat requests and chat before the character is ready', async () => {
    const room = await join(false);
    const results: ActionResult[] = [];
    const problems: string[] = [];
    room.onMessage('actionResult', (result: ActionResult) => results.push(result));
    room.onMessage('problem', ({ code }: { code: string }) => problems.push(code));
    for (const request of [null, {}, { requestId: -1 }, { requestId: 1.5 }, { requestId: '1' }])
      room.send('requestChat', request);
    room.send('requestChat', { requestId: 1, worldEpoch: info.worldEpoch, text: 'Рано' });
    await until(() => problems.length === 5 && results.length === 1);
    expect(problems.every((code) => code === 'INVALID_INPUT')).toBe(true);
    expect(results[0].code).toBe('WORLD_NOT_READY');
    prepareSdk(room);
    await until(() => room.state.players?.has(room.sessionId));
    room.send('requestChat', { requestId: 2, worldEpoch: info.worldEpoch });
    await until(() => results.length === 2);
    expect(results[1].code).toBe('INVALID_INPUT');
    expect(app.room.state.players.get(room.sessionId)!.chatSequence).toBe(0);
  });

  it('automatically restores a connection closed with the SDK offline code', async () => {
    const room = await join();
    const entityId = room.state.players.get(room.sessionId)!.entityId;
    room.reconnection.enabled = true;
    room.reconnection.minUptime = 0;
    room.reconnection.delay = 20;
    room.reconnection.minDelay = 20;
    room.reconnection.maxDelay = 50;
    let reconnected = false;
    room.onReconnect(() => {
      reconnected = true;
    });
    room.connection.close(CloseCode.MAY_TRY_RECONNECT);
    await until(() => reconnected, 2000);
    await until(() => room.state.players.get(room.sessionId)?.connected === true);
    expect(room.state.players.get(room.sessionId)!.entityId).toBe(entityId);
    expect(app.room.diagnostics().players).toBe(1);
    expect(app.room.diagnostics().sessions).toBe(1);
    expect(app.room.diagnostics().reserved).toBe(0);
    const input = room.input({ type: MoveInputSchema, mode: 'reliable' });
    const initialX = room.state.players.get(room.sessionId)!.x;
    for (let i = 0; i < 10; i++) {
      input.data.moveX = 1;
      input.send();
      await sleep(17);
    }
    await sleep(80);
    expect(room.state.players.get(room.sessionId)!.x).toBeGreaterThan(initialX + 0.5);
  });

  it('keeps queues bounded and healthy clients moving after invalid and excessive input', async () => {
    const bad = await join();
    const healthy = await join();
    const badInput = bad.input({ type: MoveInputSchema, mode: 'reliable' });
    badInput.data.moveX = NaN;
    badInput.data.moveZ = Infinity;
    badInput.send();
    await sleep(100);
    expect(Number.isFinite(app.room.state.players.get(bad.sessionId)!.x)).toBe(true);
    for (let i = 0; i < 220; i++) {
      badInput.data.moveX = 1;
      badInput.send();
    }
    await sleep(150);
    expect(app.room.diagnostics().maxQueue).toBeLessThanOrEqual(32);
    const goodInput = healthy.input({ type: MoveInputSchema, mode: 'reliable' });
    const initial = healthy.state.players.get(healthy.sessionId)!.x;
    for (let i = 0; i < 20; i++) {
      goodInput.data.moveX = 1;
      goodInput.send();
      await sleep(17);
    }
    await sleep(100);
    expect(healthy.state.players.get(healthy.sessionId)!.x).toBeGreaterThan(initial + 0.8);
    expect((await fetch(app.url + '/health/ready')).status).toBe(200);
  });

  it('does not accumulate bodies or sessions across twenty join/leave cycles', async () => {
    const initial = app.room.diagnostics().bodies;
    for (let i = 0; i < 20; i++) {
      const room = await join();
      await room.leave();
      rooms.delete(room);
      await until(() => app.room.diagnostics().sessions === 0);
      expect(app.room.diagnostics().bodies).toBe(initial);
    }
    expect(app.room.state.items.size).toBe(1);
  });

  it('preserves an unchanged axis when a diagonal delta becomes horizontal', async () => {
    const room = await join();
    const input = room.input({ type: MoveInputSchema, mode: 'reliable' });
    input.data.moveX = 1;
    input.data.moveZ = 1;
    input.send();
    await sleep(80);
    const initial = app.room.state.players.get(room.sessionId)!.x;
    for (let i = 0; i < 20; i++) {
      input.data.moveZ = 0;
      input.send();
      await sleep(17);
    }
    await sleep(80);
    expect(app.room.state.players.get(room.sessionId)!.x - initial).toBeCloseTo((20 * 4) / 60, 1);
  });

  it('creates a new epoch and rejects old session tokens after server restart', async () => {
    const old = await join();
    const token = old.reconnectionToken;
    const oldEpoch = info.worldEpoch;
    await app.close();
    rooms.delete(old);
    app = await createGameServer({ port: 0, prepareTimeoutMs: 800, reconnectSeconds: 0.8 });
    info = (await (await fetch(app.url + '/api/world')).json()) as WorldInfo;
    sdk = new Client(app.url);
    expect(info.worldEpoch).not.toBe(oldEpoch);
    await expect(sdk.reconnect(token)).rejects.toThrow();
    const fresh = await join();
    expect(fresh.state.worldEpoch).toBe(info.worldEpoch);
    expect(fresh.state.items.values().next().value!.revision).toBe(0);
  });
});
