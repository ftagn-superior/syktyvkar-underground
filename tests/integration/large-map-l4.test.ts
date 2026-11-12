import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGameServer } from '../../apps/server/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { MoveInputSchema, WorldState, visibleCrate } from '../../packages/protocol/src/index.js';
import type { WorldInfo } from '../../packages/contracts/src/index.js';
import { prepareSdk } from '../helpers/prepare.js';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 3500) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('L4 visibility timed out');
    await delay(10);
  }
}
describe('production StateView over real WebSocket', () => {
  let app: Awaited<ReturnType<typeof createGameServer>>,
    directory: string,
    info: WorldInfo,
    sdk: Client;
  const rooms = new Set<Room<WorldState>>();
  async function guest() {
    const room = await sdk.joinById<WorldState>(info.roomId, info, WorldState);
    rooms.add(room);
    room.reconnection.enabled = false;
    const first: { ids: string[]; crate?: string; occupancy: number }[] = [];
    room.onStateChange.once((state) =>
      first.push({
        ids: [...state.players.values()].map((player) => player.entityId),
        crate: visibleCrate(state)?.entityId,
        occupancy: state.occupancy,
      }),
    );
    room.onMessage('problem', () => {});
    room.onMessage('actionResult', () => {});
    room.onMessage('resync', () => {});
    prepareSdk(room);
    await until(() => !!room.state?.players?.has(room.sessionId));
    return { room, first };
  }
  async function move(room: Room<WorldState>, x: number) {
    const input = room.input({ type: MoveInputSchema });
    const deadline = performance.now() + 9000;
    while (performance.now() < deadline) {
      const player = room.state.players.get(room.sessionId)!;
      if (Math.abs(player.x - x) < 0.14) {
        input.data.moveX = 0;
        input.send();
        await delay(150);
        return;
      }
      input.data.moveX = Math.sign(x - player.x);
      input.data.moveZ = 0;
      input.send();
      await delay(17);
    }
    throw new Error('L4 movement timed out');
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'su-l4-server-'));
    await cp('content', join(directory, 'content'), { recursive: true });
    const source = join(directory, 'content/worlds/streaming-lab/world.json');
    const header = JSON.parse(await readFile(source, 'utf8'));
    header.spawnPoints = [
      { x: -4, y: 0, z: 4 },
      { x: 86, y: 0, z: 4 },
      { x: -504, y: 0, z: -504 },
      { x: -996, y: 0, z: 4 },
      { x: -996, y: 0, z: 504 },
      { x: 504, y: 0, z: -996 },
      { x: -496, y: 0, z: 754 },
      { x: 754, y: 0, z: -496 },
    ];
    header.crate.position = { x: -4, y: 0.52, z: 10 };
    await writeFile(source, JSON.stringify(header));
    await buildWorld(source, join(directory, 'world'));
    app = await createGameServer({
      port: 0,
      worldDirectory: join(directory, 'world'),
      reconnectSeconds: 2,
    });
    info = await (await fetch(app.url + '/api/world')).json();
    sdk = new Client(app.url);
  });
  afterEach(async () => {
    await Promise.all([...rooms].map((room) => room.leave().catch(() => {})));
    rooms.clear();
    await until(() => app.room.diagnostics().sessions === 0);
    expect(app.room.diagnostics().interest).toMatchObject({ indexed: 1, views: 0, memberships: 0 });
    expect(app.room.state.crates.size).toBe(1);
  });
  afterAll(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  it('rejects the previous singleton-reference protocol before creating a session', async () => {
    await expect(
      sdk.joinById(info.roomId, { ...info, protocolVersion: 2 }, WorldState),
    ).rejects.toThrow('VERSION_MISMATCH');
    expect(app.room.diagnostics().sessions).toBe(0);
  });
  it('filters the first snapshot and keeps global occupancy and input acknowledgments without a crate', async () => {
    const a = await guest(),
      b = await guest(),
      c = await guest();
    for (const guest of [a, b, c])
      expect(guest.first[0]).toMatchObject({ ids: [], crate: undefined });
    await until(() => [a, b, c].every(({ room }) => room.state.occupancy === 3));
    expect(a.room.state.players.size).toBe(1);
    expect(b.room.state.players.size).toBe(1);
    expect(c.room.state.players.size).toBe(1);
    expect(visibleCrate(a.room.state)).toBeDefined();
    expect(visibleCrate(b.room.state)).toBeUndefined();
    expect(visibleCrate(c.room.state)).toBeUndefined();
    const input = b.room.input({ type: MoveInputSchema });
    const start = b.room.state.players.get(b.room.sessionId)!.x;
    for (let i = 0; i < 12; i++) {
      input.data.moveX = 1;
      input.send();
      await delay(17);
    }
    await until(() => input.lastProcessed >= 12);
    expect(b.room.state.players.get(b.room.sessionId)!.x - start).toBeGreaterThan(0.5);
    expect(b.room.state.serverTick).toBeGreaterThan(0);
    expect(b.room.state.worldEpoch).toBe(info.worldEpoch);
    expect(b.room.state.mapVersion).toBe(info.mapVersion);
    expect(visibleCrate(b.room.state)).toBeUndefined();
  });
  it('uses hysteresis and rebuilds the first reconnect view without its old 80–100m membership', async () => {
    const a = await guest(),
      b = await guest();
    const aId = a.room.state.players.get(a.room.sessionId)!.entityId;
    const bId = b.room.state.players.get(b.room.sessionId)!.entityId;
    await move(b.room, 74);
    await until(() => a.room.state.players.has(b.room.sessionId) && !!visibleCrate(b.room.state));
    await move(b.room, 86);
    expect(b.room.state.players.has(a.room.sessionId)).toBe(true);
    expect(visibleCrate(b.room.state)).toBeDefined();
    const token = b.room.reconnectionToken;
    b.room.connection.close(1000);
    await until(() => app.room.diagnostics().reserved === 1);
    const recovered = await sdk.reconnect<WorldState>(token, WorldState);
    rooms.delete(b.room);
    rooms.add(recovered);
    recovered.reconnection.enabled = false;
    const snapshots: { ids: string[]; crate?: string }[] = [];
    recovered.onStateChange.once((state) =>
      snapshots.push({
        ids: [...state.players.values()].map((player) => player.entityId),
        crate: visibleCrate(state)?.entityId,
      }),
    );
    recovered.onMessage('problem', () => {});
    recovered.onMessage('resync', () => {});
    prepareSdk(recovered);
    await until(() => snapshots.length > 0 && app.room.diagnostics().preparing === 0);
    expect(snapshots[0]).toEqual({ ids: [bId], crate: undefined });
    expect(recovered.state.players.has(a.room.sessionId)).toBe(false);
    expect(recovered.state.players.get(recovered.sessionId)!.entityId).toBe(bId);
    await move(recovered, 74);
    await until(() => recovered.state.players.has(a.room.sessionId));
    expect(recovered.state.players.get(a.room.sessionId)!.entityId).toBe(aId);
    await move(recovered, 98);
    await until(
      () => !a.room.state.players.has(recovered.sessionId) && !visibleCrate(recovered.state),
    );
    await move(recovered, 86);
    expect(recovered.state.players.has(a.room.sessionId)).toBe(false);
    expect(visibleCrate(recovered.state)).toBeUndefined();
    await move(recovered, 74);
    await until(
      () => recovered.state.players.has(a.room.sessionId) && !!visibleCrate(recovered.state),
    );
    expect(app.room.diagnostics().interest.indexed).toBe(3);
  }, 30000);
  it('destroys a visible entity in every view and frees each departed observer', async () => {
    const a = await guest(),
      b = await guest();
    await move(b.room, 74);
    await until(() => a.room.state.players.has(b.room.sessionId));
    await b.room.leave();
    rooms.delete(b.room);
    await until(() => !a.room.state.players.has(b.room.sessionId) && a.room.state.occupancy === 1);
    expect(app.room.diagnostics().interest).toMatchObject({ indexed: 2, views: 1, memberships: 2 });
    expect(app.room.diagnostics().players).toBe(1);
  });
});
