import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { createGameServer } from '../helpers/game-server.js';
import { createAccountFixture, loginAccount, responseCookie } from '../helpers/account-fixture.js';
import { MoveInputSchema, type WorldState } from '../../packages/protocol/src/index.js';
import { ItemStore } from '../../apps/server/src/items/store.js';
import type {
  InventoryView,
  ItemCommand,
  ItemResult,
  WorldInfo,
} from '../../packages/contracts/src/index.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let n = 0; n < 250; n++) {
    if (predicate()) return;
    await wait(15);
  }
  throw new Error('Timed out waiting for item replication');
}
describe.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'private inventory over actual authenticated WebSockets',
  () => {
    let fixture: Awaited<ReturnType<typeof createAccountFixture>>;
    let app: Awaited<ReturnType<typeof createGameServer>>;
    let info: WorldInfo;
    const rooms: Room<WorldState>[] = [];
    async function start() {
      app = await createGameServer({ port: 0, accounts: fixture });
      fixture.config.publicOrigin = app.url;
      info = await fetch(app.url + '/api/world').then((r) => r.json());
    }
    async function login(subject: string) {
      const { result } = await loginAccount(app.url, subject);
      return responseCookie(result, 'su_session');
    }
    async function join(cookie?: string) {
      const room = await new Client(
        app.url,
        cookie ? { headers: { Cookie: cookie } } : {},
      ).joinById<WorldState>(info.roomId, { ...info, accountMode: cookie ? 'account' : 'guest' });
      const inventories: InventoryView[] = [],
        results: ItemResult[] = [];
      room.reconnection.enabled = false;
      room.onMessage('inventory', (data) => inventories.push(data));
      room.onMessage('itemResult', (data) => results.push(data));
      room.onMessage('problem', () => {});
      room.onMessage('resync', () => {});
      rooms.push(room);
      room.send('clientReady');
      await until(() => !!room.state?.players?.has(room.sessionId));
      return { room, inventories, results };
    }
    beforeAll(async () => {
      fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL!);
      await start();
    });
    afterAll(async () => {
      await Promise.allSettled(rooms.map((r) => r.leave()));
      await app?.close();
      await fixture?.close();
    });

    it('I03/I04/I06/I08/I17/I18: keeps inventories private, completes a disconnected commit, restores an empty world and replays its result', async () => {
      const guest = await join(),
        cookie = await login('item-owner');
      const owner = await join(cookie);
      const item = app.room.state.items.values().next().value!;
      const deniedId = randomUUID();
      guest.room.send('itemCommand', {
        operationId: deniedId,
        worldEpoch: info.worldEpoch,
        action: { kind: 'pickup', itemId: item.entityId },
      });
      await until(() => guest.results.length > 0);
      expect(guest.results[0].code).toBe('AUTH_REQUIRED');
      expect(guest.inventories).toEqual([]);
      const input = owner.room.input({ type: MoveInputSchema, mode: 'reliable' });
      for (let n = 0; n < 80; n++) {
        const player = owner.room.state.players.get(owner.room.sessionId)!;
        const dx = item.x - player.x,
          dz = item.z - player.z;
        if (Math.hypot(dx, dz) < 2.4) break;
        input.data.moveX = dx;
        input.data.moveZ = dz;
        input.send();
        await wait(17);
      }
      input.data.moveX = input.data.moveZ = 0;
      input.send();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let committed = false;
      const original = ItemStore.prototype.operation;
      const spy = vi.spyOn(ItemStore.prototype, 'operation').mockImplementationOnce(async function (
        this: ItemStore,
        ...args
      ) {
        const result = await original.apply(this, args);
        committed = result.ok;
        await gate;
        return result;
      });
      const command: ItemCommand = {
        operationId: randomUUID(),
        worldEpoch: info.worldEpoch,
        action: { kind: 'pickup', itemId: item.entityId },
      };
      owner.room.send('itemCommand', command);
      await until(() => committed);
      await owner.room.leave();
      release();
      spy.mockRestore();
      await until(() => app.room.state.items.size === 0);
      expect((guest.room.state as unknown as Record<string, unknown>).inventory).toBeUndefined();
      expect(guest.inventories).toEqual([]);
      const other = await join(await login('other-owner'));
      await until(() => other.inventories.length > 0);
      expect(other.inventories.at(-1)!.slots).toEqual([]);
      await Promise.allSettled(rooms.map((r) => r.leave()));
      await app.close();
      await start();
      expect(app.room.state.items.size).toBe(0);
      const restored = await join(cookie);
      await until(() => restored.inventories.length > 0);
      expect(restored.inventories.at(-1)!.slots[0].items[0].itemId).toBe(item.entityId);
      restored.room.send('itemCommand', command);
      await until(() => restored.results.length > 0);
      expect(restored.results[0]).toEqual({ operationId: command.operationId, ok: true });
      expect(app.room.state.items.size).toBe(0);
      const moving = restored.room.input({ type: MoveInputSchema, mode: 'reliable' });
      const before = restored.room.state.players.get(restored.room.sessionId)!.x;
      for (let n = 0; n < 10; n++) {
        moving.data.moveX = 1;
        moving.send();
        await wait(17);
      }
      await until(() => restored.room.state.players.get(restored.room.sessionId)!.x > before + 0.2);
    });
  },
);
