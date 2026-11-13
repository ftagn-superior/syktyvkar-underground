import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadEnvironment, readDatabaseUrl } from './config.js';
import { createDatabasePool } from './database.js';
import { checkDatabaseSchema } from './migrations.js';
import { WorldOwnership } from './world-ownership.js';
import { prepareLayoutWorld } from './layout/prepare.js';
import { AssetRemapFailure, migrateStaticAssets } from './layout/asset-remap.js';

async function readJson(file: string): Promise<unknown> {
  const limit = 32 * 1024 * 1024;
  if ((await stat(file)).size > limit) throw new Error(`Migration file exceeds 32 MiB: ${file}`);
  const bytes = await readFile(file);
  if (bytes.byteLength > limit) throw new Error(`Migration file exceeds 32 MiB: ${file}`);
  return JSON.parse(bytes.toString('utf8'));
}
async function writeJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

async function run() {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--asset-remap', '--dry-run', '--report', '--plan'].includes(key) || options.has(key))
      throw new Error(`Unexpected migration argument: ${key}`);
    if (key === '--dry-run') options.set(key, 'true');
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options.set(key, value);
    }
  }
  const remapFile = options.get('--asset-remap'),
    reportFile = options.get('--report'),
    planFile = options.get('--plan'),
    dryRun = options.has('--dry-run');
  if (!remapFile && (dryRun || reportFile || planFile))
    throw new Error('--dry-run, --report and --plan require --asset-remap <rules.json>');
  if (dryRun && planFile) throw new Error('Use --plan only when applying a previous dry-run');
  if (
    reportFile &&
    [remapFile, planFile].some((file) => file && resolve(file) === resolve(reportFile))
  )
    throw new Error('Migration report output must differ from the rules and accepted plan');
  const rules = remapFile ? await readJson(remapFile) : undefined;
  const plan = planFile ? await readJson(planFile) : undefined;
  loadEnvironment();
  const worldId = process.env.SU_WORLD ?? 'ring-block';
  if (!/^[a-z0-9-]{1,64}$/.test(worldId)) throw new Error('SU_WORLD must be a world ID');
  const pool = createDatabasePool(readDatabaseUrl());
  const ownership = new WorldOwnership(pool, worldId, randomUUID());
  try {
    await checkDatabaseSchema(pool);
    if (remapFile) {
      const result = await migrateStaticAssets(`dist/worlds/${worldId}`, ownership, rules, {
        dryRun,
        plan,
      });
      if (reportFile) await writeJson(reportFile, result.report);
      console.log(
        `${dryRun ? 'Valid asset remap' : result.report.alreadyApplied ? 'Asset remap already applied' : 'Applied asset remap'} for ${worldId}: ` +
          `${result.report.transformation.sourceCount} -> ${result.report.transformation.targetCount} placements; ` +
          `revision ${result.report.sourceRevision} -> ${result.snapshot.revision}; hash ${result.report.layoutHash}. ` +
          (dryRun
            ? 'Database and publication unchanged.'
            : result.geometry.from === null
              ? 'No saved world. The new seed will be initialized on server start.'
              : result.report.alreadyApplied
                ? 'Database unchanged.'
                : `Operation ${result.operationId}. Items and inventories preserved.`),
      );
      return;
    }
    const prepared = await prepareLayoutWorld(`dist/worlds/${worldId}`, ownership, true);
    const result = await prepared.items.migrateGeometry(prepared.commit);
    console.log(
      result.from === null
        ? `World ${worldId} has no saved state. It will be initialized when the server starts.`
        : result.changed
          ? `World ${worldId} migrated: ${result.from} -> ${result.to}. Items and inventories preserved.`
          : `World ${worldId} already matches the built map.`,
    );
  } catch (error) {
    if (reportFile)
      await writeJson(
        reportFile,
        error instanceof AssetRemapFailure
          ? error.report
          : {
              formatVersion: 1,
              status: 'rejected',
              worldId,
              issues: [
                {
                  kind: 'preparation',
                  message: error instanceof Error ? error.message : 'Unknown error',
                },
              ],
            },
      );
    throw error;
  } finally {
    try {
      await ownership.close();
    } finally {
      await pool.end();
    }
  }
}

await run().catch((error) => {
  console.error(
    'World geometry migration failed:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = 1;
});
