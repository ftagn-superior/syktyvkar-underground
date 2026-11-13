import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorldLayoutPatch } from '../../packages/contracts/src/index.js';
import {
  hash,
  jsonBytes,
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
import type { TerrainMigrationPlan } from '../../apps/server/src/layout/terrain-migration.js';
import type { TerrainPoseRules } from '../../apps/server/src/layout/terrain-poses.js';
import { WorldOwnership } from '../../apps/server/src/world-ownership.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';

const exec = promisify(execFile);
async function bundleCommand(outfile: string, loseCommitReply = false) {
  return build({
    entryPoints: ['apps/server/src/terrain-command.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
    banner: {
      js: "import { createRequire as createBundleRequire } from 'node:module'; const require = createBundleRequire(import.meta.url);",
    },
    plugins: loseCommitReply
      ? [
          {
            name: 'lose-committed-reply',
            setup(builder) {
              builder.onLoad({ filter: /[/\\]layout[/\\]terrain-migration\.ts$/ }, async (args) => {
                const contents = await readFile(args.path, 'utf8');
                const commit = "await db.query('COMMIT');";
                expect(contents.split(commit)).toHaveLength(2);
                return {
                  contents: contents.replace(
                    commit,
                    `${commit}\nthrow Object.assign(new Error('Connection terminated after COMMIT'), { code: 'ECONNRESET' });`,
                  ),
                  loader: 'ts',
                  resolveDir: dirname(args.path),
                };
              });
            },
          },
        ]
      : [],
  });
}
const rules: TerrainPoseRules = {
  formatVersion: 1,
  algorithmVersion: 'terrain-poses/1',
  sourceFlatGroundY: 0,
  sourceGroundIds: ['ground-01'],
  targetGroundIds: ['ground-01'],
  models: ['house-a', 'house-b'].map((assetId) => ({
    assetId,
    policy: {
      kind: 'ground-anchor',
      anchor: { x: 0, y: 0, z: 0 },
      contactRadius: 0.2,
      maximumTerrainReliefMetres: 0.1,
    },
  })),
};

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('standalone terrain migration command', () => {
  let temporary: string, binary: string, empty: string, rulesFile: string;
  let source: AuthoringRelease, target: AuthoringRelease;
  let database: Awaited<ReturnType<typeof createDatabaseFixture>>;
  let reportDirectory: string;
  async function owned<T>(run: (ownership: WorldOwnership) => Promise<T>) {
    const ownership = new WorldOwnership(database.pool, source.definition.worldId, randomUUID());
    try {
      return await run(ownership);
    } finally {
      await ownership.close();
    }
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
  async function files(directory: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      result[path.slice(directory.length)] = hash(await readFile(path));
    }
    return result;
  }
  async function command(
    kind: 'plan' | 'apply',
    report: string,
    plan?: string,
    extra: string[] = [],
    executable = binary,
  ) {
    const url = new URL(process.env.SU_TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    try {
      const result = await exec(
        process.execPath,
        [
          executable,
          kind,
          '--source',
          source.directory,
          '--target',
          target.directory,
          '--rules',
          rulesFile,
          '--report',
          report,
          ...(plan ? ['--plan', plan] : []),
          ...extra,
        ],
        {
          cwd: empty,
          env: {
            PATH: process.env.PATH,
            DATABASE_URL: url.toString(),
            SU_WORLD: source.definition.worldId,
          },
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      return { code: 0, ...result };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  }
  async function readPlan(path: string): Promise<TerrainMigrationPlan> {
    return JSON.parse(await readFile(path, 'utf8'));
  }

  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'su-terrain-command-'));
    empty = join(temporary, 'empty-cwd');
    const server = join(temporary, 'dist', 'server');
    await mkdir(empty);
    await mkdir(server, { recursive: true });
    binary = join(server, 'terrain-command.mjs');
    const bundle = await bundleCommand(binary);
    expect(
      Object.keys(bundle.metafile!.inputs).some((path) => /(?:^|\/)(tools|content)\//.test(path)),
    ).toBe(false);
    expect(
      Object.keys(bundle.metafile!.inputs).some((path) => path.endsWith('/terrain-item-poses.ts')),
    ).toBe(true);
    await copyFile(
      createRequire(new URL('../../packages/simulation/package.json', import.meta.url)).resolve(
        '@babylonjs/havok/lib/esm/HavokPhysics.wasm',
      ),
      join(server, 'HavokPhysics.wasm'),
    );
    await buildWorld('content/worlds/physics-lab/world.json', join(temporary, 'source'));
    source = await readAuthoringRelease(join(temporary, 'source'));
    const definition = structuredClone(source.definition);
    for (const entity of definition.entities) entity.position.y += 1;
    for (const spawn of definition.spawnPoints) spawn.y += 1;
    for (const item of definition.initialItems) item.position.y += 1;
    const snapshot = {
      formatVersion: 1 as const,
      worldId: definition.worldId,
      assetReleaseVersion: source.metadata.assetReleaseVersion,
      seedVersion: source.metadata.seedVersion,
      revision: 1,
      instances: source.seed.map((instance) => ({
        ...instance,
        position: { ...instance.position, y: instance.position.y + 1 },
      })),
    };
    const publication = await createLayoutPublication({ ...source, definition }, snapshot);
    const targetDirectory = join(temporary, 'target');
    await writeWorldPublication(publication.publication, targetDirectory);
    await writeAuthoringMetadata(
      publication.world,
      publication.publication.manifest,
      source.metadata.fixedInstanceIds,
      targetDirectory,
      jsonBytes({
        formatVersion: 2,
        generatorVersion: 'terrain-build/2',
        worldId: definition.worldId,
        grid: {
          formatVersion: 1,
          origin: { x: -20, z: -20 },
          spacing: 2,
          columns: 21,
          rows: 21,
          heights: Array(441).fill(1),
          bottom: -2,
        },
        supports: [],
      }),
    );
    target = await readAuthoringRelease(targetDirectory);
    rulesFile = join(temporary, 'rules.json');
    await writeFile(rulesFile, JSON.stringify(rules));
  });
  afterAll(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  beforeEach(async () => {
    database = await createDatabaseFixture();
    reportDirectory = join(temporary, `reports-${randomUUID()}`);
    await mkdir(reportDirectory);
    await owned(async (ownership) => {
      const prepared = await prepareLayoutWorld(source.directory, ownership);
      const [item] = await prepared.items.initialize();
      item.safePose.position = { x: 11, y: 1.82, z: 3 }; // A distinct static support.
      await prepared.items.save([item], 11);
      const accountId = randomUUID();
      await database.pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
      await prepared.items.operation(
        accountId,
        randomUUID(),
        { kind: 'give', typeId: 'wooden-crate' },
        () => undefined,
      );
      const next = structuredClone(prepared.snapshot);
      next.instances[0].position.y = 0.125;
      next.instances[1].enabled = false;
      await applyStaticLayoutPatch(
        source.directory,
        ownership,
        createWorldLayoutPatch(prepared.snapshot, next),
      );
    });
  });
  afterEach(async () => {
    await database?.close();
  });

  it('runs actual geometry plan/apply/replay outside the checkout with only bundle, WASM and explicit releases', async () => {
    expect(await readdir(empty)).toEqual([]);
    const planFile = join(reportDirectory, 'plan.json'),
      before = await state();
    const sourceFiles = await files(source.directory),
      targetFiles = await files(target.directory);
    const planning = await command('plan', planFile);
    expect(planning, planning.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(planning.stdout)).toMatchObject({
      status: 'valid',
      databaseChanged: false,
      publicationWritten: false,
    });
    const plan = await readPlan(planFile);
    expect(plan.status).toBe('valid');
    expect(await state()).toEqual(before);
    expect(await files(source.directory)).toEqual(sourceFiles);
    expect(await files(target.directory)).toEqual(targetFiles);
    expect(plan.after.snapshot.instances[0].position.y).toBe(1.125);
    expect(plan.after.snapshot.instances[1].enabled).toBe(false);
    expect(plan.after.items[0].position.y).toBeCloseTo(1.52, 5);
    expect(plan.after.items[0].safePose.position.y).toBeCloseTo(2.82, 5);
    expect(
      (plan.audit as { items: { support: { kind: string } }[] }).items.map(
        (entry) => entry.support.kind,
      ),
    ).toEqual(['ground', 'static']);
    const applied = await command('apply', join(reportDirectory, 'applied.json'), planFile);
    expect(applied, applied.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(applied.stdout)).toMatchObject({
      status: 'applied',
      planHash: plan.planHash,
    });
    const after = await state();
    for (const key of ['inventory_slots', 'item_types', 'item_operations', 'accounts'])
      expect(after[key]).toEqual(before[key]);
    const inventory = (value: Record<string, unknown[]>) =>
      (value.item_instances as { world_id: string | null }[]).filter(
        (item) => item.world_id === null,
      );
    expect(inventory(after)).toEqual(inventory(before));
    const replay = await command('apply', join(reportDirectory, 'replayed.json'), planFile);
    expect(replay, replay.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(replay.stdout)).toMatchObject({
      status: 'already-applied',
      currentStateMatches: true,
    });
    expect(await state()).toEqual(after);
    await owned(async (ownership) => {
      const restarted = await prepareLayoutWorld(target.directory, ownership);
      expect(await restarted.items.initialize()).toEqual(plan.after.items);
      expect(restarted.snapshot).toEqual(plan.after.snapshot);
    });
    const afterRestart = await state();
    const retry = await command('apply', join(reportDirectory, 'after-restart.json'), planFile);
    expect(JSON.parse(retry.stdout)).toMatchObject({
      status: 'already-applied',
      currentStateMatches: false,
    });
    expect(await state()).toEqual(afterRestart);
    expect(await readdir(empty)).toEqual([]);
  });

  it('reports a lost COMMIT reply as outcome-unknown and recovers with the same accepted plan', async () => {
    const planFile = join(reportDirectory, 'plan.json');
    expect((await command('plan', planFile)).code).toBe(0);
    const plan = await readPlan(planFile);
    const faultyBinary = join(dirname(binary), 'terrain-command-lost-reply.mjs');
    await bundleCommand(faultyBinary, true);
    const reportFile = join(reportDirectory, 'unknown.json');
    const failed = await command('apply', reportFile, planFile, [], faultyBinary);
    expect(failed.code).not.toBe(0);
    const summary = JSON.parse(failed.stdout);
    expect(summary).toMatchObject({
      status: 'outcome-unknown',
      planHash: plan.planHash,
      recovery: 'retry-same-accepted-plan',
      report: reportFile,
    });
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    expect(report).toMatchObject({
      status: 'outcome-unknown',
      planHash: plan.planHash,
      operationId: summary.operationId,
      recovery: 'retry-same-accepted-plan',
    });
    const committed = await state();
    const markers = (committed.world_static_operations as Record<string, any>[]).filter(
      (row) => row.entity_id === '__terrain-migration',
    );
    expect(markers).toHaveLength(1);
    expect(markers[0].operation_id).toBe(summary.operationId);
    expect(
      (committed.item_instances as Record<string, any>[])
        .filter((row) => row.world_id === plan.worldId)
        .map((row) => row.physical),
    ).toEqual(plan.after.items);
    const replay = await command('apply', join(reportDirectory, 'retry.json'), planFile);
    expect(replay, replay.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(replay.stdout)).toMatchObject({
      status: 'already-applied',
      operationId: summary.operationId,
      planHash: plan.planHash,
      currentStateMatches: true,
    });
    expect(await state()).toEqual(committed);
  });

  it('rejects stale and modified accepted plans without publishing or writing rows', async () => {
    const planFile = join(reportDirectory, 'plan.json');
    expect((await command('plan', planFile)).code).toBe(0);
    const plan = await readPlan(planFile);
    plan.after.items[0].position.y += 1;
    const modifiedFile = join(reportDirectory, 'modified.json');
    await writeFile(modifiedFile, JSON.stringify(plan));
    const before = await state(),
      targetFiles = await files(target.directory);
    const modified = await command(
      'apply',
      join(reportDirectory, 'modified-result.json'),
      modifiedFile,
    );
    expect(modified.code).toBe(1);
    expect(modified.stderr).toContain('intact, matching valid plan');
    expect(await state()).toEqual(before);
    await database.pool.query(
      'UPDATE item_instances SET properties=$1 WHERE world_id IS NOT NULL',
      [{ changed: true }],
    );
    const changed = await state();
    const stale = await command('apply', join(reportDirectory, 'stale-result.json'), planFile);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('saved state changed since planning');
    expect(await state()).toEqual(changed);
    expect(await files(target.directory)).toEqual(targetFiles);
    expect(await readPlan(join(reportDirectory, 'stale-result.json'))).toMatchObject({
      status: 'rejected',
    });
  });

  it('writes an explicit rejected plan for an airborne saved item without moving it', async () => {
    await database.pool.query(
      "UPDATE item_instances SET physical=jsonb_set(physical,'{position,y}','3.52') WHERE world_id IS NOT NULL",
    );
    const before = await state(),
      targetFiles = await files(target.directory),
      planFile = join(reportDirectory, 'airborne.json');
    const result = await command('plan', planFile);
    expect(result.code).toBe(1);
    const plan = await readPlan(planFile);
    expect(plan.status).toBe('rejected');
    expect(plan.issues).toContainEqual(expect.objectContaining({ kind: 'airborne-item' }));
    expect(await state()).toEqual(before);
    expect(await files(target.directory)).toEqual(targetFiles);
  });

  it('protects release inputs and symlink aliases from report overwrites before connecting', async () => {
    const before = await state(),
      sourceFiles = await files(source.directory),
      targetFiles = await files(target.directory),
      originalRules = await readFile(rulesFile, 'utf8');
    for (const path of [
      join(source.directory, 'manifest.json'),
      join(target.directory, 'authoring.json'),
    ]) {
      const result = await command('plan', path);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('outside source and target');
    }
    const alias = join(reportDirectory, 'rules-alias.json');
    await symlink(rulesFile, alias);
    const result = await command('plan', alias);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('differ from rules and accepted plan');
    expect(await readFile(rulesFile, 'utf8')).toBe(originalRules);
    expect(await files(source.directory)).toEqual(sourceFiles);
    expect(await files(target.directory)).toEqual(targetFiles);
    expect(await state()).toEqual(before);
  });

  it('reports a completed migration truthfully when report writing fails and recovers by replay', async () => {
    const planFile = join(reportDirectory, 'plan.json');
    expect((await command('plan', planFile)).code).toBe(0);
    const outputDirectory = join(reportDirectory, 'not-a-file');
    await mkdir(outputDirectory);
    const failedReport = await command('apply', outputDirectory, planFile);
    expect(failedReport.code).toBe(1);
    expect(JSON.parse(failedReport.stdout)).toMatchObject({
      status: 'applied-report-failed',
      alreadyApplied: false,
    });
    expect(failedReport.stderr).toContain('Migration is already applied; report writing failed');
    const after = await state();
    expect(
      (after.world_static_operations as { entity_id: string }[]).filter(
        (row) => row.entity_id === '__terrain-migration',
      ),
    ).toHaveLength(1);
    const recovered = await command('apply', join(reportDirectory, 'recovered.json'), planFile);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ status: 'already-applied' });
    expect(await state()).toEqual(after);
  });
});
