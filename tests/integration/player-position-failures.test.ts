import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import type { ActionResult, InventoryView, WorldInfo } from '../../packages/contracts/src/index.js';
import type { WorldState } from '../../packages/protocol/src/index.js';
import { ItemRuntime } from '../../apps/server/src/items/runtime.js';
import { ItemStore } from '../../apps/server/src/items/store.js';
import { PlayerPositionRuntime } from '../../apps/server/src/players/position-runtime.js';
import { PlayerPositionStore } from '../../apps/server/src/players/position-store.js';
import { createGameServer } from '../helpers/game-server.js';
import { createAccountFixture, loginAccount, responseCookie } from '../helpers/account-fixture.js';
import { prepareSdk } from '../helpers/prepare.js';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 4000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeout)
      throw new Error('Timed out waiting for persistence failure handling');
    await wait(15);
  }
}

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'position persistence failure isolation (real PostgreSQL and WebSockets)',
  () => {
    let fixture: Awaited<ReturnType<typeof createAccountFixture>>;
    let app: Awaited<ReturnType<typeof createGameServer>>;
    let info: WorldInfo;
    let serverClosed = false;
    const rooms = new Set<Room<WorldState>>();

    beforeEach(async () => {
      serverClosed = false;
      fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL!);
      app = await createGameServer({ port: 0, accounts: fixture, testDiagnostics: true });
      fixture.config.publicOrigin = app.url;
      info = await (await fetch(app.url + '/api/world')).json();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await Promise.allSettled([...rooms].map((room) => room.leave()));
      rooms.clear();
      if (!serverClosed) await app?.close();
      await fixture?.close();
    });
    async function join(subject: string) {
      const { result } = await loginAccount(app.url, subject);
      const cookie = responseCookie(result, 'su_session');
      const sdk = new Client(app.url, { headers: { Cookie: cookie } });
      const room = await sdk.joinById<WorldState>(info.roomId, { ...info, accountMode: 'account' });
      room.reconnection.enabled = false;
      const inventories: InventoryView[] = [],
        actions: ActionResult[] = [];
      room.onMessage('inventory', (data) => inventories.push(data));
      room.onMessage('actionResult', (data) => actions.push(data));
      room.onMessage('problem', () => {});
      room.onMessage('resync', () => {});
      rooms.add(room);
      prepareSdk(room);
      await until(() => !!room.state?.players?.has(room.sessionId));
      return { room, cookie, inventories, actions };
    }
    async function assertOwnershipReleased() {
      const client = await fixture.pool.connect();
      try {
        const lock = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || current_schema() || ':' || $1, 193708)) AS locked",
          ['physics-lab'],
        );
        expect(lock.rows[0].locked).toBe(true);
        if (lock.rows[0].locked)
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended(current_database() || ':' || current_schema() || ':' || $1, 193708))",
            ['physics-lab'],
          );
      } finally {
        client.release();
      }
    }

    it('propagates a final position error after still flushing items and releasing world ownership', async () => {
      const owner = await join('position-final-save-error');
      await until(() => app.room.diagnostics().playerPositions.pendingAccounts === 0);
      const original = PlayerPositionRuntime.prototype.close;
      const failure = new Error('test final position flush failure');
      const positionClose = vi
        .spyOn(PlayerPositionRuntime.prototype, 'close')
        .mockImplementationOnce(async function (this: PlayerPositionRuntime) {
          // Complete the real worker lifecycle before simulating an unsuccessful final-save report.
          await original.call(this);
          throw failure;
        });
      const itemClose = vi.spyOn(ItemRuntime.prototype, 'close');
      const itemSave = vi.spyOn(ItemStore.prototype, 'save');
      const itemStoreClose = vi.spyOn(ItemStore.prototype, 'close');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const closing = app.close();
      serverClosed = true;
      expect(app.close()).toBe(closing);
      await expect(closing).rejects.toBe(failure);
      expect(positionClose).toHaveBeenCalledTimes(1);
      expect(itemClose).toHaveBeenCalledTimes(1);
      expect(itemSave).toHaveBeenCalledTimes(1);
      expect(itemStoreClose).toHaveBeenCalledTimes(1);
      expect(app.room.diagnostics()).toMatchObject({ disposed: true, bodies: 0 });
      expect(app.http.listening).toBe(false);
      expect(log).toHaveBeenCalledWith('World disposal follows an incomplete final save.');
      await until(() => !owner.room.connection.isOpen);
      await assertOwnershipReleased();
    });

    it('keeps item grants and gameplay available while only position writes fail', async () => {
      const positionSave = vi
        .spyOn(PlayerPositionStore.prototype, 'save')
        .mockRejectedValue(new Error('test position storage outage'));
      const owner = await join('position-outage-item-success');
      try {
        await until(() => app.room.diagnostics().playerPositions.writeErrors > 0);
        expect(app.room.state.paused).toBe(false);
        expect((await fetch(app.url + '/health/ready')).status).toBe(200);
        owner.room.send('requestChat', {
          requestId: 1,
          worldEpoch: info.worldEpoch,
          text: '/giveme wooden-crate',
        });
        await until(
          () =>
            owner.actions.length === 1 && owner.inventories.at(-1)?.slots[0]?.items.length === 1,
        );
        expect(owner.actions[0]).toMatchObject({
          ok: true,
          message: 'Получен предмет: Деревянный ящик ×1.',
        });
        expect(
          (await fixture.pool.query('SELECT count(*)::int AS count FROM item_operations')).rows[0]
            .count,
        ).toBe(1);
        expect(
          (await fixture.pool.query('SELECT count(*)::int AS count FROM player_positions')).rows[0]
            .count,
        ).toBe(0);
        expect(app.room.state.paused).toBe(false);
        expect(owner.room.connection.isOpen).toBe(true);
        expect(app.room.diagnostics().playerPositions.pendingAccounts).toBe(1);
      } finally {
        positionSave.mockRestore();
      }
    });

    it('stops readiness, physics and admission when a position writer discovers ownership loss', async () => {
      const owner = await join('position-ownership-loss');
      await until(() => app.room.diagnostics().playerPositions.pendingAccounts === 0);
      const positionSave = vi
        .spyOn(PlayerPositionStore.prototype, 'save')
        .mockResolvedValue('ownership-lost');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      owner.room.send('requestRespawn', { requestId: 1, worldEpoch: info.worldEpoch });
      await until(() => app.room.diagnostics().playerPositions.ownershipLost);
      expect(app.room.isReady()).toBe(false);
      expect((await fetch(app.url + '/health/ready')).status).toBe(503);
      const tick = app.room.state.serverTick;
      await wait(100);
      expect(app.room.state.serverTick).toBe(tick);
      expect(positionSave).toHaveBeenCalledTimes(1);
      await expect(
        new Client(app.url).joinById(info.roomId, { ...info, accountMode: 'guest' }),
      ).rejects.toThrow('WORLD_NOT_READY');
      serverClosed = true;
      await expect(app.close()).rejects.toThrow('Player position ownership lost');
      expect(log).toHaveBeenCalledWith('World ownership lost', expect.any(Error));
      await assertOwnershipReleased();
    });
  },
);
