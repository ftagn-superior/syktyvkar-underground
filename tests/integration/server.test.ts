import { prepareSdk } from '../helpers/prepare.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, CloseCode, type Room } from '@colyseus/sdk';
import { createGameServer } from '../../apps/server/src/index.js';
import { MoveInputSchema, type WorldState } from '../../packages/protocol/src/index.js';
import {
  RESPAWN_COOLDOWN_MS,
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

describe('one authoritative world over actual WebSocket connections', () => {
  let app: Awaited<ReturnType<typeof createGameServer>>;
  let info: WorldInfo;
  let sdk: Client;
  const rooms = new Set<Room<WorldState>>();
  async function join(ready = true): Promise<Room<WorldState>> {
    const room = await sdk.joinById<WorldState>(info.roomId, {
      protocolVersion: info.protocolVersion,
      mapVersion: info.mapVersion,
      simulationConfigHash: info.simulationConfigHash,
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

  it('shares one epoch and crate, spawns only once after ready', async () => {
    const first = await join(false);
    expect(app.room.state.players.size).toBe(0);
    const input = first.input({ type: MoveInputSchema, mode: 'reliable' });
    input.data.moveX = 1;
    input.send();
    await sleep(80);
    expect(app.room.state.players.size).toBe(0);
    const preparation = prepareSdk(first);
    first.send('requestArea');
    await until(() => preparation.plans.length > 0);
    preparation.ready();
    await until(() => first.state.players?.has(first.sessionId));
    const second = await join();
    await until(() => first.state.players.size === 2 && second.state.players.size === 2);
    expect(first.state.worldEpoch).toBe(second.state.worldEpoch);
    expect(first.state.crates.get('crate-01')!.entityId).toBe('crate-01');
    expect(first.state.crates.get('crate-01')!.entityId).toBe(
      second.state.crates.get('crate-01')!.entityId,
    );
    expect(app.room.diagnostics().players).toBe(2);
    expect((await fetch(app.url + '/health/ready')).status).toBe(200);
  });

  it('rejects incompatible versions and room creation', async () => {
    await expect(sdk.joinById(info.roomId, { protocolVersion: -1 })).rejects.toThrow(
      'VERSION_MISMATCH',
    );
    await expect(sdk.create('world')).rejects.toThrow();
    expect(app.room.diagnostics().players).toBe(0);
    expect((await (await fetch(app.url + '/api/world')).json()).roomId).toBe(info.roomId);
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
    recovered.reconnection.enabled = false;
    prepareSdk(recovered);
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
    await until(() => app.room.diagnostics().preparing === 0);
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
    expect(app.room.state.crates.get('crate-01')!.entityId).toBe('crate-01');
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
    expect(fresh.state.crates.get('crate-01')!.revision).toBe(0);
  });
});
