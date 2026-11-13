import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorldLayoutPatch,
  placedStaticInstance,
  type PlaceStaticRequest,
  type WorldLayoutSnapshot,
} from '../../packages/contracts/src/index.js';
import {
  staticAssetLibraryHash,
  staticAssetSourceHash,
  type StaticAssetRemapRules,
} from '../../packages/world-release/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { WorldOwnership } from '../../apps/server/src/world-ownership.js';
import { ItemStore, worldCompatibility } from '../../apps/server/src/items/store.js';
import { prepareLayoutWorld } from '../../apps/server/src/layout/prepare.js';
import { migrateStaticAssets } from '../../apps/server/src/layout/asset-remap.js';
import { applyStaticLayoutPatch } from '../../apps/server/src/layout/patch.js';
import {
  readAuthoringRelease,
  createLayoutPublication,
} from '../../apps/server/src/layout/release.js';
import { StaticLayoutStore } from '../../apps/server/src/layout/store.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('offline static asset catalog cutover', () => {
  let temporary: string, oldDirectory: string, newDirectory: string;
  let rules: StaticAssetRemapRules;
  let fixture: Awaited<ReturnType<typeof createDatabaseFixture>>;
  const owners: WorldOwnership[] = [];
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  const placement = (entityId: string, assetId: string, x: number, z: number) => ({
    entityId,
    assetId,
    position: { x, y: 0, z },
    rotation: identity,
    sourceRef: { provider: 'fixture', type: 'object', id: entityId },
  });
  async function json(path: string, value: unknown) {
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  }
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'su-asset-remap-'));
    const content = join(temporary, 'content');
    await cp('content/items', join(content, 'items'), { recursive: true });
    const source = join(content, 'worlds/physics-lab/world.json');
    const authored = JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8'));
    const dimensions: Record<string, [number, number, number]> = {
      'legacy-bench': [1.8, 0.8, 0.7],
      'bench-0152a250d22ef0a9': [1.8, 0.8, 0.7],
      'legacy-fence': [8.5, 1.6, 0.12],
      'fence-short': [0.5, 1.6, 0.12],
      'fence-long': [4, 1.6, 0.12],
    };
    for (const [assetId, size] of Object.entries(dimensions)) {
      const center = [0, size[1] / 2, 0];
      await json(join(content, 'buildings', assetId, 'asset.json'), {
        formatVersion: 1,
        assetId,
        metadata: {
          name: assetId.includes('bench') ? 'Тестовая скамейка' : 'Тестовая ограда',
          description: 'Модель для проверки переноса сохранённых размещений.',
          category: assetId.includes('bench') ? 'street-furniture' : 'barriers',
          tags: ['test'],
        },
        source: { kind: 'kit', file: 'source.json' },
      });
      await json(join(content, 'buildings', assetId, 'source.json'), {
        formatVersion: 1,
        parts: [
          {
            id: 'body',
            role: 'detail',
            fade: false,
            color: '#536653',
            shapes: [{ box: { center, size } }],
          },
        ],
        colliders: [{ id: 'body', center, size }],
      });
    }
    const catalog = async (ids: string[]) =>
      json(join(content, 'buildings/catalog.json'), {
        formatVersion: 1,
        assets: Object.fromEntries(ids.map((id) => [id, `${id}/asset.json`])),
      });
    const oldPlacements = [
      placement('bench-a', 'legacy-bench', -10, -12),
      placement('fence-a', 'legacy-fence', 4, -12),
      placement('fence-disabled', 'legacy-fence', 4, -9),
      placement('deleted-bench', 'legacy-bench', -10, -6),
    ];
    await json(source, authored);
    const cellPath = join(content, 'worlds/physics-lab/cells/0_0.json');
    await json(cellPath, {
      formatVersion: 2,
      cellId: '0_0',
      statics: [],
      buildings: oldPlacements,
    });
    await catalog(['legacy-bench', 'bench-0152a250d22ef0a9', 'legacy-fence']);
    oldDirectory = join(temporary, 'old-release');
    await buildWorld(source, oldDirectory);
    // The target seed deliberately differs. Existing layouts must never be replaced by it.
    await json(cellPath, {
      formatVersion: 2,
      cellId: '0_0',
      statics: [],
      buildings: [placement('target-seed-only', 'bench-0152a250d22ef0a9', 12, -14)],
    });
    await catalog(['bench-0152a250d22ef0a9', 'fence-short', 'fence-long']);
    newDirectory = join(temporary, 'new-release');
    await buildWorld(source, newDirectory);
    const oldRelease = await readAuthoringRelease(oldDirectory);
    const target = await readAuthoringRelease(newDirectory);
    rules = {
      formatVersion: 1,
      algorithmVersion: 'static-library-v1',
      worldId: 'physics-lab',
      sourceAssetReleaseVersion: oldRelease.metadata.assetReleaseVersion,
      targetAssetReleaseVersion: target.metadata.assetReleaseVersion,
      sourceDescriptionHash: '',
      targetLibraryHash: '',
      assetMap: {
        'legacy-bench': 'bench-0152a250d22ef0a9',
        'bench-0152a250d22ef0a9': 'bench-0152a250d22ef0a9',
      },
      fences: { 'legacy-fence': { length: 8.5, center: { x: 0, y: 0.8, z: 0 } } },
      fenceCenterOffsets: {},
      unchangedAssetIds: [],
      vegetation: {},
      sections: {
        short: { assetId: 'fence-short', length: 0.5 },
        long: { assetId: 'fence-long', length: 4 },
      },
      tolerances: { vegetationRelative: 0.1, fenceEndpoint: 0.125 },
    };
    rules.sourceDescriptionHash = staticAssetSourceHash(rules);
    rules.targetLibraryHash = staticAssetLibraryHash(rules, target.manifest.assets);
  }, 60_000);
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
  function owner() {
    const value = new WorldOwnership(fixture.pool, 'physics-lab', randomUUID());
    owners.push(value);
    return value;
  }
  async function rows(): Promise<Record<string, Record<string, unknown>[]>> {
    const tables = [
      'accounts',
      'persistent_worlds',
      'item_instances',
      'inventory_slots',
      'item_operations',
      'item_types',
      'world_layouts',
      'world_static_instances',
      'world_static_operations',
    ];
    return Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          (
            await fixture.pool.query<{ value: Record<string, unknown> }>(
              `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows.map((r) => r.value),
        ]),
      ),
    );
  }
  async function initialize() {
    const original = await prepareLayoutWorld(oldDirectory, owner());
    const items = await original.items.initialize();
    const accountId = randomUUID();
    await fixture.pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
    await original.items.operation(
      accountId,
      randomUUID(),
      { kind: 'pickup', itemId: items[0].entityId },
      () => undefined,
    );
    const request: PlaceStaticRequest = {
      operationId: randomUUID(),
      worldEpoch: original.items.epoch,
      assetReleaseVersion: original.snapshot.assetReleaseVersion,
      expectedLayoutRevision: original.snapshot.revision,
      position: { x: -10, z: -9 },
      yawStep: 1,
    };
    const publication = await createLayoutPublication(original.release, {
      ...original.snapshot,
      instances: [...original.snapshot.instances, placedStaticInstance(request)],
    });
    const game = new StaticLayoutStore(original.items.ownership, original.release);
    const gameRevision = await game.createGame(
      accountId,
      request,
      publication.hash,
      worldCompatibility(publication.world),
    );
    expect(gameRevision).toBeDefined();
    const gameResult = await game.replayGame(accountId, request);
    expect(gameResult).toMatchObject({ ok: true });
    await original.items.close();
    await fixture.pool.query(
      "UPDATE world_static_instances SET enabled=false WHERE entity_id='fence-disabled'",
    );
    await fixture.pool.query("DELETE FROM world_static_instances WHERE entity_id='deleted-bench'");
    return { original, accountId, request, gameResult };
  }
  async function migrate(
    options: Parameters<typeof migrateStaticAssets>[3] = {},
    input: unknown = rules,
  ) {
    const ownership = owner();
    try {
      return await migrateStaticAssets(newDirectory, ownership, input, options);
    } finally {
      await ownership.close();
    }
  }

  it('preserves the exact live snapshot and game history, splits disabled fences, audits once and survives restart and file patches', async () => {
    const { accountId, request, gameResult } = await initialize();
    const before = await rows();
    const preview = await migrate({ dryRun: true });
    expect(await rows()).toEqual(before);
    await expect(
      readFile(
        join(
          newDirectory,
          'layouts',
          rules.targetAssetReleaseVersion,
          preview.report.layoutHash,
          'manifest.json',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(preview.report.transformation.fences).toHaveLength(2);
    expect(preview.snapshot.instances).toHaveLength(8);
    expect(
      preview.snapshot.instances.some(
        (i) => i.entityId === 'target-seed-only' || i.entityId === 'deleted-bench',
      ),
    ).toBe(false);
    const result = await migrate({ plan: preview.report });
    const after = await rows();
    for (const table of [
      'accounts',
      'item_instances',
      'inventory_slots',
      'item_operations',
      'item_types',
    ])
      expect(after[table]).toEqual(before[table]);
    expect(after.world_layouts[0].seed_version).toBe(before.world_layouts[0].seed_version);
    expect(after.world_layouts[0].validated_revision).toBe(result.snapshot.revision);
    expect(result.snapshot.revision).toBeGreaterThan(preview.report.sourceRevision + 1);
    expect(result.snapshot.instances.filter((i) => !i.enabled)).toHaveLength(3);
    const benchBefore = preview.report.transformation.changes.find(
      (c) => c.after.entityId === 'bench-a',
    )!.before!;
    expect(result.snapshot.instances.find((i) => i.entityId === 'bench-a')).toMatchObject({
      ...benchBefore,
      assetId: 'bench-0152a250d22ef0a9',
      instanceRevision: benchBefore.instanceRevision + 1,
    });
    const audit = after.world_static_operations.filter(
      (o) => o.operation_id === result.operationId,
    );
    expect(audit).toHaveLength(8);
    expect(audit.every((o) => o.source === 'migration' && o.account_id === null)).toBe(true);
    expect(audit.find((o) => o.entity_id === '__asset-release')).toBeDefined();
    for (const previous of before.world_static_operations)
      expect(after.world_static_operations).toContainEqual(previous);
    const repeated = await migrate();
    expect(repeated.report.alreadyApplied).toBe(true);
    expect(await rows()).toEqual(after);
    const restarted = await prepareLayoutWorld(newDirectory, owner());
    expect(await restarted.items.initialize()).toEqual([]);
    expect((await restarted.items.inventory(accountId)).slots[0].items).toHaveLength(1);
    expect(restarted.snapshot).toEqual(result.snapshot);
    const game = new StaticLayoutStore(restarted.items.ownership, restarted.release);
    expect(await game.replayGame(accountId, request)).toEqual(gameResult);
    await createLayoutPublication(restarted.release, result.snapshot);
    await restarted.items.close();
    const edited = structuredClone(result.snapshot);
    edited.instances.find((i) => i.entityId === 'bench-a')!.position.x -= 0.25;
    const patchOwner = owner();
    const patched = await applyStaticLayoutPatch(
      newDirectory,
      patchOwner,
      createWorldLayoutPatch(result.snapshot, edited),
    );
    expect(patched.snapshot.instances.find((i) => i.entityId === 'bench-a')!.position.x).toBe(
      -10.25,
    );
    await patchOwner.close();
  });

  it('rejects a missing or stale accepted plan, wrong release, changed checksum and unmapped references without writes', async () => {
    await initialize();
    const preview = await migrate({ dryRun: true });
    const before = await rows();
    await expect(migrate()).rejects.toThrow('accepted dry-run');
    for (const [field, value, error] of [
      ['sourceAssetReleaseVersion', 'a'.repeat(64), 'source release'],
      ['targetAssetReleaseVersion', 'a'.repeat(64), 'target release'],
      ['targetLibraryHash', 'a'.repeat(64), 'library checksum'],
      ['sourceDescriptionHash', 'a'.repeat(64), 'source description checksum'],
    ])
      await expect(migrate({ dryRun: true }, { ...rules, [field]: value })).rejects.toThrow(error);
    expect(await rows()).toEqual(before);
    await fixture.pool.query(
      "UPDATE world_static_instances SET position_x=position_x+0.1 WHERE entity_id='bench-a'",
    );
    const changed = await rows();
    await expect(migrate({ plan: preview.report })).rejects.toThrow('accepted dry-run');
    expect(await rows()).toEqual(changed);
    const missing = structuredClone(rules);
    delete missing.assetMap['legacy-bench'];
    missing.sourceDescriptionHash = staticAssetSourceHash(missing);
    // The checksum changes too; preserve the target library identity by retaining the canonical bench mapping.
    await expect(migrate({ dryRun: true }, missing)).rejects.toThrow('unmapped source asset');
  });

  it('rolls back catalog, rows, trigger revisions, history and physics hash after a SQL write failure', async () => {
    await initialize();
    const preview = await migrate({ dryRun: true });
    await fixture.pool
      .query(`CREATE FUNCTION reject_remap_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.entity_id LIKE 'fence-v1-%' THEN RAISE EXCEPTION 'Injected remap failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_remap_test BEFORE INSERT ON world_static_instances FOR EACH ROW EXECUTE FUNCTION reject_remap_test()`);
    const before = await rows();
    await expect(migrate({ plan: preview.report })).rejects.toThrow('Injected remap failure');
    expect(await rows()).toEqual(before);
  });

  it('reports every unmapped reference, including disabled rows, without deleting any row', async () => {
    await initialize();
    await fixture.pool.query(
      "UPDATE world_layouts SET asset_ids=array_append(asset_ids,'missing-model')",
    );
    await fixture.pool.query(
      "UPDATE world_static_instances SET asset_id='missing-model' WHERE entity_id IN ('bench-a','fence-disabled')",
    );
    const before = await rows();
    await expect(migrate({ dryRun: true })).rejects.toMatchObject({
      report: {
        status: 'rejected',
        stage: 'references',
        issues: [
          { kind: 'unknown-reference', entityId: 'bench-a', assetId: 'missing-model' },
          { kind: 'unknown-reference', entityId: 'fence-disabled', assetId: 'missing-model' },
        ],
      },
    });
    expect(await rows()).toEqual(before);
  });

  it('reports all instances outside the new bounds, including every disabled fence section', async () => {
    await initialize();
    await fixture.pool.query(
      "UPDATE world_static_instances SET position_x=100 WHERE entity_id IN ('bench-a','fence-disabled')",
    );
    const before = await rows();
    try {
      await migrate({ dryRun: true });
      throw new Error('Expected a rejected migration');
    } catch (error) {
      expect(error).toMatchObject({ report: { status: 'rejected', stage: 'bounds' } });
      const issues = (error as { report: { issues: { kind: string }[] } }).report.issues;
      expect(issues).toHaveLength(4);
      expect(issues.every((issue) => issue.kind === 'outside-bounds')).toBe(true);
    }
    expect(await rows()).toEqual(before);
  });

  it('rolls back written rows if immutable resource publication fails', async () => {
    await initialize();
    const preview = await migrate({ dryRun: true });
    const layoutPath = join(
      newDirectory,
      'layouts',
      rules.targetAssetReleaseVersion,
      preview.report.layoutHash,
    );
    await mkdir(resolve(layoutPath, '..'), { recursive: true });
    await rm(layoutPath, { recursive: true, force: true });
    await writeFile(layoutPath, 'Injected I/O obstruction');
    const before = await rows();
    try {
      await expect(migrate({ plan: preview.report })).rejects.toThrow();
      expect(await rows()).toEqual(before);
    } finally {
      await rm(layoutPath, { recursive: true, force: true });
    }
  });

  it('preserves intentional empty layouts and never repeats the seed', async () => {
    await initialize();
    await fixture.pool.query('DELETE FROM world_static_instances');
    const preview = await migrate({ dryRun: true });
    expect(preview.snapshot.instances).toEqual([]);
    await migrate({ plan: preview.report });
    const restarted = await prepareLayoutWorld(newDirectory, owner());
    await restarted.items.initialize();
    expect(restarted.snapshot.instances).toEqual([]);
    await restarted.items.close();
  });

  it('leaves a fresh database unseeded, then initializes only the new seed exactly once', async () => {
    const before = await rows();
    const preview = await migrate({ dryRun: true });
    await migrate({ plan: preview.report });
    expect(await rows()).toEqual(before);
    const restarted = await prepareLayoutWorld(newDirectory, owner());
    await restarted.items.initialize();
    expect(restarted.snapshot.instances.map((i) => i.entityId)).toEqual(['target-seed-only']);
    await restarted.items.close();
  });

  it('initializes a legacy persistent world without layout from the new seed and preserves its saved items', async () => {
    const release = await readAuthoringRelease(newDirectory);
    const legacy = new ItemStore(fixture.pool, release.definition, randomUUID());
    await legacy.initialize();
    await legacy.close();
    const before = await rows();
    expect(before.world_layouts).toHaveLength(0);
    const preview = await migrate({ dryRun: true });
    await migrate({ plan: preview.report });
    const after = await rows();
    expect(after.item_instances).toEqual(before.item_instances);
    expect(after.world_static_instances).toHaveLength(1);
    expect(after.world_static_instances[0].entity_id).toBe('target-seed-only');
  });

  it('refuses a running owner and a saved item conflict before any placement write', async () => {
    const prepared = await prepareLayoutWorld(oldDirectory, owner());
    const items = await prepared.items.initialize();
    const before = await rows();
    await expect(migrate({ dryRun: true })).rejects.toThrow('already has an owner');
    expect(await rows()).toEqual(before);
    await prepared.items.close();
    const physical = { ...items[0], position: { x: -10, y: 0.52, z: -12 } };
    await fixture.pool.query('UPDATE item_instances SET physical=$2 WHERE id=$1', [
      items[0].entityId,
      physical,
    ]);
    const conflict = await rows();
    await expect(migrate({ dryRun: true })).rejects.toThrow('Saved item');
    expect(await rows()).toEqual(conflict);
  });

  it('runs dry-run, accepted apply, export and validation through the real CLI', async () => {
    await initialize();
    const cwd = await mkdtemp(join(temporary, 'cli-'));
    await mkdir(join(cwd, 'dist/worlds'), { recursive: true });
    await symlink(newDirectory, join(cwd, 'dist/worlds/physics-lab'));
    await json(join(cwd, 'rules.json'), rules);
    const database = new URL(process.env.SU_TEST_DATABASE_URL!);
    database.searchParams.set('options', `-c search_path=${fixture.schema}`);
    const cli = (command: string, args: string[]) =>
      promisify(execFile)(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), resolve(`apps/server/src/${command}.ts`), ...args],
        {
          cwd,
          env: { ...process.env, DATABASE_URL: database.toString(), SU_WORLD: 'physics-lab' },
          timeout: 20_000,
        },
      );
    const before = await rows();
    expect(
      (
        await cli('migrate-world', [
          '--',
          '--asset-remap',
          'rules.json',
          '--dry-run',
          '--report',
          'plan.json',
        ])
      ).stdout,
    ).toContain('Database and publication unchanged');
    expect(await rows()).toEqual(before);
    expect(
      (await cli('migrate-world', ['--asset-remap', 'rules.json', '--plan', 'plan.json'])).stdout,
    ).toContain('Applied asset remap');
    await cli('layout-command', ['export', '--file', 'after.json']);
    const exported: WorldLayoutSnapshot = JSON.parse(
      await readFile(join(cwd, 'after.json'), 'utf8'),
    );
    expect(exported.instances).toHaveLength(8);
    expect((await cli('layout-command', ['validate', '--file', 'after.json'])).stdout).toContain(
      'Valid layout',
    );
    const source = await readAuthoringRelease(newDirectory);
    const ownership = owner();
    await ownership.connect();
    expect((await new StaticLayoutStore(ownership, source).readCandidate()).snapshot).toEqual(
      exported,
    );
    await ownership.close();
    const migrated = await rows();
    await json(join(cwd, 'bad-rules.json'), { ...rules, targetLibraryHash: 'a'.repeat(64) });
    await expect(
      cli('migrate-world', [
        '--asset-remap',
        'bad-rules.json',
        '--dry-run',
        '--report',
        'rejected.json',
      ]),
    ).rejects.toThrow('library checksum');
    expect(JSON.parse(await readFile(join(cwd, 'rejected.json'), 'utf8'))).toMatchObject({
      status: 'rejected',
      stage: 'release',
      issues: [{ kind: 'release' }],
    });
    expect(await rows()).toEqual(migrated);
  });
});
