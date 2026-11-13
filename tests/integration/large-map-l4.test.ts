import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGameServer } from '../helpers/game-server.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { MoveInputSchema, WorldState } from '../../packages/protocol/src/index.js';
import type { WorldInfo } from '../../packages/contracts/src/index.js';
import { prepareSdk } from '../helpers/prepare.js';
const firstItem = (state: WorldState) => state.items.values().next().value;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 3500) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error('L4 visibility timed out');
    await delay(10);
  }
}
describe.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'production StateView over real WebSocket',
  () => {
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
          crate: firstItem(state)?.entityId,
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
      // Move authoritative fixtures between AOI thresholds; real-input ACK/movement is tested below.
      // Avoid spending 200 seconds traversing each 300m hysteresis band in a network unit test.
      const world = (
        app.room as unknown as {
          world: import('../../packages/simulation/src/authoritative-world.js').AuthoritativeWorld;
        }
      ).world;
      const id = room.state.players.get(room.sessionId)!.entityId;
      expect(world.respawnPlayer(id, { x, y: 0, z: 4 })).toBe(true);
      await until(() => Math.abs(room.state.players.get(room.sessionId)!.x - x) < 0.14);
      await delay(100);
    }
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'su-l4-server-'));
      await cp('content', join(directory, 'content'), { recursive: true });
      const source = join(directory, 'content/worlds/streaming-lab/world.json');
      const header = JSON.parse(await readFile(source, 'utf8'));
      header.spawnPoints = [
        { x: -4, y: 0, z: 4 },
        { x: 596, y: 0, z: 4 },
        { x: -504, y: 0, z: -504 },
        { x: -996, y: 0, z: 4 },
        { x: -996, y: 0, z: 504 },
        { x: 504, y: 0, z: -996 },
        { x: -496, y: 0, z: 754 },
        { x: 754, y: 0, z: -496 },
      ];
      header.initialItems[0].position = { x: -4, y: 0.52, z: 10 };
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
      expect(app.room.diagnostics().interest).toMatchObject({
        indexed: 1,
        views: 0,
        memberships: 0,
      });
      expect(app.room.state.items.size).toBe(1);
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
      expect(firstItem(a.room.state)).toBeDefined();
      expect(firstItem(b.room.state)).toBeUndefined();
      expect(firstItem(c.room.state)).toBeUndefined();
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
      expect(firstItem(b.room.state)).toBeUndefined();
    });
    it('uses hysteresis and rebuilds the first reconnect view without its old 500–800m membership', async () => {
      const a = await guest(),
        b = await guest();
      const aId = a.room.state.players.get(a.room.sessionId)!.entityId;
      const bId = b.room.state.players.get(b.room.sessionId)!.entityId;
      await move(b.room, 494);
      await until(() => a.room.state.players.has(b.room.sessionId) && !!firstItem(b.room.state));
      await move(b.room, 596);
      expect(b.room.state.players.has(a.room.sessionId)).toBe(true);
      expect(firstItem(b.room.state)).toBeDefined();
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
          crate: firstItem(state)?.entityId,
        }),
      );
      recovered.onMessage('problem', () => {});
      recovered.onMessage('resync', () => {});
      prepareSdk(recovered);
      await until(() => snapshots.length > 0 && app.room.diagnostics().preparing === 0);
      expect(snapshots[0]).toEqual({ ids: [bId], crate: undefined });
      expect(recovered.state.players.has(a.room.sessionId)).toBe(false);
      expect(recovered.state.players.get(recovered.sessionId)!.entityId).toBe(bId);
      await move(recovered, 494);
      await until(() => recovered.state.players.has(a.room.sessionId));
      expect(recovered.state.players.get(a.room.sessionId)!.entityId).toBe(aId);
      await move(recovered, 798);
      await until(
        () => !a.room.state.players.has(recovered.sessionId) && !firstItem(recovered.state),
      );
      await move(recovered, 596);
      expect(recovered.state.players.has(a.room.sessionId)).toBe(false);
      expect(firstItem(recovered.state)).toBeUndefined();
      await move(recovered, 494);
      await until(
        () => recovered.state.players.has(a.room.sessionId) && !!firstItem(recovered.state),
      );
      expect(app.room.diagnostics().interest.indexed).toBe(3);
    }, 30000);
    it('destroys a visible entity in every view and frees each departed observer', async () => {
      const a = await guest(),
        b = await guest();
      await move(b.room, 494);
      await until(() => a.room.state.players.has(b.room.sessionId));
      await b.room.leave();
      rooms.delete(b.room);
      await until(
        () => !a.room.state.players.has(b.room.sessionId) && a.room.state.occupancy === 1,
      );
      expect(app.room.diagnostics().interest).toMatchObject({
        indexed: 2,
        views: 1,
        memberships: 2,
      });
      expect(app.room.diagnostics().players).toBe(1);
    });
    it('continues simulating and saving an item outside every observer without changing its identity', async () => {
      const observer = await guest();
      const internal = app.room as unknown as {
        world: import('../../packages/simulation/src/authoritative-world.js').AuthoritativeWorld;
        items: import('../../apps/server/src/items/runtime.js').ItemRuntime;
      };
      const snapshot = internal.world.getSnapshot();
      expect(snapshot.scope).toBe('authoritative');
      const item = snapshot.items[0];
      internal.world.replaceItems([
        { ...item, position: { x: 950, y: 5, z: 950 }, velocity: { x: 0.2, y: 0, z: 0 } },
      ]);
      await until(() => observer.room.state.items?.size === 0);
      expect(app.room.state.items.has(item.entityId)).toBe(true);
      expect(internal.world.getSnapshot().items).toHaveLength(1);
      // Check the committed checkpoint: its 1s cadence can outlast a fixed 650ms sleep.
      const saved = await vi.waitFor(
        async () => {
          const result = await internal.items.store.pool.query(
            'SELECT id,world_id,slot_id,physical FROM item_instances WHERE id=$1',
            [item.entityId],
          );
          expect(result.rows[0].physical.position.x).toBeGreaterThan(949);
          expect(result.rows[0].physical.position.z).toBeGreaterThan(949);
          return result;
        },
        { timeout: 3500, interval: 25 },
      );
      expect(saved.rows[0]).toMatchObject({
        id: item.entityId,
        world_id: 'streaming-lab',
        slot_id: null,
      });
      expect(saved.rows[0].physical.position.x).toBeGreaterThan(949);
      expect(saved.rows[0].physical.position.z).toBeGreaterThan(949);
      expect(internal.world.getSnapshot().items[0].position.y).toBeLessThan(5);
    });
  },
);
