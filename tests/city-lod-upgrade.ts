import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createAccountFixture } from './helpers/account-fixture.js';
import { createGameServer } from './helpers/game-server.js';
import { cityLodGameProfile } from './helpers/city-lod-game-profile.js';
import { copyFrozenCityLodClient } from './helpers/frozen-city-lod-client.js';
import { prepareLayoutWorld } from '../apps/server/src/layout/prepare.js';
import { WorldOwnership } from '../apps/server/src/world-ownership.js';
import { worldCompatibility } from '../apps/server/src/items/store.js';
import { cityLodInventory } from './helpers/city-lod-inventory.js';

// A real v5/v1 runtime initializes a disposable schema; v6 then migrates it.
// No production database is copied or changed by this fixture.
assert.ok(process.env.SU_TEST_DATABASE_URL, 'SU_TEST_DATABASE_URL is required');
const baseline = resolve(process.env.SU_LOD_BASELINE ?? 'output/city-lod/baseline');
const output = resolve(process.env.SU_LOD_UPGRADE_OUTPUT ?? 'output/city-lod/upgrade');
await mkdir(output, { recursive: true });
const archived = join(baseline, 'source'),
  aliases = new Map<string, string>();
for (const name of ['contracts', 'simulation', 'protocol', 'terrain-build', 'world-release']) {
  const root = join(archived, 'packages', name),
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const [key, path] of Object.entries(pkg.exports))
    aliases.set('@su/' + name + (key === '.' ? '' : key.slice(1)), resolve(root, path as string));
}
const runtime = join(output, 'baseline-runtime.mjs');
await build({
  stdin: {
    contents: `export {createGameServer} from ${JSON.stringify(join(archived, 'apps/server/src/index.ts'))};export {prepareLayoutWorld} from ${JSON.stringify(join(archived, 'apps/server/src/layout/prepare.ts'))};export {WorldOwnership} from ${JSON.stringify(join(archived, 'apps/server/src/world-ownership.ts'))};export {worldCompatibility} from ${JSON.stringify(join(archived, 'apps/server/src/items/store.ts'))};`,
    resolveDir: resolve('.'),
  },
  outfile: runtime,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['bufferutil', 'utf-8-validate', 'msgpackr-extract'],
  nodePaths: ['node_modules', 'apps/server/node_modules', 'packages/simulation/node_modules'].map(
    (p) => resolve(p),
  ),
  banner: {
    js: "import { createRequire as createBaselineRequire } from 'node:module';const require=createBaselineRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'frozen-workspace',
      setup(builder) {
        builder.onResolve({ filter: /^@su\// }, (args) => {
          const path = aliases.get(args.path);
          if (!path) throw new Error('Unknown frozen import ' + args.path);
          return { path };
        });
      },
    },
  ],
});
await cp(join(baseline, 'app/server/HavokPhysics.wasm'), join(output, 'HavokPhysics.wasm'));
const old = await import(pathToFileURL(runtime).href);
const directory = await mkdtemp(join(tmpdir(), 'su-lod-upgrade-')),
  fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const profiles: Record<string, any> = {};
const near = process.env.SU_LOD_GAME_NEAR === '1';
const owners: Array<{ close(): Promise<void> }> = [];
const stores: Array<{ close(): Promise<void> }> = [];
const saved = async () => {
  const result: Record<string, unknown> = {};
  for (const [table, order] of [
    ['accounts', 'id'],
    ['player_profiles', 'account_id'],
    ['world_static_instances', 'entity_id'],
    ['item_instances', 'id'],
    ['inventory_slots', 'id'],
    ['player_positions', 'account_id'],
    ['su_schema_migrations', 'version'],
  ])
    result[table] = (await fixture.pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
  return result;
};
try {
  const b = await cityLodInventory(join(baseline, 'worlds/ring-block')),
    n = await cityLodInventory('dist/worlds/ring-block');
  assert.equal(b.assetsIdentityHash, n.assetsIdentityHash);
  assert.equal(b.simulationConfigHash, n.simulationConfigHash);
  const beforeDir = join(directory, 'before'),
    afterDir = join(directory, 'after');
  await cp(join(baseline, 'worlds/ring-block'), beforeDir, { recursive: true });
  await cp('dist/worlds/ring-block', afterDir, { recursive: true });
  const oldOwner = new old.WorldOwnership(fixture.pool, 'ring-block', randomUUID());
  owners.push(oldOwner);
  const before = await old.prepareLayoutWorld(beforeDir, oldOwner);
  stores.push(before.items);
  const items = await before.items.initialize(),
    accountId = randomUUID();
  assert.ok(items.length > 0);
  await fixture.pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await fixture.pool.query(
    "INSERT INTO player_profiles(account_id,display_name,color_id,version,skin_id) VALUES($1,'HLOD migration','mint',1,'standard')",
    [accountId],
  );
  await before.items.operation(
    accountId,
    randomUUID(),
    { kind: 'pickup', itemId: items[0].entityId },
    () => undefined,
  );
  const spawn = before.definition.spawnPoints[0];
  await fixture.pool.query(
    'INSERT INTO player_positions(account_id,world_id,x,y,z,write_epoch,write_sequence) VALUES($1,$2,$3,$4,$5,$6,7)',
    [accountId, 'ring-block', spawn.x, spawn.y, spawn.z, oldOwner.epoch],
  );
  await before.items.close();
  await oldOwner.close();
  if (process.env.SU_LOD_GAME_PROFILE === '1') {
    const client = join(directory, 'baseline-client');
    await copyFrozenCityLodClient(join(baseline, 'app/client'), client);
    profiles.baseline = await cityLodGameProfile(
      old.createGameServer,
      {
        port: 0,
        accounts: fixture,
        worldDirectory: beforeDir,
        clientDirectory: client,
        modelCatalogDirectory: join(directory, 'disabled-catalog'),
      },
      join(output, 'baseline-game-pending.json'),
      false,
      near ? 1 : 30,
    );
    await writeFile(join(output, 'game-profile.json'), JSON.stringify(profiles, null, 2) + '\n');
  }
  const state = JSON.stringify(await saved()),
    compatibility = old.worldCompatibility(before.definition);
  const owner = new WorldOwnership(fixture.pool, 'ring-block', randomUUID());
  owners.push(owner);
  const started = performance.now(),
    migration = await prepareLayoutWorld(afterDir, owner, true);
  stores.push(migration.items);
  assert.equal(worldCompatibility(migration.definition), compatibility);
  assert.deepEqual(migration.snapshot.instances, before.snapshot.instances);
  await migration.items.migrateGeometry(migration.commit);
  assert.equal(JSON.stringify(await saved()), state);
  await migration.items.close();
  await owner.close();
  const restartOwner = new WorldOwnership(fixture.pool, 'ring-block', randomUUID());
  owners.push(restartOwner);
  const restart = await prepareLayoutWorld(afterDir, restartOwner);
  stores.push(restart.items);
  await restart.items.initialize();
  assert.equal(JSON.stringify(await saved()), state);
  await restart.items.close();
  await restartOwner.close();
  const migrationAndRestartMs = performance.now() - started;
  if (process.env.SU_LOD_GAME_PROFILE === '1') {
    profiles.candidate = await cityLodGameProfile(
      createGameServer,
      {
        port: 0,
        accounts: fixture,
        worldDirectory: afterDir,
        modelCatalogDirectory: join(directory, 'disabled-catalog'),
      },
      join(output, 'candidate-game-pending.json'),
      !near,
      near ? 1 : 30,
    );
    assert.equal(profiles.candidate.simulationConfigHash, profiles.baseline.simulationConfigHash);
    assert.equal(profiles.candidate.serverBodies, profiles.baseline.serverBodies);
    assert.ok(
      Math.hypot(
        ...(['x', 'y', 'z'] as const).map(
          (axis) => profiles.candidate.position[axis] - profiles.baseline.position[axis],
        ),
      ) < 0.05,
      'Both guests must start at the same physical spawn',
    );
    if (near) {
      assert.ok(
        profiles.candidate.walk.p95 <= 1.1 * profiles.baseline.walk.p95,
        `Near walk p95: ${profiles.candidate.walk.p95}/${profiles.baseline.walk.p95} > 1.1`,
      );
    } else {
      assert.ok(profiles.candidate.near > 0 && profiles.candidate.far > 0);
      for (const metric of ['bodyBytes', 'drawCalls'])
        assert.ok(
          profiles.candidate[metric] < profiles.baseline[metric],
          `Game far ${metric} must improve`,
        );
      assert.ok(
        profiles.candidate.geometry.geometryBytes < profiles.baseline.geometry.geometryBytes,
      );
    }
    await writeFile(join(output, 'game-profile.json'), JSON.stringify(profiles, null, 2) + '\n');
    assert.equal(JSON.stringify(await saved()), state);
  }
  const counts = Object.fromEntries(
    Object.entries(await saved()).map(([name, rows]) => [name, (rows as unknown[]).length]),
  );
  const result = {
    baselineFormat: b.formatVersion,
    candidateFormat: n.formatVersion,
    baselineRelease: before.release.metadata.assetReleaseVersion,
    candidateRelease: migration.release.metadata.assetReleaseVersion,
    compatibility,
    simulationConfigHash: n.simulationConfigHash,
    migrationAndRestartMs,
    groups: restart.manifest.graphics!.groups.length,
    preservedRows: counts,
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  for (const store of stores) await store.close();
  for (const owner of owners) await owner.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
