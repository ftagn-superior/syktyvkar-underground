import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGameServer } from '../../apps/server/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { MoveInputSchema, type WorldState } from '../../packages/protocol/src/index.js';
import type { ActionResult, WorldInfo } from '../../packages/contracts/src/index.js';
import { prepareSdk } from '../helpers/prepare.js';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 2500) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('L3 condition timed out');
    await delay(10);
  }
}
describe('area preparation lifecycle over actual WebSocket', () => {
  let app: Awaited<ReturnType<typeof createGameServer>>;
  let directory: string;
  let info: WorldInfo;
  let sdk: Client;
  const rooms = new Set<Room<WorldState>>();
  async function guest(automatic = true) {
    const room = await sdk.joinById<WorldState>(info.roomId, info);
    room.reconnection.enabled = false;
    rooms.add(room);
    room.onMessage('problem', () => {});
    room.onMessage('actionResult', () => {});
    room.onMessage('resync', () => {});
    const preparation = prepareSdk(room, automatic);
    await until(() => preparation.plans.length > 0);
    if (automatic) await until(() => !!room.state?.players?.has(room.sessionId));
    return { room, ...preparation };
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'su-l3-server-'));
    await cp('content', join(directory, 'content'), { recursive: true });
    const source = join(directory, 'content/worlds/streaming-lab/world.json');
    const header = JSON.parse(await readFile(source, 'utf8'));
    // The server owns these test spawn points. Clients never submit coordinates.
    header.spawnPoints = [
      { x: -4, y: 0, z: 4 },
      { x: 504, y: 0, z: 504 },
      { x: -504, y: 0, z: -504 },
      { x: -996, y: 0, z: 4 },
      { x: -996, y: 0, z: 504 },
      { x: 504, y: 0, z: -996 },
      { x: -496, y: 0, z: 754 },
      { x: 754, y: 0, z: -496 },
    ];
    await writeFile(source, JSON.stringify(header));
    await buildWorld(source, join(directory, 'release'));
    app = await createGameServer({
      port: 0,
      worldDirectory: join(directory, 'release'),
      prepareTimeoutMs: 650,
      reconnectSeconds: 1,
    });
    info = await (await fetch(app.url + '/api/world')).json();
    sdk = new Client(app.url);
  });
  afterEach(async () => {
    await Promise.all([...rooms].map((room) => room.leave().catch(() => {})));
    rooms.clear();
    await until(() => app.room.diagnostics().sessions === 0);
  });
  afterAll(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  it('reserves a seat without a character, rejects foreign versions and completes only the matching plan once', async () => {
    const guestA = await guest(false);
    const { room, plans, ready, results } = guestA;
    const plan = plans.at(-1)!;
    expect(plan.cellIds).toHaveLength(9);
    expect(app.room.diagnostics()).toMatchObject({ sessions: 1, players: 0, preparing: 1 });
    room.send('areaReady', { ...plan, mapVersion: 'wrong' });
    room.send('areaReady', { ...plan, prepareId: 'unknown' });
    await delay(70);
    expect(app.room.diagnostics().players).toBe(0);
    ready(plan);
    ready(plan);
    await until(() => results.length >= 2 && room.state.players?.has(room.sessionId));
    expect(results[0]).toEqual(results[1]);
    expect(results[0].ok).toBe(true);
    expect(app.room.diagnostics().players).toBe(1);
  });
  it('replaces an occupied spawn plan without extending its deadline and ignores the old acknowledgment', async () => {
    const first = await guest(false);
    const old = first.plans.at(-1)!;
    await guest(); // occupies the target while the first browser is loading it
    first.ready(old);
    await until(() => first.plans.some((plan) => plan.prepareId !== old.prepareId));
    const next = first.plans.at(-1)!;
    expect(next.position.x).toBe(504);
    expect(next.expiresAt).toBeLessThanOrEqual(old.expiresAt + 2);
    first.ready(old);
    await delay(30);
    expect(app.room.state.players?.has(first.room.sessionId)).toBe(false);
    first.ready(next);
    await until(() => first.room.state.players?.has(first.room.sessionId));
    expect(first.room.state.players.get(first.room.sessionId)!.x).toBeCloseTo(504);
    expect(app.room.diagnostics().players).toBe(2);
  });
  it('expires an unready plan while another client continues moving', async () => {
    const slow = await guest(false);
    const good = await guest();
    const player = good.room.state.players.get(good.room.sessionId)!;
    const start = player.x;
    const input = good.room.input({ type: MoveInputSchema });
    for (let i = 0; i < 25; i++) {
      input.data.moveX = 1;
      input.send();
      await delay(17);
    }
    await until(() => app.room.diagnostics().sessions === 1);
    expect(player.x - start).toBeGreaterThan(1);
    expect(app.room.diagnostics().players).toBe(1);
    rooms.delete(slow.room);
  });
  it('keeps the old character neutral during a return; timeout preserves it and a retry commits exactly one revision', async () => {
    const { room, plans, ready } = await guest();
    const player = room.state.players.get(room.sessionId)!;
    const id = player.entityId;
    const results: ActionResult[] = [];
    room.onMessage<ActionResult>('actionResult', (result) => results.push(result));
    // Stop automatic acknowledgment after initial entry by holding a second manual session instead.
    const held = await guest(false);
    held.ready();
    await until(() => held.room.state.players?.has(held.room.sessionId));
    const heldPlayer = held.room.state.players.get(held.room.sessionId)!;
    const origin = { x: heldPlayer.x, z: heldPlayer.z };
    const before = held.plans.length;
    held.room.send('requestRespawn', { requestId: 1, worldEpoch: info.worldEpoch });
    await until(() => held.plans.length > before);
    const input = held.room.input({ type: MoveInputSchema });
    for (let i = 0; i < 10; i++) {
      input.data.moveX = 1;
      input.send();
      await delay(17);
    }
    expect(heldPlayer.entityId).not.toBe(id);
    expect(heldPlayer.revision).toBe(0);
    expect(Math.hypot(heldPlayer.x - origin.x, heldPlayer.z - origin.z)).toBeLessThan(0.02);
    await until(() => held.results.some((result) => result.code === 'PREPARE_TIMEOUT'));
    expect(heldPlayer.revision).toBe(0);
    expect(app.room.diagnostics().players).toBe(2);
    const afterTimeout = held.plans.length;
    held.room.send('requestRespawn', { requestId: 2, worldEpoch: info.worldEpoch });
    await until(() => held.plans.length > afterTimeout);
    const plan = held.plans.at(-1)!;
    held.ready(plan);
    held.ready(plan);
    await until(() => heldPlayer.revision === 1);
    held.room.send('requestRespawn', { requestId: 2, worldEpoch: info.worldEpoch });
    await delay(50);
    expect(heldPlayer.revision).toBe(1);
    expect(plans.length).toBeGreaterThan(0);
    ready();
  });
  it('reconnects at the actual distant position and keeps input neutral until preparation completes', async () => {
    await guest();
    const distant = await guest();
    const player = distant.room.state.players.get(distant.room.sessionId)!;
    const id = player.entityId;
    const token = distant.room.reconnectionToken;
    const position = { x: player.x, z: player.z };
    distant.room.connection.close(1000);
    await until(() => app.room.diagnostics().reserved === 1);
    const room = await sdk.reconnect<WorldState>(token);
    room.reconnection.enabled = false;
    rooms.delete(distant.room);
    rooms.add(room);
    room.onMessage('problem', () => {});
    room.onMessage('resync', () => {});
    const prep = prepareSdk(room, false);
    await until(() => prep.plans.length > 0 && !!room.state?.players?.has(room.sessionId));
    expect(prep.plans.at(-1)).toMatchObject({
      reason: 'reconnect',
      position: { x: position.x, z: position.z },
    });
    const input = room.input({ type: MoveInputSchema });
    for (let i = 0; i < 8; i++) {
      input.data.moveX = 1;
      input.send();
      await delay(17);
    }
    expect(room.state.players.get(room.sessionId)!.x).toBeCloseTo(position.x);
    prep.ready();
    await until(() => prep.results.some((result) => result.ok));
    expect(room.state.players.get(room.sessionId)!.entityId).toBe(id);
    expect(app.room.diagnostics().players).toBe(2);
  });
});
