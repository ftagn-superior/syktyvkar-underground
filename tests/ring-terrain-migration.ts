/**
 * Staging rehearsal only: the exact static export plus explicitly synthetic
 * items/accounts/inventory, in a fresh disposable PostgreSQL schema.
 * Requires SU_TEST_DATABASE_URL; never falls back to DATABASE_URL or .env.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  buildingBounds,
  canonicalJson,
  initialItemState,
  sampleTerrain,
  validateWorldLayoutSnapshot,
  type ItemState,
  type WorldDefinition,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import {
  createAuthoritativeWorld,
  type AuthoritativeWorld,
} from '../packages/simulation/src/server.js';
import { ItemStore } from '../apps/server/src/items/store.js';
import { prepareLayoutWorld } from '../apps/server/src/layout/prepare.js';
import { StaticLayoutStore } from '../apps/server/src/layout/store.js';
import {
  createLayoutPublication,
  editableStaticAssetIds,
  readAuthoringRelease,
} from '../apps/server/src/layout/release.js';
import {
  planStaticTerrainPoses,
  type TerrainPoseRules,
} from '../apps/server/src/layout/terrain-poses.js';
import type { TerrainMigrationPlan } from '../apps/server/src/layout/terrain-migration.js';
import { WorldOwnership } from '../apps/server/src/world-ownership.js';
import { createDatabaseFixture } from './helpers/database-fixture.js';

const exec = promisify(execFile);
const defaults = {
  '--source': 'output/ring-terrain-stage0/source-world',
  '--target': 'output/ring-terrain-stage4/authoring-world',
  '--rules': 'output/ring-terrain-stage4/terrain-pose-rules.json',
  '--layout': 'data/map-layout.json',
  '--output': 'output/ring-terrain-stage4/staging-migration',
};
const args = { ...defaults };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i] as keyof typeof args;
  assert.ok(Object.hasOwn(args, key) && process.argv[i + 1], `Unknown/missing argument: ${key}`);
  args[key] = process.argv[i + 1];
}
const databaseUrl = process.env.SU_TEST_DATABASE_URL;
assert.ok(databaseUrl, 'SU_TEST_DATABASE_URL is required; this rehearsal never uses DATABASE_URL');
const sourceDirectory = resolve(args['--source']);
const targetDirectory = resolve(args['--target']);
const rulesFile = resolve(args['--rules']);
const layoutFile = resolve(args['--layout']);
const output = resolve(args['--output'], randomUUID());
const reportFile = join(output, 'report.json');
const fixtureTag = 'synthetic-ring-terrain-migration-rehearsal';
const identity = { x: 0, y: 0, z: 0, w: 1 };
const digest = (value: unknown) => hash(canonicalJson(value));
const sanitize = (value: string) =>
  value
    .replaceAll(databaseUrl, '[test-database]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[test-database]');
const report: Record<string, unknown> = {
  formatVersion: 1,
  status: 'running',
  scope: 'disposable PostgreSQL schema; not the user database',
  staticInput: 'exact saved export; no reseeding or static fixture edits',
  dynamicInput:
    'synthetic world items, account and inventory; no real dynamic snapshot was supplied',
  nonExportDatabaseFields:
    'synthetic bootstrap epochs/timestamps/history; the static JSON export is not a backup of the user database',
  sourceDirectory,
  targetDirectory,
  rulesFile,
  layoutFile,
  checks: {},
};
const checks = report.checks as Record<string, unknown>;
await mkdir(output, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const phase = (message: string) => console.log(`[terrain-staging] ${message}`);

/** Only connection environment is passed to libpq; credentials never enter argv or reports. */
function postgresEnvironment() {
  const url = new URL(databaseUrl!);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  };
  for (const [key, variable] of [
    ['sslmode', 'PGSSLMODE'],
    ['gssencmode', 'PGGSSENCMODE'],
    ['sslrootcert', 'PGSSLROOTCERT'],
    ['sslcert', 'PGSSLCERT'],
    ['sslkey', 'PGSSLKEY'],
  ])
    if (url.searchParams.has(key)) env[variable] = url.searchParams.get(key)!;
  return env;
}

let database: Awaited<ReturnType<typeof createDatabaseFixture>> | undefined;
let activeOwner: WorldOwnership | undefined;
try {
  const [source, target, layoutBytes, rulesBytes] = await Promise.all([
    readAuthoringRelease(sourceDirectory),
    readAuthoringRelease(targetDirectory),
    readFile(layoutFile),
    readFile(rulesFile),
  ]);
  const snapshot = JSON.parse(layoutBytes.toString()) as WorldLayoutSnapshot;
  validateWorldLayoutSnapshot(snapshot);
  const rules = JSON.parse(rulesBytes.toString()) as TerrainPoseRules;
  assert.equal(snapshot.worldId, source.definition.worldId);
  assert.equal(snapshot.worldId, target.definition.worldId);
  assert.equal(snapshot.assetReleaseVersion, source.metadata.assetReleaseVersion);
  assert.notEqual(source.metadata.assetReleaseVersion, target.metadata.assetReleaseVersion);
  report.inputs = {
    layoutSha256: hash(layoutBytes),
    rulesSha256: hash(rulesBytes),
    sourceAssetRelease: source.metadata.assetReleaseVersion,
    targetAssetRelease: target.metadata.assetReleaseVersion,
    savedSeedVersion: snapshot.seedVersion,
    authoredSourceSeedVersion: source.metadata.seedVersion,
    savedRevision: snapshot.revision,
    staticCount: snapshot.instances.length,
    disabledCount: snapshot.instances.filter((i) => !i.enabled).length,
  };
  phase('Preparing actual saved city geometry and synthetic supported items');
  const sourcePublication = await createLayoutPublication(source, snapshot);
  const staticPlan = planStaticTerrainPoses(
    {
      sourceRelease: source,
      targetRelease: target,
      sourceSnapshot: snapshot,
      sourceWorld: sourcePublication.world,
      sourceItems: [],
      sourcePlayers: [],
    },
    rules,
  );
  await save('static-preparation.json', staticPlan);
  assert.deepEqual(staticPlan.issues, [], 'Actual city static preparation must resolve all cases');
  const targetPublication = await createLayoutPublication(target, staticPlan.targetSnapshot);

  const sourcePhysics = await createAuthoritativeWorld({
    ...sourcePublication.world,
    initialItems: [],
  });
  let targetPhysics: AuthoritativeWorld | undefined;
  let syntheticItems: ItemState[];
  const groundCandidates: ItemState[] = [];
  const nearSupport = (physics: AuthoritativeWorld, state: ItemState, allowed: Set<string>) => {
    const hits = physics
      .queryItemSupports(state.typeId, state, {
        startY: state.position.y + 0.03,
        endY: state.position.y - 0.06,
      })
      .filter((h) => h.normal.y >= 0.4 && Math.abs(h.contactY - state.position.y) <= 0.04);
    return hits.length > 0 && hits.every((h) => allowed.has(h.entityId));
  };
  const itemAt = (
    physics: AuthoritativeWorld,
    world: WorldDefinition,
    x: number,
    z: number,
    allowed: Set<string>,
    entityId: string,
  ) => {
    const item = initialItemState({
      seedId: entityId,
      typeId: 'wooden-crate',
      position: { x, y: 0, z },
      rotation: identity,
    });
    const hits = physics
      .queryItemSupports(item.typeId, item, {
        startY: world.bounds.max.y + 20,
        endY: world.bounds.min.y - 20,
      })
      .filter((h) => allowed.has(h.entityId) && h.normal.y >= 0.4);
    if (!hits.length) return;
    item.position.y = Math.max(...hits.map((h) => h.contactY)) + 0.02;
    item.safePose = { position: { ...item.position }, rotation: { ...identity } };
    if (physics.checkSavedItem(item) || !nearSupport(physics, item, allowed)) return;
    return item;
  };
  try {
    targetPhysics = await createAuthoritativeWorld({
      ...targetPublication.world,
      initialItems: [],
    });
    const pilot = snapshot.instances.find((i) => i.entityId === 'osm-way-1258973447');
    assert.ok(pilot?.enabled, 'Expected saved pilot building');
    const candidates = [...sourcePublication.world.spawnPoints.map((p) => ({ x: p.x, z: p.z }))];
    for (let dz = -40; dz <= 40; dz += 4)
      for (let dx = -40; dx <= 40; dx += 4)
        candidates.push({ x: pilot.position.x + dx, z: pilot.position.z + dz });
    candidates.sort(
      (a, b) =>
        Math.abs(sampleTerrain(target.terrain!.grid, b.x, b.z)?.height ?? 0) -
        Math.abs(sampleTerrain(target.terrain!.grid, a.x, a.z)?.height ?? 0),
    );
    for (const { x, z } of candidates) {
      if (groundCandidates.some((i) => Math.hypot(i.position.x - x, i.position.z - z) < 4))
        continue;
      const sourceItem = itemAt(
        sourcePhysics,
        sourcePublication.world,
        x,
        z,
        new Set(rules.sourceGroundIds),
        `rehearsal-ground-${groundCandidates.length}`,
      );
      const targetItem =
        sourceItem &&
        itemAt(
          targetPhysics,
          targetPublication.world,
          x,
          z,
          new Set(rules.targetGroundIds),
          sourceItem.entityId,
        );
      if (!sourceItem || !targetItem) continue;
      groundCandidates.push(sourceItem);
      if (groundCandidates.length === 2) break;
    }
    assert.equal(
      groundCandidates.length,
      2,
      'Need two independently free source/target ground points',
    );
    const bounds = buildingBounds(
      pilot,
      sourcePublication.world.buildingAssets[pilot.assetId].bounds,
    );
    let roofItem: ItemState | undefined;
    for (const u of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      for (const v of [0.5, 0.25, 0.75, 0.1, 0.9]) {
        const x = bounds.min.x + (bounds.max.x - bounds.min.x) * u;
        const z = bounds.min.z + (bounds.max.z - bounds.min.z) * v;
        const sourceItem = itemAt(
          sourcePhysics,
          sourcePublication.world,
          x,
          z,
          new Set([pilot.entityId]),
          'rehearsal-roof',
        );
        const targetItem =
          sourceItem &&
          itemAt(
            targetPhysics,
            targetPublication.world,
            x,
            z,
            new Set([pilot.entityId]),
            sourceItem.entityId,
          );
        if (sourceItem && targetItem) {
          roofItem = sourceItem;
          break;
        }
      }
      if (roofItem) break;
    }
    assert.ok(roofItem, 'Need a verified source/target pilot roof point');
    roofItem.safePose = structuredClone(groundCandidates[1].safePose);
    syntheticItems = [groundCandidates[0], roofItem];
    for (const item of syntheticItems) {
      item.revision = 73;
      item.placementVersion = 7;
      item.velocity = { x: 0.01, y: -0.02, z: 0.03 };
      item.angularVelocity = { x: -0.01, y: 0.02, z: 0.01 };
    }
    report.syntheticDynamicFixture = {
      tag: fixtureTag,
      worldItems: syntheticItems,
      inventoryItems: 3,
      accounts: 1,
      slots: 2,
      roofCurrentSupport: pilot.entityId,
      roofSafePoseSupport: 'ground',
    };
  } finally {
    targetPhysics?.dispose();
    sourcePhysics.dispose();
  }

  phase('Importing exact static export into one disposable schema');
  database = await createDatabaseFixture(databaseUrl);
  report.schema = database.schema;
  const pool = database.pool;
  const owner = () => new WorldOwnership(pool, snapshot.worldId, randomUUID());
  activeOwner = owner();
  const store = new ItemStore(
    pool,
    { ...sourcePublication.world, initialItems: [] },
    activeOwner.epoch,
    activeOwner,
  );
  assert.deepEqual(await store.initialize(), []);
  const db = activeOwner.db;
  await db.query('BEGIN');
  try {
    await db.query(
      `INSERT INTO world_layouts(world_id,asset_release_version,seed_version,asset_ids,fixed_entity_ids,revision,validated_revision,validated_hash)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7)`,
      [
        snapshot.worldId,
        snapshot.assetReleaseVersion,
        snapshot.seedVersion,
        editableStaticAssetIds(source),
        [...source.metadata.fixedInstanceIds, ...source.definition.entities.map((i) => i.entityId)],
        snapshot.revision,
        sourcePublication.hash,
      ],
    );
    // Fixture bootstrap only. Ordinary SQL edits correctly bump revisions; here
    // the exported revisions themselves are evidence and must survive verbatim.
    await db.query('ALTER TABLE world_static_instances DISABLE TRIGGER USER');
    await db.query(
      `INSERT INTO world_static_instances(world_id,entity_id,asset_id,position_x,position_y,position_z,rotation_x,rotation_y,rotation_z,rotation_w,instance_revision,enabled,source_ref)
      SELECT $1,x->>'entityId',x->>'assetId',(x->'position'->>'x')::double precision,(x->'position'->>'y')::double precision,(x->'position'->>'z')::double precision,
      (x->'rotation'->>'x')::double precision,(x->'rotation'->>'y')::double precision,(x->'rotation'->>'z')::double precision,(x->'rotation'->>'w')::double precision,
      (x->>'instanceRevision')::integer,(x->>'enabled')::boolean,x->'sourceRef' FROM jsonb_array_elements($2::jsonb) x`,
      [snapshot.worldId, canonicalJson(snapshot.instances)],
    );
    await db.query('ALTER TABLE world_static_instances ENABLE TRIGGER USER');
    for (const item of syntheticItems!)
      await db.query(
        `INSERT INTO item_instances(id,type_id,properties,world_id,physical,placement_version,snapshot_epoch,snapshot_sequence)
        VALUES($1,$2,$3,$4,$5,$6,$7,41)`,
        [
          item.entityId,
          item.typeId,
          { fixture: fixtureTag, synthetic: true },
          snapshot.worldId,
          item,
          item.placementVersion,
          activeOwner.epoch,
        ],
      );
    const accountId = randomUUID(),
      firstSlot = randomUUID(),
      secondSlot = randomUUID();
    await db.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
    await db.query(
      'INSERT INTO inventory_slots(id,account_id,position) VALUES($1,$3,100),($2,$3,200)',
      [firstSlot, secondSlot, accountId],
    );
    for (let i = 0; i < 3; i++)
      await db.query(
        'INSERT INTO item_instances(id,type_id,properties,slot_id,placement_version) VALUES($1,$2,$3,$4,3)',
        [
          `rehearsal-inventory-${i}`,
          i < 2 ? 'wooden-crate' : 'watermelon-ball',
          { fixture: fixtureTag, synthetic: true },
          i < 2 ? firstSlot : secondSlot,
        ],
      );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
  assert.deepEqual(
    (await new StaticLayoutStore(activeOwner, source).readCandidate()).snapshot,
    snapshot,
  );
  await activeOwner.close();
  activeOwner = undefined;
  checks.exactStaticImport = true;
  const readState = async () => {
    const tables = (
      await pool.query<{ tablename: string }>(
        'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename',
      )
    ).rows.map((r) => r.tablename);
    const result: Record<string, string[]> = {};
    for (const table of tables) {
      assert.match(table, /^[a-z_]+$/);
      result[table] = (
        await pool.query<{ row: string }>(
          `SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows.map((r) => r.row);
    }
    return result;
  };
  const before = await readState();
  const protectedRows = (state: Record<string, string[]>) => ({
    accounts: state.accounts,
    inventory_slots: state.inventory_slots,
    item_types: state.item_types,
    item_operations: state.item_operations,
    inventory_items: state.item_instances.filter((row) => JSON.parse(row).world_id === null),
  });
  const beforeProtected = protectedRows(before);
  const backup = join(output, 'before.dump');
  const pgEnv = postgresEnvironment();
  await exec(
    'pg_dump',
    [
      '--format=custom',
      '--no-owner',
      '--no-acl',
      `--schema=${database.schema}`,
      `--file=${backup}`,
    ],
    { env: pgEnv, timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  report.backup = {
    file: backup,
    sha256: hash(await readFile(backup)),
    bytes: (await stat(backup)).size,
    sourceReleaseRetained: sourceDirectory,
    schemaOnly: true,
    stateHash: digest(before),
  };

  const schemaUrl = new URL(databaseUrl);
  schemaUrl.searchParams.set('options', `-c search_path=${database.schema}`);
  const runCli = async (command: 'plan' | 'apply', reportName: string, plan?: string) => {
    const argv = [
      '--import',
      'tsx',
      'apps/server/src/terrain-command.ts',
      command,
      '--source',
      sourceDirectory,
      '--target',
      targetDirectory,
      '--rules',
      rulesFile,
      '--report',
      join(output, reportName),
    ];
    if (plan) argv.push('--plan', plan);
    const result = await exec(process.execPath, argv, {
      env: { ...process.env, DATABASE_URL: schemaUrl.toString(), SU_WORLD: snapshot.worldId },
      timeout: 900_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(join(output, `${reportName}.stderr.log`), sanitize(result.stderr));
    const summary = JSON.parse(result.stdout.trim());
    assert.equal(typeof summary.planHash, 'string');
    return summary;
  };
  phase('Running the real CLI dry-run and verifying zero SQL changes');
  checks.cliPlan = await runCli('plan', 'plan.json');
  assert.deepEqual(await readState(), before);
  const plan = JSON.parse(
    await readFile(join(output, 'plan.json'), 'utf8'),
  ) as TerrainMigrationPlan;
  assert.equal(plan.status, 'valid');
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.before.snapshot, snapshot);
  assert.deepEqual(
    plan.before.items,
    syntheticItems!.slice().sort((a, b) => a.entityId.localeCompare(b.entityId)),
  );
  assert.ok(
    plan.after.snapshot.instances.some(
      (i, index) => i.position.y !== plan.before.snapshot.instances[index].position.y,
    ),
    'Actual static Y must migrate',
  );
  assert.ok(
    plan.after.items.some((i, index) => i.position.y !== plan.before.items[index].position.y),
    'Synthetic world-item Y must migrate',
  );
  checks.planReadOnly = true;

  phase('Applying the accepted CLI plan and checking preserved inventory/identities');
  checks.cliApply = await runCli('apply', 'apply.json', join(output, 'plan.json'));
  const after = await readState();
  assert.deepEqual(protectedRows(after), beforeProtected);
  assert.equal(after.world_static_instances.length, before.world_static_instances.length);
  const ids = (rows: string[], field: string) => rows.map((row) => JSON.parse(row)[field]).sort();
  assert.deepEqual(ids(after.item_instances, 'id'), ids(before.item_instances, 'id'));
  assert.equal(
    after.world_static_operations.filter((r) => JSON.parse(r).entity_id === '__terrain-migration')
      .length,
    1,
  );
  checks.cliReplay = await runCli('apply', 'replay.json', join(output, 'plan.json'));
  assert.equal((checks.cliReplay as { status: string }).status, 'already-applied');
  assert.deepEqual(await readState(), after);
  checks.inventoryPreserved = true;
  checks.replayReadOnly = true;

  async function startup(directory: string, expected: TerrainMigrationPlan['after']) {
    activeOwner = owner();
    try {
      const prepared = await prepareLayoutWorld(directory, activeOwner);
      const items = await prepared.items.initialize();
      assert.deepEqual(prepared.snapshot, expected.snapshot);
      assert.deepEqual(items, expected.items);
      return {
        layoutHash: prepared.layoutHash,
        mapVersion: prepared.manifest.mapVersion,
        itemCount: items.length,
        staticCount: prepared.snapshot.instances.length,
      };
    } finally {
      await activeOwner.close();
      activeOwner = undefined;
    }
  }
  phase('Checking ordinary startup, restart and rejection of the old release');
  checks.targetStartup = await startup(targetDirectory, plan.after);
  checks.targetRestart = await startup(targetDirectory, plan.after);
  assert.deepEqual(protectedRows(await readState()), beforeProtected);
  phase('Starting the actual server twice and checking HTTP readiness and item identities');
  const { createGameServer } = await import('../apps/server/src/index.js');
  const liveServerCycles = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    const app = await createGameServer({
      pool,
      port: 0,
      host: '127.0.0.1',
      worldDirectory: targetDirectory,
      itemCreationEnabled: false,
    });
    try {
      const ready = await fetch(app.url + '/health/ready', { signal: AbortSignal.timeout(10_000) });
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { ready: true });
      const response = await fetch(app.url + '/api/world', { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      const info = await response.json();
      assert.equal(info.assetReleaseVersion, target.metadata.assetReleaseVersion);
      assert.equal(info.layoutHash, plan.targetLayoutHash);
      assert.equal(info.layoutRevision, plan.after.snapshot.revision);
      assert.deepEqual(
        [...app.room.state.items.keys()].sort(),
        plan.after.items.map((i) => i.entityId).sort(),
      );
      assert.equal(app.room.diagnostics().persistence.unavailable, false);
      liveServerCycles.push({
        cycle,
        readiness: 200,
        layoutHash: info.layoutHash,
        layoutRevision: info.layoutRevision,
        items: app.room.state.items.size,
        ticks: app.room.state.serverTick,
      });
    } finally {
      await app.close();
    }
    assert.deepEqual(protectedRows(await readState()), beforeProtected);
  }
  checks.liveServerCycles = liveServerCycles;
  const beforeWrongRelease = await readState();
  activeOwner = owner();
  await assert.rejects(prepareLayoutWorld(sourceDirectory, activeOwner), /Asset release changed/);
  await activeOwner.close();
  activeOwner = undefined;
  assert.deepEqual(await readState(), beforeWrongRelease);
  checks.oldReleaseRejectedWithoutWrites = true;
  checks.replayAfterRestart = await runCli(
    'apply',
    'replay-after-restart.json',
    join(output, 'plan.json'),
  );
  assert.equal((checks.replayAfterRestart as { status: string }).status, 'already-applied');
  assert.deepEqual(await readState(), beforeWrongRelease);

  phase('Restoring the schema-only pg_dump backup and restarting the retained source release');
  await exec(
    'pg_restore',
    [
      '--clean',
      '--if-exists',
      '--single-transaction',
      '--no-owner',
      '--no-acl',
      `--dbname=${pgEnv.PGDATABASE}`,
      backup,
    ],
    { env: pgEnv, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const restored = await readState();
  assert.deepEqual(
    restored,
    before,
    'Backup restore must reproduce every table and timestamp exactly',
  );
  checks.backupRestoredExactState = {
    stateHash: digest(restored),
    tables: Object.keys(restored).length,
  };
  checks.sourceStartupAfterRestore = await startup(sourceDirectory, plan.before);
  assert.deepEqual(protectedRows(await readState()), beforeProtected);
  assert.equal(
    hash(await readFile(layoutFile)),
    hash(layoutBytes),
    'Saved static export must remain untouched',
  );
  report.plan = {
    planHash: plan.planHash,
    sourceStateHash: plan.sourceStateHash,
    targetStateHash: plan.targetStateHash,
    targetLayoutHash: plan.targetLayoutHash,
    sourceCompatibility: plan.sourceCompatibility,
    targetCompatibility: plan.targetCompatibility,
  };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = sanitize(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
} finally {
  await activeOwner?.close();
  if (database) {
    await database.close();
    report.disposableSchemaDropped = true;
  }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: reportFile, scope: report.scope }));
  if (report.status !== 'passed') console.error(report.failure);
}
