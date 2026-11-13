import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ItemStore, worldCompatibility } from '../../apps/server/src/items/store.js';
import type { WorldDefinition } from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';
import { oldExtractionWorld, readRelease } from '../helpers/static-extraction.js';

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'saved items across static object extraction',
  () => {
    let directory: string;
    let oldDefinition: WorldDefinition;
    let newDefinition: WorldDefinition;
    let fixture: Awaited<ReturnType<typeof createDatabaseFixture>>;
    let accountId: string;
    const stores: ItemStore[] = [];

    beforeAll(async () => {
      // The old input is the independently recorded, pre-conversion release, including
      // its original compound detail models. The new input is the actual current map.
      oldDefinition = await oldExtractionWorld();
      directory = await mkdtemp(join(tmpdir(), 'su-extraction-migration-'));
      await buildWorld('content/worlds/ring-block/world.json', directory, {
        terrainRelease: false,
      });
      newDefinition = (await readRelease(directory)).world;
      expect(oldDefinition.buildings.filter((i) => i.entityId.startsWith('details-'))).toHaveLength(
        134,
      );
      expect(newDefinition.buildings.some((i) => i.entityId.startsWith('details-'))).toBe(false);
      expect(worldCompatibility(newDefinition)).not.toBe(worldCompatibility(oldDefinition));
      // An additional seed gives the offline owner an inventory item. Initial seeds
      // are deliberately excluded from compatibility and must not run again on reopen.
      for (const definition of [oldDefinition, newDefinition])
        definition.initialItems.push({
          ...structuredClone(definition.initialItems[0]),
          seedId: 'extraction-inventory-crate',
          position: { x: 12.5, y: 0.52, z: 9 },
        });
    }, 60_000);

    beforeEach(async () => {
      fixture = await createDatabaseFixture();
      accountId = randomUUID();
      await fixture.pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
    });

    afterEach(async () => {
      for (const value of stores.splice(0)) await value.close();
      await fixture?.close();
    });

    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    function store(definition: WorldDefinition) {
      const value = new ItemStore(fixture.pool, definition, randomUUID());
      stores.push(value);
      return value;
    }

    async function savedState() {
      return {
        accounts: (await fixture.pool.query('SELECT * FROM accounts ORDER BY id')).rows,
        worlds: (await fixture.pool.query('SELECT * FROM persistent_worlds ORDER BY id')).rows,
        items: (await fixture.pool.query('SELECT * FROM item_instances ORDER BY id')).rows,
        slots: (await fixture.pool.query('SELECT * FROM inventory_slots ORDER BY id')).rows,
        operations: (
          await fixture.pool.query('SELECT * FROM item_operations ORDER BY operation_id')
        ).rows,
        types: (await fixture.pool.query('SELECT * FROM item_types ORDER BY id')).rows,
        schema: (await fixture.pool.query('SELECT * FROM su_schema_migrations ORDER BY version'))
          .rows,
      };
    }

    it('requires migration and preserves poses, motion, inventory and operations from the old release', async () => {
      const original = store(oldDefinition);
      const items = await original.initialize();
      expect(items).toHaveLength(2);
      const inventoryItem = items.find((item) => item.position.x === 12.5)!;
      const airborne = items.find((item) => item.entityId !== inventoryItem.entityId)!;
      const operationId = randomUUID();
      const action = { kind: 'pickup' as const, itemId: inventoryItem.entityId };
      const pickup = await original.operation(accountId, operationId, action, () => undefined);
      expect(pickup.ok).toBe(true);
      const inventory = await original.inventory(accountId);
      expect(inventory.slots[0].items[0].itemId).toBe(inventoryItem.entityId);

      airborne.position = { ...airborne.position, y: 3.52 };
      airborne.rotation = { x: 0, y: Math.sin(0.1), z: 0, w: Math.cos(0.1) };
      airborne.velocity = { x: 0.2, y: 1, z: -0.1 };
      airborne.angularVelocity = { x: 0, y: 0.3, z: 0 };
      await original.save([airborne], 7);
      await original.close();
      const before = await savedState();
      expect(before.worlds[0].compatibility_hash).toBe(worldCompatibility(oldDefinition));

      const premature = store(newDefinition);
      await expect(premature.initialize()).rejects.toThrow('Saved world geometry is incompatible');
      await premature.close();
      expect(await savedState()).toEqual(before);

      const migration = store(newDefinition);
      const result = await migration.migrateGeometry();
      expect(result).toEqual({
        from: worldCompatibility(oldDefinition),
        to: worldCompatibility(newDefinition),
        changed: true,
      });
      expect(await savedState()).toEqual({
        ...before,
        worlds: [{ ...before.worlds[0], compatibility_hash: result.to }],
      });
      expect(await migration.migrateGeometry()).toEqual({
        from: result.to,
        to: result.to,
        changed: false,
      });
      await migration.close();

      const reopened = store(newDefinition);
      expect(await reopened.initialize()).toEqual([airborne]);
      expect(await reopened.inventory(accountId)).toEqual(inventory);
      expect(await reopened.operation(accountId, operationId, action, () => 'BLOCKED')).toEqual(
        pickup,
      );
      const after = await savedState();
      expect(after.items).toEqual(before.items);
      expect(after.slots).toEqual(before.slots);
      expect(after.operations).toEqual(before.operations);
    }, 60_000);

    it('rolls back migration of a saved item intersecting the preserved boundary wall', async () => {
      const original = store(oldDefinition);
      const [item] = await original.initialize();
      await original.close();
      const wall = oldDefinition.entities.find((entity) => entity.entityId === 'boundary-north')!;
      expect(newDefinition.entities.find((entity) => entity.entityId === wall.entityId)).toEqual(
        wall,
      );
      // Simulate invalid persisted data, without modifying either release's geometry.
      // The centre remains within world bounds but the crate overlaps the north wall.
      const invalidPosition = { x: wall.position.x, y: wall.position.y, z: wall.position.z + 0.5 };
      await fixture.pool.query(
        "UPDATE item_instances SET physical=jsonb_set(physical,'{position}',$2::jsonb) WHERE id=$1",
        [item.entityId, JSON.stringify(invalidPosition)],
      );
      const before = await savedState();
      await expect(store(newDefinition).migrateGeometry()).rejects.toThrow('BLOCKED');
      expect(await savedState()).toEqual(before);
      expect(before.worlds[0].compatibility_hash).toBe(worldCompatibility(oldDefinition));
    }, 60_000);
  },
);
