import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, createWorldLayoutPatch } from '../../packages/contracts/src/index.js';
import {
  hash,
  writeAuthoringMetadata,
  writeWorldPublication,
} from '../../packages/world-release/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { prepareLayoutWorld } from '../../apps/server/src/layout/prepare.js';
import { applyStaticLayoutPatch } from '../../apps/server/src/layout/patch.js';
import {
  createLayoutPublication,
  readAuthoringRelease,
  type AuthoringRelease,
} from '../../apps/server/src/layout/release.js';
import {
  applyTerrainMigration,
  planTerrainMigration,
  TerrainMigrationOutcomeUnknownError,
  type TerrainMigrationOptions,
  type TerrainMigrationPrepare,
} from '../../apps/server/src/layout/terrain-migration.js';
import { ItemStore } from '../../apps/server/src/items/store.js';
import { WorldOwnership } from '../../apps/server/src/world-ownership.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';

const prepare: TerrainMigrationPrepare = async (context) => {
  const targetSnapshot = structuredClone(context.sourceSnapshot);
  targetSnapshot.assetReleaseVersion = context.targetRelease.metadata.assetReleaseVersion;
  for (const instance of targetSnapshot.instances) instance.position.y += 1;
  const targetItems = structuredClone(context.sourceItems);
  for (const item of targetItems) {
    item.position.y += 2;
    item.safePose.position.y += 1;
  }
  return {
    targetSnapshot,
    targetItems,
    audit: { fixture: 'separate-current-and-safe-height' },
    issues: [],
  };
};

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'offline terrain height migration coordinator',
  () => {
    let temporary: string, source: AuthoringRelease, target: AuthoringRelease;
    let database: Awaited<ReturnType<typeof createDatabaseFixture>>;
    let accountId: string;
    const owners: WorldOwnership[] = [];
    function options(extra: Partial<TerrainMigrationOptions> = {}): TerrainMigrationOptions {
      const ownership = new WorldOwnership(database.pool, source.definition.worldId, randomUUID());
      owners.push(ownership);
      return {
        sourceDirectory: source.directory,
        targetDirectory: target.directory,
        ownership,
        algorithmVersion: 'terrain-migration-fixture/1',
        rulesHash: hash('fixture rules'),
        prepare,
        ...extra,
      };
    }
    async function state() {
      const result: Record<string, unknown[]> = {};
      for (const [table, order] of [
        ['persistent_worlds', 'id'],
        ['world_layouts', 'world_id'],
        ['world_static_instances', 'entity_id'],
        ['world_static_operations', 'operation_id,entity_id'],
        ['item_instances', 'id'],
        ['inventory_slots', 'id'],
        ['item_types', 'id'],
        ['item_operations', 'operation_id'],
        ['accounts', 'id'],
      ])
        result[table] = (
          await database.pool.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY ${order}`)
        ).rows.map((row) => row.value);
      return result;
    }

    beforeAll(async () => {
      temporary = await mkdtemp(join(tmpdir(), 'su-terrain-migration-'));
      await buildWorld('content/worlds/physics-lab/world.json', join(temporary, 'source'));
      source = await readAuthoringRelease(join(temporary, 'source'));
      const raised = structuredClone(source.definition);
      for (const entity of raised.entities) entity.position.y += 1;
      for (const spawn of raised.spawnPoints) spawn.y += 1;
      for (const item of raised.initialItems) item.position.y += 1;
      const snapshot = {
        formatVersion: 1 as const,
        worldId: raised.worldId,
        assetReleaseVersion: source.metadata.assetReleaseVersion,
        seedVersion: source.metadata.seedVersion,
        revision: 1,
        instances: source.seed.map((instance) => ({
          ...instance,
          position: { ...instance.position, y: instance.position.y + 1 },
        })),
      };
      const publication = await createLayoutPublication(
        { ...source, definition: raised },
        snapshot,
      );
      await writeWorldPublication(publication.publication, join(temporary, 'target'));
      await writeAuthoringMetadata(
        publication.world,
        publication.publication.manifest,
        source.metadata.fixedInstanceIds,
        join(temporary, 'target'),
      );
      target = await readAuthoringRelease(join(temporary, 'target'));
    });
    afterAll(async () => {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    });
    beforeEach(async () => {
      database = await createDatabaseFixture();
      accountId = randomUUID();
      await database.pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
      const { ownership } = options();
      const prepared = await prepareLayoutWorld(source.directory, ownership);
      const [item] = await prepared.items.initialize();
      item.position.y = 3.52;
      item.velocity = { x: 0.1, y: -0.2, z: 0.05 };
      item.angularVelocity = { x: 0, y: 0.3, z: 0 };
      await prepared.items.save([item], 17);
      await prepared.items.operation(
        accountId,
        randomUUID(),
        { kind: 'give', typeId: 'wooden-crate' },
        () => undefined,
      );
      const next = structuredClone(prepared.snapshot);
      const removed = next.instances.find((instance) => instance.entityId === 'building-b')!;
      next.instances = next.instances.filter((instance) => instance.entityId !== removed.entityId);
      next.instances.push({
        ...removed,
        entityId: 'placed_12345678-1234-1234-1234-123456789abc',
        enabled: false,
      });
      next.instances.find((instance) => instance.entityId === 'building-a')!.position.y += 0.25;
      await ownership.close();
      const editor = options().ownership;
      await applyStaticLayoutPatch(
        source.directory,
        editor,
        createWorldLayoutPatch(prepared.snapshot, next),
      );
      await editor.close();
    });
    afterEach(async () => {
      for (const ownership of owners.splice(0)) await ownership.close();
      await database?.close();
    });

    it('plans without writes and atomically moves actual saved owners/items while preserving inventory and identities', async () => {
      const settings = options(),
        before = await state();
      const files = await readdir(target.directory);
      const plan = await planTerrainMigration(settings);
      expect(plan.status).toBe('valid');
      expect(plan.issues).toEqual([]);
      expect(await state()).toEqual(before);
      expect(await readdir(target.directory)).toEqual(files);
      expect(plan.before.snapshot.instances.map((instance) => instance.entityId)).toEqual([
        'building-a',
        'placed_12345678-1234-1234-1234-123456789abc',
      ]);
      expect(plan.before.snapshot.instances[0].position.y).toBe(0.25);
      expect(plan.after.snapshot.instances[0].position.y).toBe(1.25);
      expect(plan.after.items[0].position.y).toBe(5.52);
      expect(plan.after.items[0].safePose.position.y).toBe(1.52);
      const result = await applyTerrainMigration(settings, JSON.parse(JSON.stringify(plan)));
      expect(result.alreadyApplied).toBe(false);
      const after = await state();
      for (const table of ['accounts', 'inventory_slots', 'item_types', 'item_operations'])
        expect(after[table]).toEqual(before[table]);
      const beforeRows = before.item_instances as Record<string, any>[];
      const afterRows = after.item_instances as Record<string, any>[];
      expect(afterRows.filter((row) => row.world_id === null)).toEqual(
        beforeRows.filter((row) => row.world_id === null),
      );
      const oldWorld = beforeRows.find((row) => row.world_id !== null)!,
        newWorld = afterRows.find((row) => row.world_id !== null)!;
      expect(newWorld).toEqual({
        ...oldWorld,
        physical: plan.after.items[0],
        placement_version: oldWorld.placement_version + 1,
        snapshot_epoch: settings.ownership.epoch,
        snapshot_sequence: -1,
      });
      expect(
        (after.world_static_instances as Record<string, any>[]).map((row) => row.entity_id),
      ).toEqual(plan.after.snapshot.instances.map((instance) => instance.entityId));
      expect(
        (after.world_static_operations as Record<string, any>[]).filter(
          (row) => row.entity_id === '__terrain-migration',
        ),
      ).toHaveLength(1);
      await settings.ownership.close();
      const restart = options().ownership;
      const reopened = await prepareLayoutWorld(target.directory, restart);
      expect(await reopened.items.initialize()).toEqual(plan.after.items);
      expect(reopened.snapshot).toEqual(plan.after.snapshot);
    });

    it('replays from a durable marker without recalculation or a second height shift, including after restart', async () => {
      const settings = options(),
        plan = await planTerrainMigration(settings);
      await applyTerrainMigration(settings, plan);
      const before = await state();
      const forbidden = vi
        .fn<TerrainMigrationPrepare>()
        .mockRejectedValue(new Error('must not recalculate'));
      const replay = await applyTerrainMigration({ ...settings, prepare: forbidden }, plan);
      expect(replay.alreadyApplied).toBe(true);
      expect(replay.currentStateMatches).toBe(true);
      expect(forbidden).not.toHaveBeenCalled();
      expect(await state()).toEqual(before);
      await settings.ownership.close();
      const restart = options().ownership;
      const reopened = await prepareLayoutWorld(target.directory, restart);
      await reopened.items.initialize();
      await restart.close();
      const afterRestart = await state();
      const again = await applyTerrainMigration(options({ prepare: forbidden }), plan);
      expect(again.alreadyApplied).toBe(true);
      expect(again.currentStateMatches).toBe(false); // The runtime has advanced the epoch.
      expect(await state()).toEqual(afterRestart);
    });

    it('reports an unknown outcome when COMMIT succeeded but its reply was lost, then replays without another shift', async () => {
      const settings = options(),
        plan = await planTerrainMigration(settings);
      const db = settings.ownership.db,
        query = db.query.bind(db);
      const connectionError = Object.assign(new Error('Connection terminated after COMMIT'), {
        code: 'ECONNRESET',
      });
      const intercepted = vi.spyOn(db, 'query').mockImplementation((async (...args: any[]) => {
        const result = await (query as (...args: any[]) => Promise<unknown>)(...args);
        if (args[0] === 'COMMIT') throw connectionError;
        return result;
      }) as typeof db.query);
      let failure: unknown;
      try {
        await applyTerrainMigration(settings, plan);
      } catch (error) {
        failure = error;
      } finally {
        intercepted.mockRestore();
      }
      expect(failure).toBeInstanceOf(TerrainMigrationOutcomeUnknownError);
      expect(failure).toMatchObject({
        status: 'outcome-unknown',
        planHash: plan.planHash,
        cause: connectionError,
      });
      const committed = await state();
      const markers = (committed.world_static_operations as Record<string, any>[]).filter(
        (row) => row.entity_id === '__terrain-migration',
      );
      expect(markers).toHaveLength(1);
      expect(markers[0].operation_id).toBe(
        (failure as TerrainMigrationOutcomeUnknownError).operationId,
      );
      expect(markers[0].after_state.planHash).toBe(plan.planHash);
      expect(
        (committed.item_instances as Record<string, any>[])
          .filter((row) => row.world_id === plan.worldId)
          .map((row) => row.physical),
      ).toEqual(plan.after.items);
      await settings.ownership.close();
      const forbidden = vi
        .fn<TerrainMigrationPrepare>()
        .mockRejectedValue(new Error('must not recalculate'));
      const replay = await applyTerrainMigration(options({ prepare: forbidden }), plan);
      expect(replay).toMatchObject({
        operationId: markers[0].operation_id,
        alreadyApplied: true,
        currentStateMatches: true,
      });
      expect(forbidden).not.toHaveBeenCalled();
      expect(await state()).toEqual(committed);
    });

    it.each(['item', 'layout', 'inventory'])(
      'rejects a stale %s snapshot before mutation',
      async (changed) => {
        const settings = options(),
          plan = await planTerrainMigration(settings);
        if (changed === 'item')
          await database.pool.query(
            "UPDATE item_instances SET physical=jsonb_set(physical,'{position,y}','4.52') WHERE world_id IS NOT NULL",
          );
        else if (changed === 'layout')
          await settings.ownership.db.query(
            "UPDATE world_static_instances SET enabled=NOT enabled WHERE entity_id LIKE 'placed_%'",
          );
        else
          await database.pool.query(
            "UPDATE item_instances SET properties='{" +
              '"changed":true' +
              "}' WHERE world_id IS NULL",
          );
        const before = await state();
        await expect(applyTerrainMigration(settings, plan)).rejects.toThrow(
          'saved state changed since planning',
        );
        expect(await state()).toEqual(before);
      },
    );

    it('rejects altered plan/rules and a changed target release', async () => {
      const settings = options(),
        plan = await planTerrainMigration(settings),
        before = await state();
      const modified = structuredClone(plan);
      modified.after.items[0].position.y += 1;
      await expect(applyTerrainMigration(settings, modified)).rejects.toThrow(
        'intact, matching valid plan',
      );
      await expect(
        applyTerrainMigration({ ...settings, rulesHash: hash('changed') }, plan),
      ).rejects.toThrow('intact, matching valid plan');
      await expect(
        applyTerrainMigration(
          { ...settings, sourceDirectory: target.directory, targetDirectory: source.directory },
          plan,
        ),
      ).rejects.toThrow('release changed since planning');
      expect(await state()).toEqual(before);
    });

    it('rejects planner identity changes, explicit unresolved cases, and invalid target safePose', async () => {
      const settings = options(),
        before = await state();
      await expect(
        planTerrainMigration({
          ...settings,
          prepare: async (context) => {
            const result = await prepare(context);
            result.targetSnapshot.instances[0].position.x += 1;
            return result;
          },
        }),
      ).rejects.toThrow('more than static height');
      const unresolved = await planTerrainMigration({
        ...settings,
        prepare: async (context) => ({
          ...(await prepare(context)),
          issues: [{ kind: 'support', message: 'ambiguous support' }],
        }),
      });
      expect(unresolved.status).toBe('rejected');
      await expect(applyTerrainMigration(settings, unresolved)).rejects.toThrow(
        'intact, matching valid plan',
      );
      const collision = await planTerrainMigration({
        ...settings,
        prepare: async (context) => {
          const result = await prepare(context);
          result.targetItems[0].safePose.position.y = 0.52; // Buried inside the new ground.
          return result;
        },
      });
      expect(collision.status).toBe('rejected');
      expect(collision.issues).toContainEqual(expect.objectContaining({ kind: 'item-pose' }));
      expect(await state()).toEqual(before);
    });

    it('rolls back layout, items, compatibility and history if the item update fails', async () => {
      const settings = options(),
        plan = await planTerrainMigration(settings);
      await database.pool
        .query(`CREATE FUNCTION reject_terrain_item() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected item failure'; END $$;
      CREATE TRIGGER reject_terrain_item BEFORE UPDATE ON item_instances FOR EACH ROW EXECUTE FUNCTION reject_terrain_item()`);
      const before = await state();
      await expect(applyTerrainMigration(settings, plan)).rejects.toThrow('injected item failure');
      expect(await state()).toEqual(before);
    });

    it('rolls back if immutable publication cannot be written', async () => {
      const blocked = join(temporary, `blocked-${randomUUID()}`);
      await cp(target.directory, blocked, { recursive: true });
      await rm(join(blocked, 'layouts'), { recursive: true, force: true });
      await writeFile(join(blocked, 'layouts'), 'not a directory');
      const settings = options({ targetDirectory: blocked }),
        plan = await planTerrainMigration(settings),
        before = await state();
      await expect(applyTerrainMigration(settings, plan)).rejects.toThrow();
      expect(await state()).toEqual(before);
    });

    it('rolls back a deferred commit failure after publication and can safely retry', async () => {
      const settings = options(),
        plan = await planTerrainMigration(settings);
      await database.pool
        .query(`CREATE FUNCTION reject_terrain_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.entity_id='__terrain-migration' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER reject_terrain_commit AFTER INSERT ON world_static_operations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_terrain_commit()`);
      const before = await state();
      await expect(applyTerrainMigration(settings, plan)).rejects.toMatchObject({
        message: 'injected commit failure',
        code: 'P0001',
      });
      expect(await state()).toEqual(before);
      expect(
        await readdir(
          resolve(
            target.directory,
            'layouts',
            target.metadata.assetReleaseVersion,
            plan.targetLayoutHash!,
          ),
        ),
      ).toContain('manifest.json');
      await database.pool.query(
        'DROP TRIGGER reject_terrain_commit ON world_static_operations; DROP FUNCTION reject_terrain_commit()',
      );
      expect((await applyTerrainMigration(settings, plan)).alreadyApplied).toBe(false);
    });

    it('fences an old physical snapshot by both placement version and world epoch', async () => {
      const settings = options(),
        plan = await planTerrainMigration(settings);
      const oldEpoch = (await database.pool.query('SELECT epoch FROM persistent_worlds')).rows[0]
        .epoch;
      await applyTerrainMigration(settings, plan);
      const before = await state();
      const oldStore = new ItemStore(
        database.pool,
        source.definition,
        oldEpoch,
        settings.ownership,
      );
      await oldStore.save(plan.before.items, 1000);
      const staleVersionWithCurrentEpoch = new ItemStore(
        database.pool,
        target.definition,
        settings.ownership.epoch,
        settings.ownership,
      );
      await staleVersionWithCurrentEpoch.save(plan.before.items, 1001);
      expect(await state()).toEqual(before);
    });

    it('binds recomputed output to the accepted plan even when rulesHash is accidentally reused', async () => {
      const settings = options(),
        plan = await planTerrainMigration(settings),
        before = await state();
      await expect(
        applyTerrainMigration(
          {
            ...settings,
            prepare: async (context) => {
              const result = await prepare(context);
              result.targetItems[0].position.y += 0.5;
              return result;
            },
          },
          plan,
        ),
      ).rejects.toThrow('recomputed migration differs');
      expect(canonicalJson(await state())).toBe(canonicalJson(before));
    });
  },
);
