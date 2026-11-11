import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemStore, worldCompatibility } from '../../apps/server/src/items/store.js';
import { physicsFixture } from '../../packages/simulation/src/test-fixture.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('offline world geometry migration', () => {
  let fixture: Awaited<ReturnType<typeof createDatabaseFixture>>;
  let definition: ReturnType<typeof physicsFixture>;
  let accountId: string;
  const stores: ItemStore[] = [];
  beforeEach(async () => {
    fixture = await createDatabaseFixture();
    definition = physicsFixture();
    accountId = randomUUID();
    await fixture.pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  });
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    await fixture?.close();
  });
  function store() {
    const value = new ItemStore(fixture.pool, definition, randomUUID());
    stores.push(value);
    return value;
  }
  async function savedState() {
    return {
      worlds: (await fixture.pool.query('SELECT * FROM persistent_worlds ORDER BY id')).rows,
      items: (await fixture.pool.query('SELECT * FROM item_instances ORDER BY id')).rows,
      slots: (await fixture.pool.query('SELECT * FROM inventory_slots ORDER BY id')).rows,
      operations: (await fixture.pool.query('SELECT * FROM item_operations ORDER BY operation_id'))
        .rows,
      types: (await fixture.pool.query('SELECT * FROM item_types ORDER BY id')).rows,
    };
  }

  it('preserves item identities, poses, inventories and operations across a valid map upgrade', async () => {
    definition.initialItems.push({
      ...structuredClone(definition.initialItems[0]),
      seedId: 'inventory-crate',
      position: { x: 2, y: 0.52, z: 6 },
    });
    const original = store();
    const items = await original.initialize();
    const inventoryItem = items[1];
    await original.operation(
      accountId,
      randomUUID(),
      { kind: 'pickup', itemId: inventoryItem.entityId },
      () => undefined,
    );
    await original.close();
    const before = await savedState();
    definition.entities[1].position.x += 1;
    const migration = store();
    const result = await migration.migrateGeometry();
    expect(result).toEqual({
      from: before.worlds[0].compatibility_hash,
      to: worldCompatibility(definition),
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
    expect(await store().initialize()).toEqual(
      items.filter((item) => item.entityId !== inventoryItem.entityId),
    );
  });

  it('keeps an empty world empty and its items in the inventory', async () => {
    const original = store();
    const [item] = await original.initialize();
    await original.operation(
      accountId,
      randomUUID(),
      { kind: 'pickup', itemId: item.entityId },
      () => undefined,
    );
    await original.close();
    const before = await savedState();
    definition.entities[1].position.x += 1;
    const migration = store();
    await migration.migrateGeometry();
    await migration.close();
    const reopened = store();
    expect(await reopened.initialize()).toEqual([]);
    expect((await savedState()).items).toEqual(before.items);
    expect((await reopened.inventory(accountId)).slots[0].items[0].itemId).toBe(item.entityId);
  });

  it('refuses a running owner and leaves all saved data unchanged', async () => {
    await store().initialize();
    const before = await savedState();
    definition.entities[1].position.x += 1;
    await expect(store().migrateGeometry()).rejects.toThrow('owner');
    expect(await savedState()).toEqual(before);
  });

  it('rejects an item obstructed by the new map without updating any saved data', async () => {
    const original = store();
    await original.initialize();
    await original.close();
    const before = await savedState();
    definition.entities[1].position = { x: 0, y: 1.5, z: 6 };
    await expect(store().migrateGeometry()).rejects.toThrow('BLOCKED');
    expect(await savedState()).toEqual(before);
  });

  it('rejects physical type changes even when the affected item is in an inventory', async () => {
    const original = store();
    const [item] = await original.initialize();
    await original.operation(
      accountId,
      randomUUID(),
      { kind: 'pickup', itemId: item.entityId },
      () => undefined,
    );
    await original.close();
    const before = await savedState();
    definition.entities[1].position.x += 1;
    definition.itemCatalog.types[item.typeId].mass += 1;
    await expect(store().migrateGeometry()).rejects.toThrow('Saved item type is incompatible');
    expect(await savedState()).toEqual(before);
  });
});
