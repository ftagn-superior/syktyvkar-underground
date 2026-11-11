import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemStore } from '../../apps/server/src/items/store.js';
import { ItemRuntime } from '../../apps/server/src/items/runtime.js';
import { migrateDatabase } from '../../apps/server/src/migrations.js';
import { createAuthoritativeWorld } from '../../packages/simulation/src/server.js';
import { physicsFixture } from '../../packages/simulation/src/test-fixture.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';
import type { ItemAction } from '../../packages/contracts/src/index.js';

const databaseUrl = process.env.SU_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'persistent items, inventory and ordered physics writes (real PostgreSQL)',
  () => {
    let fixture: Awaited<ReturnType<typeof createDatabaseFixture>>;
    let store: ItemStore;
    let definition: ReturnType<typeof physicsFixture>;
    let accountId: string;
    const stores: ItemStore[] = [];
    beforeEach(async () => {
      fixture = await createDatabaseFixture();
      definition = physicsFixture();
      definition.initialItems[0].position.z = 2;
      accountId = randomUUID();
      await fixture.pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
    });
    afterEach(async () => {
      for (const s of stores.splice(0)) await s.close();
      await fixture?.close();
    });
    async function open() {
      store = new ItemStore(fixture.pool, definition, randomUUID());
      stores.push(store);
      return store.initialize();
    }
    const operation = (action: ItemAction, operationId = randomUUID()) =>
      store.operation(accountId, operationId, action, () => undefined);

    it('upgrades the existing account schema in place and can reapply migrations safely', async () => {
      await fixture.pool
        .query(`DROP TABLE item_operations,item_instances,inventory_slots,item_types,persistent_worlds CASCADE;
      DROP FUNCTION validate_inventory_slot(uuid),validate_item_stack_trigger(),validate_slot_trigger(),validate_item_type_trigger();
      ALTER TABLE player_profiles DROP COLUMN skin_id;
      DELETE FROM su_schema_migrations WHERE version>=2;`);
      await migrateDatabase(fixture.pool);
      await migrateDatabase(fixture.pool);
      expect((await fixture.pool.query('SELECT id FROM accounts')).rows).toEqual([
        { id: accountId },
      ]);
      expect(
        (await fixture.pool.query('SELECT version FROM su_schema_migrations ORDER BY version'))
          .rows,
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      expect(await open()).toHaveLength(1);
    });

    it('reconciles the old skin-only migration 2 without losing the selected skin or session', async () => {
      await fixture.pool.query(`
        DROP TABLE item_operations,item_instances,inventory_slots,item_types,persistent_worlds CASCADE;
        DROP FUNCTION validate_inventory_slot(uuid),validate_item_stack_trigger(),validate_slot_trigger(),validate_item_type_trigger();
        DELETE FROM su_schema_migrations WHERE version=3;
      `);
      await fixture.pool.query(
        `INSERT INTO player_profiles(account_id,display_name,color_id,skin_id,version)
        VALUES($1,'Старый игрок','sky','standard',7)`,
        [accountId],
      );
      const sessionId = randomUUID();
      await fixture.pool.query(
        `INSERT INTO auth_sessions(id,account_id,token_hash,expires_at)
        VALUES($1,$2,'migration-test-token',now()+interval '1 day')`,
        [sessionId, accountId],
      );
      const profile = (await fixture.pool.query('SELECT * FROM player_profiles')).rows;
      const sessions = (await fixture.pool.query('SELECT * FROM auth_sessions')).rows;
      await migrateDatabase(fixture.pool);
      await migrateDatabase(fixture.pool);
      expect((await fixture.pool.query('SELECT * FROM player_profiles')).rows).toEqual(profile);
      expect((await fixture.pool.query('SELECT * FROM auth_sessions')).rows).toEqual(sessions);
      expect(
        (await fixture.pool.query('SELECT version FROM su_schema_migrations ORDER BY version'))
          .rows,
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      expect(await open()).toHaveLength(1);
    });

    it('I01/I02/I12: stacks 23 identities into 10/10/3, splits, merges, swaps and transfers one instance', async () => {
      const seed = definition.initialItems[0];
      definition.initialItems = Array.from({ length: 23 }, (_, i) => ({
        ...seed,
        seedId: `seed-${i}`,
      }));
      const items = await open();
      for (const item of items)
        expect((await operation({ kind: 'pickup', itemId: item.entityId })).ok).toBe(true);
      let inventory = await store.inventory(accountId);
      expect(inventory.slots.map((s) => s.items.length)).toEqual([10, 10, 3]);
      expect(new Set(inventory.slots.flatMap((s) => s.items.map((i) => i.itemId)))).toEqual(
        new Set(items.map((i) => i.entityId)),
      );
      const firstId = inventory.slots[0].slotId,
        secondId = inventory.slots[1].slotId;
      await operation({ kind: 'split', slotId: firstId, count: 4 });
      inventory = await store.inventory(accountId);
      expect(inventory.slots.map((s) => s.items.length)).toEqual([6, 10, 3, 4]);
      await operation({ kind: 'merge', slotId: inventory.slots[3].slotId, targetSlotId: firstId });
      await operation({ kind: 'move', slotId: firstId, targetSlotId: secondId });
      inventory = await store.inventory(accountId);
      expect(inventory.slots[0].slotId).toBe(secondId);
      const chosen = inventory.slots[1].items[0].itemId;
      await operation({ kind: 'place', itemId: chosen, pose: seed });
      expect((await store.inventory(accountId)).slots.map((s) => s.items.length)).toEqual([
        10, 9, 3,
      ]);
      const other = randomUUID();
      await fixture.pool.query('INSERT INTO accounts(id) VALUES($1)', [other]);
      await store.operation(
        other,
        randomUUID(),
        { kind: 'pickup', itemId: chosen },
        () => undefined,
      );
      expect((await store.inventory(other)).slots[0].items[0].itemId).toBe(chosen);
      const saved = await store.inventory(accountId);
      await store.close();
      await open();
      expect(await store.inventory(accountId)).toEqual(saved);
      expect(
        (await fixture.pool.query('SELECT count(*)::int AS count FROM item_instances')).rows[0]
          .count,
      ).toBe(23);
    });

    it('I04/I06/I07/I19: recovers a commit before physics/response and never seeds an empty initialized world again', async () => {
      const [item] = await open(),
        id = randomUUID();
      const action: ItemAction = { kind: 'pickup', itemId: item.entityId };
      const result = await operation(action, id);
      await store.close();
      definition.initialItems.push({ ...definition.initialItems[0], seedId: 'new-unapplied-seed' });
      expect(await open()).toEqual([]);
      expect(await operation(action, id)).toEqual(result);
      expect((await operation({ kind: 'pickup', itemId: 'different-instance' }, id)).code).toBe(
        'OPERATION_CONFLICT',
      );
      expect((await store.inventory(accountId)).slots[0].items[0].itemId).toBe(item.entityId);
      expect(
        (await fixture.pool.query('SELECT count(*)::int AS count FROM item_instances')).rows[0]
          .count,
      ).toBe(1);
    });

    it('I09: a late snapshot cannot resurrect an inventory item or overwrite a subsequent placement', async () => {
      const [old] = await open();
      await operation({ kind: 'pickup', itemId: old.entityId });
      await store.save([{ ...old, position: { x: 9, y: 9, z: 9 } }], 100);
      expect(await store.worldItems()).toEqual([]);
      await operation({
        kind: 'place',
        itemId: old.entityId,
        pose: { position: { x: 1, y: 0.52, z: 2 }, rotation: old.rotation },
      });
      const placed = await store.worldItems();
      await store.save([old], 200);
      expect(await store.worldItems()).toEqual(placed);
      const newer = { ...placed[0], position: { x: 2, y: 0.52, z: 2 } };
      await store.save([newer], 300);
      await store.save(placed, 299);
      expect((await store.worldItems())[0].position).toEqual(newer.position);
    });

    it('I13/I15: restores several touching moving items, quaternion and velocities as one batch', async () => {
      definition.initialItems.push({
        ...definition.initialItems[0],
        seedId: 'second',
        position: { x: 1, y: 0.52, z: 2 },
      });
      const items = (await open()).map((i, n) => ({
        ...i,
        position: { x: n, y: 1.1, z: 2 },
        rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
        velocity: { x: 1, y: 2, z: 3 },
        angularVelocity: { x: 0.1, y: 0.2, z: 0.3 },
      }));
      await store.save(items, 120);
      await store.close();
      expect(await open()).toEqual(items);
    });

    it('I21: reduces stack limits for offline owners without losing IDs or existing slot identity', async () => {
      const seed = definition.initialItems[0];
      definition.initialItems = Array.from({ length: 10 }, (_, i) => ({
        ...seed,
        seedId: `seed-${i}`,
      }));
      const items = await open();
      for (const i of items) await operation({ kind: 'pickup', itemId: i.entityId });
      const original = (await store.inventory(accountId)).slots[0].slotId;
      await store.close();
      definition.itemCatalog.types['wooden-crate'].maxStack = 3;
      await open();
      const inventory = await store.inventory(accountId);
      expect(inventory.slots.map((s) => s.items.length)).toEqual([3, 3, 3, 1]);
      expect(inventory.slots[0].slotId).toBe(original);
      expect(new Set(inventory.slots.flatMap((s) => s.items.map((i) => i.itemId)))).toEqual(
        new Set(items.map((i) => i.entityId)),
      );
    });

    it('refuses a second owner, incompatible geometry or missing types without changing saved items', async () => {
      const items = await open();
      const second = new ItemStore(fixture.pool, definition, randomUUID());
      stores.push(second);
      await expect(second.initialize()).rejects.toThrow('owner');
      await store.close();
      definition.entities[0].size.x = 39;
      await expect(open()).rejects.toThrow('incompatible');
      await store.close();
      definition.entities[0].size.x = 40;
      delete definition.itemCatalog.types['wooden-crate'];
      await expect(open()).rejects.toThrow('incompatible');
      expect(
        (await fixture.pool.query('SELECT id FROM item_instances')).rows.map((r) => r.id),
      ).toEqual(items.map((i) => i.entityId));
    });

    it('I05/I11: serializes competing pickups and holds placement geometry until COMMIT', async () => {
      const world = await createAuthoritativeWorld({ ...definition, initialItems: [] });
      const runtime = new ItemRuntime(
        new ItemStore(fixture.pool, definition, randomUUID()),
        world,
        () => {},
      );
      try {
        await runtime.initialize();
        world.addPlayer('a');
        world.addPlayer('b', { x: -2, y: 0, z: 0 });
        const item = world.getSnapshot().items[0];
        const other = randomUUID();
        await fixture.pool.query('INSERT INTO accounts(id) VALUES($1)', [other]);
        const command = () => ({
          operationId: randomUUID(),
          worldEpoch: runtime.store.epoch,
          action: { kind: 'pickup' as const, itemId: item.entityId },
        });
        const results = await Promise.all([
          runtime.command(accountId, 'a', command(), () => undefined),
          runtime.command(other, 'b', command(), () => undefined),
        ]);
        expect(results.map((r) => r.ok)).toEqual([true, false]);
        expect(world.getSnapshot().items).toEqual([]);
        let release!: () => void;
        const gate = {
          promise: new Promise<void>((resolve) => {
            release = resolve;
          }),
          resolve: () => release(),
        };
        const original = runtime.store.operation.bind(runtime.store);
        vi.spyOn(runtime.store, 'operation').mockImplementationOnce(async (...args) => {
          await gate.promise;
          return original(...args);
        });
        const placing = runtime.command(
          accountId,
          'a',
          {
            operationId: randomUUID(),
            worldEpoch: runtime.store.epoch,
            action: { kind: 'place', itemId: item.entityId, pose: definition.initialItems[0] },
          },
          () => undefined,
        );
        expect(runtime.paused).toBe(true);
        expect(world.getSnapshot().items).toEqual([]);
        gate.resolve();
        expect((await placing).ok).toBe(true);
        expect(world.getSnapshot().items[0].entityId).toBe(item.entityId);
        expect(runtime.paused).toBe(false);
      } finally {
        await runtime.close();
        world.dispose();
      }
    });

    it('I14/I16: pauses failed writes, retains later motion, recovers and flushes before shutdown', async () => {
      const world = await createAuthoritativeWorld({ ...definition, initialItems: [] });
      const runtime = new ItemRuntime(
        new ItemStore(fixture.pool, definition, randomUUID()),
        world,
        () => {},
      );
      await runtime.initialize();
      const original = runtime.store.save.bind(runtime.store);
      const spy = vi
        .spyOn(runtime.store, 'save')
        .mockRejectedValueOnce(new Error('connection interrupted'));
      try {
        for (let tick = 1; tick <= 60; tick++) {
          world.step();
          runtime.step(tick);
        }
        await vi.waitFor(() => expect(runtime.unavailable).toBe(true));
        expect(runtime.paused).toBe(true);
        spy.mockImplementation(original);
        await vi.waitFor(() => expect(runtime.unavailable).toBe(false), { timeout: 3000 });
        expect(runtime.paused).toBe(false);
        for (let tick = 61; tick <= 70; tick++) {
          world.step();
          runtime.step(tick);
        }
        const final = world.getSnapshot().items;
        await runtime.close();
        const reopened = new ItemStore(fixture.pool, definition, randomUUID());
        stores.push(reopened);
        expect(await reopened.initialize()).toEqual(JSON.parse(JSON.stringify(final)));
      } finally {
        spy.mockRestore();
        await runtime.store.close();
        world.dispose();
      }
    });

    it('enforces exclusive location in SQL and checks ownership of slots', async () => {
      const [item] = await open();
      await expect(
        fixture.pool.query('UPDATE item_instances SET physical=NULL WHERE id=$1', [item.entityId]),
      ).rejects.toThrow('check constraint');
      await operation({ kind: 'pickup', itemId: item.entityId });
      const other = randomUUID();
      await fixture.pool.query('INSERT INTO accounts(id) VALUES($1)', [other]);
      const result = await store.operation(
        other,
        randomUUID(),
        { kind: 'place', itemId: item.entityId, pose: definition.initialItems[0] },
        () => undefined,
      );
      expect(result.code).toBe('ITEM_UNAVAILABLE');
      expect((await store.inventory(other)).slots).toEqual([]);
    });

    it('enforces compatible stack contents and capacity in deferred SQL constraints', async () => {
      const seed = definition.initialItems[0];
      definition.initialItems.push({ ...seed, seedId: 'second' });
      const items = await open();
      for (const item of items) await operation({ kind: 'pickup', itemId: item.entityId });
      await expect(
        fixture.pool.query(
          'UPDATE item_instances SET properties=\'{"label":"different"}\' WHERE id=$1',
          [items[0].entityId],
        ),
      ).rejects.toThrow('Invalid inventory stack');
      await expect(fixture.pool.query('UPDATE item_types SET max_stack=1')).rejects.toThrow(
        'Invalid inventory stack',
      );
      await expect(
        fixture.pool.query('INSERT INTO inventory_slots(id,account_id,position) VALUES($1,$2,99)', [
          randomUUID(),
          accountId,
        ]),
      ).rejects.toThrow('Invalid inventory stack');
    });

    it('resolves an uncertain committed transfer even if its actor has disconnected', async () => {
      const world = await createAuthoritativeWorld({ ...definition, initialItems: [] });
      const runtime = new ItemRuntime(
        new ItemStore(fixture.pool, definition, randomUUID()),
        world,
        () => {},
      );
      await runtime.initialize();
      world.addPlayer('a');
      const item = world.getSnapshot().items[0],
        original = runtime.store.operation.bind(runtime.store);
      const spy = vi.spyOn(runtime.store, 'operation').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('Lost COMMIT response');
      });
      let connected = true;
      try {
        const result = runtime.command(
          accountId,
          'a',
          {
            operationId: randomUUID(),
            worldEpoch: runtime.store.epoch,
            action: { kind: 'pickup', itemId: item.entityId },
          },
          () => (connected ? undefined : 'WORLD_NOT_READY'),
        );
        await vi.waitFor(() => expect(runtime.unavailable).toBe(true));
        connected = false;
        world.removePlayer('a');
        spy.mockImplementation(original);
        expect((await result).ok).toBe(true);
        await vi.waitFor(() => expect(runtime.unavailable).toBe(false));
        expect(world.getSnapshot().items).toEqual([]);
        expect((await runtime.inventory(accountId)).slots[0].items[0].itemId).toBe(item.entityId);
      } finally {
        spy.mockRestore();
        await runtime.close();
        world.dispose();
      }
    });

    it('keeps stepping physics while a background snapshot is in flight and flushes subsequent motion', async () => {
      definition.initialItems[0].position.y = 4;
      const world = await createAuthoritativeWorld({ ...definition, initialItems: [] });
      const runtime = new ItemRuntime(
        new ItemStore(fixture.pool, definition, randomUUID()),
        world,
        () => {},
      );
      await runtime.initialize();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = runtime.store.save.bind(runtime.store);
      const spy = vi.spyOn(runtime.store, 'save').mockImplementationOnce(async (...args) => {
        await gate;
        return original(...args);
      });
      try {
        for (let tick = 1; tick <= 60; tick++) {
          world.step();
          runtime.step(tick);
        }
        const before = world.getSnapshot().items[0].position.y;
        expect(runtime.paused).toBe(false);
        for (let tick = 61; tick <= 70; tick++) {
          world.step();
          runtime.step(tick);
        }
        expect(world.getSnapshot().items[0].position.y).not.toBe(before);
        const final = world.getSnapshot().items;
        release();
        await runtime.close();
        const reopened = new ItemStore(fixture.pool, definition, randomUUID());
        stores.push(reopened);
        expect(await reopened.initialize()).toEqual(JSON.parse(JSON.stringify(final)));
      } finally {
        release();
        spy.mockRestore();
        await runtime.store.close();
        world.dispose();
      }
    });

    it('recovers two terminated writer connections and saves motion between recoveries', async () => {
      definition.initialItems[0].position.y = 8;
      const world = await createAuthoritativeWorld({ ...definition, initialItems: [] });
      const runtime = new ItemRuntime(
        new ItemStore(fixture.pool, definition, randomUUID()),
        world,
        () => {},
      );
      await runtime.initialize();
      const terminate = () =>
        fixture.pool.query(
          `WITH key AS (SELECT hashtextextended(current_database() || ':' || current_schema() || ':' || $1,193708) AS value)
        SELECT pg_terminate_backend(l.pid) AS killed FROM pg_locks l,key WHERE l.locktype='advisory' AND l.granted
          AND l.classid::bigint=((key.value >> 32) & 4294967295) AND l.objid::bigint=(key.value & 4294967295)`,
          [definition.worldId],
        );
      try {
        expect((await terminate()).rows).toEqual([{ killed: true }]);
        for (let tick = 1; tick <= 60; tick++) {
          world.step();
          runtime.step(tick);
        }
        await vi.waitFor(() => expect(runtime.unavailable).toBe(true));
        expect(runtime.paused).toBe(true);
        await vi.waitFor(() => expect(runtime.unavailable).toBe(false), { timeout: 4000 });
        const first = await runtime.store.worldItems();
        for (let tick = 61; tick <= 65; tick++) {
          world.step();
          runtime.step(tick);
        }
        const second = world.getSnapshot().items;
        expect(second[0].position).not.toEqual(first[0].position);
        expect((await terminate()).rows).toEqual([{ killed: true }]);
        await vi.waitFor(() => expect(runtime.unavailable).toBe(true));
        await vi.waitFor(() => expect(runtime.unavailable).toBe(false), { timeout: 4000 });
        expect(await runtime.store.worldItems()).toEqual(JSON.parse(JSON.stringify(second)));
      } finally {
        await runtime.close();
        world.dispose();
      }
    });
  },
);
