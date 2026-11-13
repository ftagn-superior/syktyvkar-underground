/** Runs only against an explicitly named, restored loopback database. Never seeds user data. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson } from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { createDatabasePool } from '../apps/server/src/database.js';
import { migrateDatabase } from '../apps/server/src/migrations.js';
import { createGameServer } from '../apps/server/src/index.js';
import type { TerrainMigrationPlan } from '../apps/server/src/layout/terrain-migration.js';

const exec = promisify(execFile);
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  assert.ok(['--source', '--target', '--rules', '--catalog', '--output'].includes(key) && value);
  assert.ok(!options.has(key));
  options.set(key, resolve(value));
}
for (const key of ['--source', '--target', '--rules', '--catalog', '--output'])
  assert.ok(options.has(key), `Required: ${key}`);
const databaseUrl = process.env.SU_REHEARSAL_DATABASE_URL;
assert.ok(databaseUrl, 'SU_REHEARSAL_DATABASE_URL is required; DATABASE_URL is not used');
const parsed = new URL(databaseUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'Loopback database only');
assert.ok(
  ['/terrain_production_rehearsal', '/terrain_production_rehearsal_65ec'].includes(parsed.pathname),
  'Dedicated restored database only',
);
const output = options.get('--output')!;
process.umask(0o077);
await mkdir(output, { recursive: true, mode: 0o700 });
const save = (name: string, data: unknown) =>
  writeFile(join(output, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const pool = createDatabasePool(databaseUrl);
const checks: Record<string, unknown> = {};
const report: Record<string, unknown> = {
  formatVersion: 1,
  status: 'running',
  scope: 'full production backup restored to local isolated database',
  fixtureInjection: false,
  checks,
};
const sanitize = (s: string) =>
  s
    .replaceAll(databaseUrl, '[rehearsal-database]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database]');
type State = Record<string, string[]>;
async function readState(): Promise<State> {
  const tables = (
    await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const result: State = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    result[tablename] = (
      await pool.query<{ row: string }>(
        `SELECT to_jsonb(t)::text AS row FROM ${tablename} t ORDER BY to_jsonb(t)::text`,
      )
    ).rows.map((r) => r.row);
  }
  return result;
}
const protectedRows = (state: State) => ({
  ...Object.fromEntries(
    [
      'accounts',
      'account_identities',
      'auth_sessions',
      'player_profiles',
      'inventory_slots',
      'item_types',
      'item_operations',
      'su_schema_migrations',
    ].map((k) => [k, state[k]]),
  ),
  inventory: state.item_instances.filter((row) => JSON.parse(row).world_id === null),
  playerPositionMetadata: (state.player_positions ?? [])
    .map((row) => {
      const value = JSON.parse(row);
      if (value.world_id === 'ring-block') delete value.y;
      return canonicalJson(value);
    })
    .sort(),
});
const digest = (data: unknown) => hash(canonicalJson(data));
const ids = (rows: string[], field: string) => rows.map((r) => JSON.parse(r)[field]).sort();
async function cli(command: 'plan' | 'apply', name: string, plan?: string) {
  const argv = [
    '--import',
    'tsx',
    'apps/server/src/terrain-command.ts',
    command,
    '--source',
    options.get('--source')!,
    '--target',
    options.get('--target')!,
    '--rules',
    options.get('--rules')!,
    '--report',
    join(output, name),
  ];
  if (plan) argv.push('--plan', plan);
  try {
    const result = await exec(process.execPath, argv, {
      env: { ...process.env, DATABASE_URL: databaseUrl, SU_WORLD: 'ring-block' },
      timeout: 900_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await writeFile(join(output, name + '.stderr.log'), sanitize(result.stderr), { mode: 0o600 });
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    const e = error as Error & { stderr?: string };
    if (e.stderr)
      await writeFile(join(output, name + '.stderr.log'), sanitize(e.stderr), { mode: 0o600 });
    throw new Error(`Migration ${command} failed; inspect private ${name} and stderr log`);
  }
}
try {
  const original = await readState();
  if (!original.player_positions) {
    assert.equal(original.su_schema_migrations.length, 6, 'Expected schema 6 production source');
    await save('before-schema-upgrade.json', original);
    await migrateDatabase(pool);
    const upgraded = await readState();
    for (const [table, rows] of Object.entries(original)) {
      if (table !== 'su_schema_migrations') assert.deepEqual(upgraded[table], rows);
    }
    assert.deepEqual(upgraded.player_positions, []);
    assert.equal(upgraded.su_schema_migrations.length, 7);
    checks.schemaUpgrade = { from: 6, to: 7, existingRowsPreserved: true, savedPlayerPositions: 0 };
  }
  const before = await readState();
  assert.equal(before.persistent_worlds.length, 1);
  const beforeProtected = protectedRows(before);
  await save('before-state.json', before);
  report.before = {
    stateHash: digest(before),
    tables: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length])),
    protectedHash: digest(beforeProtected),
  };
  console.log('[production-rehearsal] Planning; checking every table for read-only behavior');
  checks.plan = await cli('plan', 'plan.json');
  assert.deepEqual(await readState(), before);
  checks.planReadOnly = true;
  const plan = JSON.parse(
    await readFile(join(output, 'plan.json'), 'utf8'),
  ) as TerrainMigrationPlan;
  assert.equal(plan.status, 'valid');
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.before.snapshot.revision, JSON.parse(before.world_layouts[0]).revision);
  assert.equal(
    plan.before.items.length,
    before.item_instances.filter((r) => JSON.parse(r).world_id !== null).length,
  );
  checks.itemPoses = plan.after.items.map((after) => {
    const previous = plan.before.items.find((i) => i.entityId === after.entityId)!;
    assert.ok(previous);
    assert.equal(after.position.x, previous.position.x);
    assert.equal(after.position.z, previous.position.z);
    assert.deepEqual(after.rotation, previous.rotation);
    assert.equal(after.safePose.position.x, previous.safePose.position.x);
    assert.equal(after.safePose.position.z, previous.safePose.position.z);
    assert.deepEqual(after.safePose.rotation, previous.safePose.rotation);
    return {
      identityHash: hash(after.entityId),
      deltaY: after.position.y - previous.position.y,
      safeDeltaY: after.safePose.position.y - previous.safePose.position.y,
    };
  });
  console.log('[production-rehearsal] Applying accepted plan and replaying it');
  checks.apply = await cli('apply', 'apply.json', join(output, 'plan.json'));
  const after = await readState();
  assert.deepEqual(protectedRows(after), beforeProtected);
  assert.deepEqual(ids(after.item_instances, 'id'), ids(before.item_instances, 'id'));
  assert.deepEqual(
    ids(after.world_static_instances, 'entity_id'),
    ids(before.world_static_instances, 'entity_id'),
  );
  for (const row of after.item_instances) {
    const current = JSON.parse(row);
    const previous = before.item_instances
      .map((r) => JSON.parse(r))
      .find((r) => r.id === current.id);
    for (const field of [
      'type_id',
      'properties',
      'world_id',
      'slot_id',
      'seed_world_id',
      'seed_id',
    ])
      assert.deepEqual(current[field], previous[field], `Item ${field} must be preserved`);
  }
  checks.identitiesPropertiesAndInventoryPreserved = true;
  checks.savedPlayerPositions = {
    before: before.player_positions?.length ?? 0,
    after: after.player_positions?.length ?? 0,
    identityAndXZPreserved: true,
  };
  checks.replay = await cli('apply', 'replay.json', join(output, 'plan.json'));
  assert.equal((checks.replay as { status: string }).status, 'already-applied');
  assert.deepEqual(await readState(), after);
  checks.replayReadOnly = true;
  await save('after-apply-state.json', after);
  const boots = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    console.log(`[production-rehearsal] Real server boot ${cycle + 1}`);
    const app = await createGameServer({
      pool,
      port: 0,
      host: '127.0.0.1',
      worldDirectory: options.get('--target'),
      modelCatalogDirectory: options.get('--catalog'),
      itemCreationEnabled: false,
    });
    try {
      const ready = await fetch(app.url + '/health/ready', { signal: AbortSignal.timeout(10_000) });
      assert.equal(ready.status, 200);
      const info = await (await fetch(app.url + '/api/world')).json();
      assert.equal(info.layoutHash, plan.targetLayoutHash);
      assert.equal(info.layoutRevision, plan.after.snapshot.revision);
      assert.ok(info.placementCatalog, 'Placement catalog remains advertised on terrain');
      assert.match(info.placementCatalog.placementCatalogVersion, /^[a-f0-9]{64}$/);
      assert.deepEqual(
        [...app.room.state.items.keys()].sort(),
        plan.after.items.map((i) => i.entityId).sort(),
      );
      assert.equal(app.room.diagnostics().persistence.unavailable, false);
      boots.push({
        cycle,
        readiness: 200,
        mapVersion: info.mapVersion,
        layoutRevision: info.layoutRevision,
        items: app.room.state.items.size,
        placementCatalogVersion: info.placementCatalog.placementCatalogVersion,
      });
    } finally {
      await app.close();
    }
    assert.deepEqual(protectedRows(await readState()), beforeProtected);
  }
  checks.boots = boots;
  report.after = {
    stateHash: digest(await readState()),
    protectedHash: digest(beforeProtected),
    revision: plan.after.snapshot.revision,
    planHash: plan.planHash,
    targetLayoutHash: plan.targetLayoutHash,
  };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = sanitize(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
  await save('report.json', report);
  console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json') }));
  if (report.status !== 'passed') console.error(report.failure);
}
