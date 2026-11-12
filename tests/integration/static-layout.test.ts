import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildingBounds,
  cellsIntersectingBounds,
  loadWorldCell,
} from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';
import { createGameServer } from '../../apps/server/src/index.js';
import { WorldOwnership } from '../../apps/server/src/world-ownership.js';
import { prepareLayoutWorld } from '../../apps/server/src/layout/prepare.js';
import { createLayoutPublication } from '../../apps/server/src/layout/release.js';
import { StaticLayoutStore } from '../../apps/server/src/layout/store.js';
import { migrateDatabase } from '../../apps/server/src/migrations.js';
import { ItemStore } from '../../apps/server/src/items/store.js';

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('database static placement', () => {
  let temporary: string, directory: string;
  let fixture: Awaited<ReturnType<typeof createDatabaseFixture>>;
  const owners: WorldOwnership[] = [];
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'su-static-layout-'));
    await cp('content', join(temporary, 'content'), { recursive: true });
    const catalogPath = join(temporary, 'content/buildings/catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    const descriptorPath = resolve(temporary, 'content/buildings', catalog.assets['house-a']);
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
    const unusedDirectory = join(temporary, 'content/buildings/spare-house');
    await cp(resolve(descriptorPath, '..'), unusedDirectory, { recursive: true });
    descriptor.assetId = 'spare-house';
    await writeFile(join(unusedDirectory, 'asset.json'), JSON.stringify(descriptor));
    catalog.assets['spare-house'] = 'spare-house/asset.json';
    await writeFile(catalogPath, JSON.stringify(catalog));
    const source = join(temporary, 'content/worlds/physics-lab/world.json');
    const authored = JSON.parse(await readFile(source, 'utf8'));
    authored.cellSize = 10;
    await writeFile(source, JSON.stringify(authored));
    directory = join(temporary, 'release');
    await buildWorld(source, directory);
  });
  afterAll(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  beforeEach(async () => {
    fixture = await createDatabaseFixture();
  });
  afterEach(async () => {
    for (const owner of owners.splice(0)) await owner.close();
    await fixture?.close();
  });
  async function prepared(allow = false) {
    const owner = new WorldOwnership(fixture.pool, 'physics-lab', randomUUID());
    owners.push(owner);
    return prepareLayoutWorld(directory, owner, allow);
  }
  async function rows() {
    return {
      worlds: (await fixture.pool.query('SELECT * FROM persistent_worlds ORDER BY id')).rows,
      items: (await fixture.pool.query('SELECT * FROM item_instances ORDER BY id')).rows,
      slots: (await fixture.pool.query('SELECT * FROM inventory_slots ORDER BY id')).rows,
      layouts: (await fixture.pool.query('SELECT * FROM world_layouts ORDER BY world_id')).rows,
      instances: (
        await fixture.pool.query('SELECT * FROM world_static_instances ORDER BY entity_id')
      ).rows,
      operations: (
        await fixture.pool.query(
          'SELECT * FROM world_static_operations ORDER BY entity_id,created_at',
        )
      ).rows,
    };
  }
  async function initialize() {
    const p = await prepared();
    await p.items.initialize();
    await p.items.close();
    return p;
  }

  it('initializes placement and items once; SQL revisions, auditing and intentionally empty worlds survive restart', async () => {
    const first = await initialize();
    const initial = await rows();
    expect(initial.instances).toHaveLength(2);
    expect(initial.operations).toHaveLength(2);
    expect(initial.layouts[0].validated_revision).toBe(initial.layouts[0].revision);
    await fixture.pool.query(
      "UPDATE world_static_instances SET enabled=false WHERE entity_id='building-a'",
    );
    const changed = await rows();
    expect(changed.layouts[0].validated_hash).toBeNull();
    expect(changed.instances[0].instance_revision).toBe(2);
    expect(changed.operations.find((operation) => operation.before_state !== null)?.source).toBe(
      'sql',
    );
    const second = await prepared();
    expect(second.definition.buildings.map((i) => i.entityId)).toEqual(['building-b']);
    await expect(second.items.initialize()).rejects.toThrow('Saved world geometry is incompatible');
    await second.items.migrateGeometry(second.commit);
    await second.items.initialize();
    await second.items.close();
    expect((await rows()).items).toEqual(initial.items);
    await fixture.pool.query('DELETE FROM world_static_instances');
    const empty = await prepared();
    await empty.items.migrateGeometry(empty.commit);
    await empty.items.initialize();
    await empty.items.close();
    expect(empty.definition.buildings).toHaveLength(0);
    const restart = await prepared();
    await restart.items.initialize();
    await restart.items.close();
    expect((await rows()).instances).toHaveLength(0);
    expect((await rows()).layouts[0].seed_version).toBe(first.release.metadata.seedVersion);
    expect((await rows()).items).toEqual(initial.items);
  });
  it('seeds an existing persistent world without recreating any dynamic item or inventory state', async () => {
    const first = await prepared();
    const legacy = new ItemStore(
      fixture.pool,
      first.definition,
      first.items.epoch,
      first.items.ownership,
    );
    await legacy.initialize();
    await legacy.close();
    const before = await rows();
    expect(before.layouts).toHaveLength(0);
    const migration = await prepared();
    await migration.items.migrateGeometry(migration.commit);
    await migration.items.close();
    const after = await rows();
    expect(after.items).toEqual(before.items);
    expect(after.slots).toEqual(before.slots);
    expect(after.worlds).toEqual(before.worlds);
    expect(after.instances).toHaveLength(2);
    const repeated = await prepared();
    await repeated.items.migrateGeometry(repeated.commit);
    await repeated.items.close();
    expect(await rows()).toEqual(after);
  });
  it('publishes SQL position and full rotation through exact memberships, dependencies, hashes and HTTP', async () => {
    const first = await initialize();
    await fixture.pool.query(
      "UPDATE world_static_instances SET position_x=11,position_z=-12,rotation_y=sin(0.35),rotation_w=cos(0.35) WHERE entity_id='building-a'",
    );
    const next = await prepared();
    const item = next.definition.buildings.find((i) => i.entityId === 'building-a')!;
    const expected = cellsIntersectingBounds(
      next.definition.bounds,
      next.manifest.grid,
      buildingBounds(item, next.manifest.assets[item.assetId].bounds),
    );
    const actual: string[] = [];
    for (const entry of next.manifest.cells) {
      const cell = await loadWorldCell(next.manifest, entry.cellId, (path) =>
        readFile(resolve(next.directory, path)),
      );
      if (cell.buildings.some((i) => i.entityId === item.entityId)) actual.push(entry.cellId);
      expect(entry.assetIds).toEqual([...new Set(cell.buildings.map((i) => i.assetId))].sort());
    }
    expect(actual.sort()).toEqual(expected.sort());
    expect(actual.length).toBeGreaterThan(1);
    const reordered = { ...next.snapshot, instances: [...next.snapshot.instances].reverse() };
    expect((await createLayoutPublication(next.release, reordered)).publication.manifest).toEqual(
      next.manifest,
    );
    expect(next.manifest.mapVersion).not.toBe(first.manifest.mapVersion);
    expect(
      next.manifest.cells.filter((entry, index) => entry.file === first.manifest.cells[index].file)
        .length,
    ).toBeGreaterThan(0);
    await next.items.migrateGeometry(next.commit);
    await next.items.close();
    const app = await createGameServer({ pool: fixture.pool, worldDirectory: directory, port: 0 });
    try {
      const info = await fetch(app.url + '/api/world').then((r) => r.json());
      const manifest = await fetch(app.url + info.manifestUrl).then((r) => r.json());
      expect(info.mapVersion).toBe(next.manifest.mapVersion);
      expect(manifest).toEqual(next.manifest);
      const cell = await fetch(
        app.url +
          info.manifestUrl.replace(
            'manifest.json',
            manifest.cells.find((c: any) => actual.includes(c.cellId)).file,
          ),
      ).then((r) => r.json());
      expect(cell.buildings.find((i: any) => i.entityId === item.entityId)).toEqual(item);
    } finally {
      await app.close();
    }
  });
  it('rejects SQL writes and another server while a world owner is running', async () => {
    await initialize();
    const p = await prepared();
    await p.items.initialize();
    await expect(
      fixture.pool.query('UPDATE world_static_instances SET position_x=position_x+1'),
    ).rejects.toThrow('Stop the world');
    const other = new WorldOwnership(fixture.pool, 'physics-lab', randomUUID());
    owners.push(other);
    await expect(other.connect()).rejects.toThrow('already has an owner');
    await p.items.close();
  });
  it('enforces finite coordinates, unit rotations, known models and fixed IDs in SQL', async () => {
    await initialize();
    const before = await rows();
    for (const sql of [
      "UPDATE world_static_instances SET position_x='NaN'::float8",
      "UPDATE world_static_instances SET position_y='Infinity'::float8",
      'UPDATE world_static_instances SET rotation_w=2',
      "UPDATE world_static_instances SET asset_id='missing-model'",
      "UPDATE world_static_instances SET entity_id='new-identity'",
      "INSERT INTO world_static_instances SELECT world_id,'ground-01',asset_id,position_x,position_y,position_z,rotation_x,rotation_y,rotation_z,rotation_w,1,true,NULL,now() FROM world_static_instances LIMIT 1",
    ])
      await expect(fixture.pool.query(sql)).rejects.toThrow();
    expect(await rows()).toEqual(before);
  });
  it('dry-run leaves rows unchanged and a conflicting saved item rolls back compatibility and validation metadata', async () => {
    const first = await initialize();
    await fixture.pool.query(
      "UPDATE world_static_instances SET position_x=0,position_z=0 WHERE entity_id='building-a'",
    );
    const before = await rows();
    await expect(prepared()).rejects.toThrow('Saved item');
    expect(await rows()).toEqual(before);
    for (const owner of owners.splice(0)) await owner.close();
    await fixture.pool.query(
      "UPDATE world_static_instances SET position_x=-8,position_z=-14 WHERE entity_id='building-a'",
    );
    const good = await prepared();
    const saved = await rows();
    await good.items.migrateGeometry(undefined, true);
    expect(await rows()).toEqual(saved);
    expect(good.manifest.simulationConfigHash).toBe(first.manifest.simulationConfigHash);
    await good.items.close();
  });
  it('rejects blocked spawns without writing a seed or compatibility hash', async () => {
    await initialize();
    await fixture.pool.query(
      "UPDATE world_static_instances SET position_x=-3,position_z=4 WHERE entity_id='building-a'",
    );
    const before = await rows();
    await expect(prepared()).rejects.toThrow('spawn point');
    expect(await rows()).toEqual(before);
  });
  it('requires explicit release migration without repeating the original seed', async () => {
    const initial = await initialize();
    await fixture.pool.query(
      "UPDATE world_layouts SET asset_release_version=repeat('a',64),validated_revision=NULL,validated_hash=NULL",
    );
    await expect(prepared()).rejects.toThrow('Asset release changed');
    for (const owner of owners.splice(0)) await owner.close();
    const migration = await prepared(true);
    await migration.items.migrateGeometry(migration.commit);
    await migration.items.close();
    const result = await rows();
    expect(result.instances).toHaveLength(2);
    expect(result.layouts[0].asset_release_version).toBe(
      initial.release.metadata.assetReleaseVersion,
    );
    const owner = new WorldOwnership(fixture.pool, 'physics-lab', randomUUID());
    owners.push(owner);
    await owner.connect();
    expect((await new StaticLayoutStore(owner, initial.release).readCandidate()).initialized).toBe(
      true,
    );
  });
  it('refuses the v3-to-v4 schema upgrade while an old world owner is active', async () => {
    const p = await prepared();
    const old = new ItemStore(fixture.pool, p.definition, p.items.epoch, p.items.ownership);
    await old.initialize();
    await fixture.pool
      .query(`DROP TABLE world_static_operations,world_static_instances,world_layouts;
      DROP FUNCTION world_static_before_change(),world_static_after_change(),world_layout_before_change(),su_finite(double precision);
      DELETE FROM su_schema_migrations WHERE version=4`);
    const before = (await fixture.pool.query('SELECT * FROM persistent_worlds')).rows;
    await expect(migrateDatabase(fixture.pool)).rejects.toThrow('Stop all persistent world owners');
    expect(
      (await fixture.pool.query("SELECT to_regclass('world_layouts') AS table_name")).rows[0]
        .table_name,
    ).toBeNull();
    expect((await fixture.pool.query('SELECT * FROM persistent_worlds')).rows).toEqual(before);
    await old.close();
    await migrateDatabase(fixture.pool);
    expect(
      (await fixture.pool.query('SELECT max(version) AS version FROM su_schema_migrations')).rows[0]
        .version,
    ).toBe(4);
  });
  it('publishes a catalog model without a seed instance and permits a new SQL placement after registration', async () => {
    const p = await initialize();
    expect(p.release.manifest.assets['spare-house']).toBeDefined();
    expect(p.release.seed.some((i) => i.assetId === 'spare-house')).toBe(false);
    await fixture.pool
      .query(`INSERT INTO world_static_instances(world_id,entity_id,asset_id,position_x,position_y,position_z,rotation_x,rotation_y,rotation_z,rotation_w)
      VALUES('physics-lab','spare-instance','spare-house',12,0,12,0,0,0,1)`);
    const next = await prepared();
    await next.items.migrateGeometry(next.commit);
    await next.items.close();
    expect(next.definition.buildings.find((i) => i.entityId === 'spare-instance')?.assetId).toBe(
      'spare-house',
    );
    expect((await rows()).instances).toHaveLength(3);
  });
});
