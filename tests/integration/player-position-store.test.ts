import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseFixture } from '../helpers/database-fixture.js';
import { migrateDatabase } from '../../apps/server/src/migrations.js';
import {
  PlayerPositionStore,
  type PlayerPositionSnapshot,
} from '../../apps/server/src/players/position-store.js';
import { PlayerPositionRuntime } from '../../apps/server/src/players/position-runtime.js';

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'player position storage (real PostgreSQL)',
  () => {
    let fixture: Awaited<ReturnType<typeof createDatabaseFixture>>;
    let store: PlayerPositionStore;
    let accountId: string;
    let epoch: string;
    const worldId = 'position-storage-world';
    beforeEach(async () => {
      fixture = await createDatabaseFixture();
      store = new PlayerPositionStore(fixture.pool);
      accountId = randomUUID();
      epoch = randomUUID();
      await fixture.pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
      await fixture.pool.query(
        'INSERT INTO persistent_worlds(id,compatibility_hash,epoch) VALUES($1,$2,$3)',
        [worldId, 'test-position-hash', epoch],
      );
    });
    afterEach(async () => {
      store?.abort();
      await fixture?.close();
    });
    function snapshot(sequence = 1, x = 12): PlayerPositionSnapshot {
      return {
        accountId,
        worldId,
        position: { x, y: 0.92, z: -4 },
        writeEpoch: epoch,
        writeSequence: sequence,
      };
    }

    it('upgrades schema 6 additively with no invented positions or changed account data', async () => {
      await fixture.pool.query('DROP TABLE player_positions');
      await fixture.pool.query('DELETE FROM su_schema_migrations WHERE version=7');
      await fixture.pool.query(
        "INSERT INTO player_profiles(account_id,display_name,color_id,version) VALUES($1,'Путник','mint',4)",
        [accountId],
      );
      const profileBefore = (await fixture.pool.query('SELECT * FROM player_profiles')).rows;
      const accountBefore = (await fixture.pool.query('SELECT * FROM accounts')).rows;
      const worldsBefore = (await fixture.pool.query('SELECT * FROM persistent_worlds')).rows;
      await migrateDatabase(fixture.pool);
      await migrateDatabase(fixture.pool);
      expect((await fixture.pool.query('SELECT * FROM player_positions')).rows).toEqual([]);
      expect((await fixture.pool.query('SELECT * FROM player_profiles')).rows).toEqual(
        profileBefore,
      );
      expect((await fixture.pool.query('SELECT * FROM accounts')).rows).toEqual(accountBefore);
      expect((await fixture.pool.query('SELECT * FROM persistent_worlds')).rows).toEqual(
        worldsBefore,
      );
    });

    it('isolates account/world keys, rejects non-finite coordinates and cascades account removal', async () => {
      expect(await store.save(snapshot())).toBe('saved');
      expect(await store.load(accountId, worldId)).toEqual({
        status: 'found',
        snapshot: snapshot(),
      });
      expect(await store.load(randomUUID(), worldId)).toEqual({ status: 'missing' });
      expect(await store.load(accountId, 'other-world')).toEqual({ status: 'missing' });
      const secondWorld = 'position-other-world';
      await fixture.pool.query(
        'INSERT INTO persistent_worlds(id,compatibility_hash,epoch) VALUES($1,$2,$3)',
        [secondWorld, 'other-hash', epoch],
      );
      expect(await store.save({ ...snapshot(), worldId: secondWorld })).toBe('saved');
      expect(
        (await fixture.pool.query('SELECT count(*)::int AS count FROM player_positions')).rows[0]
          .count,
      ).toBe(2);
      for (const value of ['NaN', 'Infinity', '-Infinity'])
        await expect(
          fixture.pool.query('UPDATE player_positions SET x=$1 WHERE account_id=$2', [
            value,
            accountId,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
      await fixture.pool.query('DELETE FROM accounts WHERE id=$1', [accountId]);
      expect((await fixture.pool.query('SELECT * FROM player_positions')).rows).toEqual([]);
    });

    it('makes repeats and uncertain COMMIT retries idempotent and rejects an older snapshot', async () => {
      const latest = snapshot(9, 29);
      expect(await store.save(latest)).toBe('saved');
      expect(await store.save(latest)).toBe('superseded');
      expect(await store.save(snapshot(8, 3))).toBe('superseded');
      expect(await store.load(accountId, worldId)).toEqual({ status: 'found', snapshot: latest });
      const before = (await fixture.pool.query('SELECT updated_at FROM player_positions')).rows[0]
        .updated_at;
      expect(await store.save(latest)).toBe('superseded');
      expect(
        (await fixture.pool.query('SELECT updated_at FROM player_positions')).rows[0].updated_at,
      ).toEqual(before);
    });

    it('rejects persisted sequences that cannot be represented safely by the runtime', async () => {
      await store.save(snapshot());
      await fixture.pool.query(
        'UPDATE player_positions SET write_sequence=9007199254740992 WHERE account_id=$1',
        [accountId],
      );
      expect(await store.load(accountId, worldId)).toEqual({
        status: 'unavailable',
        reason: 'invalid',
      });
    });

    it('lets a new epoch read the previous confirmed position while fencing the old writer', async () => {
      await store.save(snapshot(5));
      const newEpoch = randomUUID();
      await fixture.pool.query('UPDATE persistent_worlds SET epoch=$2 WHERE id=$1', [
        worldId,
        newEpoch,
      ]);
      expect(await store.save(snapshot(6, 77))).toBe('ownership-lost');
      expect(await store.load(accountId, worldId)).toEqual({
        status: 'found',
        snapshot: snapshot(5),
      });
      const next = { ...snapshot(1, 33), writeEpoch: newEpoch };
      expect(await store.save(next)).toBe('saved');
      expect(await store.load(accountId, worldId)).toEqual({ status: 'found', snapshot: next });
    });

    it('holds the epoch row lock until its write commits, serializing an overlapping ownership transition', async () => {
      const blocker = await fixture.pool.connect();
      let writing: Promise<unknown> | undefined;
      let transition: Promise<unknown> | undefined;
      const newEpoch = randomUUID();
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE player_positions IN ACCESS EXCLUSIVE MODE');
        writing = store.save(snapshot());
        await vi.waitFor(
          async () => {
            const state = await fixture.pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND query LIKE 'INSERT INTO player_positions%' AND wait_event_type='Lock'",
            );
            expect(state.rowCount).toBe(1);
          },
          { interval: 10, timeout: 300 },
        );
        transition = fixture.pool.query('UPDATE persistent_worlds SET epoch=$2 WHERE id=$1', [
          worldId,
          newEpoch,
        ]);
        await vi.waitFor(
          async () => {
            const state = await fixture.pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND query LIKE 'UPDATE persistent_worlds SET epoch=%' AND wait_event_type='Lock'",
            );
            expect(state.rowCount).toBe(1);
          },
          { interval: 10, timeout: 300 },
        );
        await blocker.query('COMMIT');
        expect(await writing).toBe('saved');
        await transition;
        expect(await store.save(snapshot(2, 99))).toBe('ownership-lost');
        expect(await store.load(accountId, worldId)).toEqual({
          status: 'found',
          snapshot: snapshot(),
        });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled([writing, transition]);
      }
    });

    it('rolls back lock timeouts and returns connections with their original SQL settings', async () => {
      const blocker = await fixture.pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'UPDATE persistent_worlds SET compatibility_hash=compatibility_hash WHERE id=$1',
          [worldId],
        );
        // UPDATE of a non-key column is compatible with FOR KEY SHARE, but FOR SHARE must wait.
        await expect(store.save(snapshot())).rejects.toMatchObject({ code: '55P03' });
        await blocker.query('ROLLBACK');
        expect(await store.save(snapshot())).toBe('saved');
        const clients = await Promise.all([fixture.pool.connect(), fixture.pool.connect()]);
        try {
          for (const client of clients) {
            expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe(
              '5s',
            );
            expect((await client.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
            expect((await client.query('SELECT 1 AS value')).rows[0].value).toBe(1);
          }
        } finally {
          for (const client of clients) client.release();
        }
      } finally {
        blocker.release();
      }
    });

    it('flushes the runtime before shutdown and destroys blocked transactions at its deadline', async () => {
      const runtime = new PlayerPositionRuntime({
        pool: fixture.pool,
        worldId,
        writeEpoch: epoch,
        isAccountActive: () => false,
        onOwnershipLost: () => {},
      });
      const last = runtime.capture(accountId, { x: 44, y: 0.92, z: -4 });
      await runtime.close();
      expect(await store.load(accountId, worldId)).toEqual({ status: 'found', snapshot: last });
      const blocker = await fixture.pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE player_positions IN ACCESS EXCLUSIVE MODE');
        const blocked = new PlayerPositionRuntime({
          pool: fixture.pool,
          worldId,
          writeEpoch: epoch,
          isAccountActive: () => false,
          onOwnershipLost: () => {},
          closeTimeoutMs: 50,
        });
        blocked.capture(accountId, { x: 99, y: 0.92, z: -4 });
        await expect(blocked.close()).rejects.toThrow('exceeded deadline');
        await blocker.query('COMMIT');
        expect(await store.load(accountId, worldId)).toEqual({ status: 'found', snapshot: last });
        expect(blocked.diagnostics()).toMatchObject({ busy: false });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
    });
  },
);
