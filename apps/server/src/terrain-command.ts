import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '@su/contracts';
import { hash } from '@su/world-release';
import { loadEnvironment, readDatabaseUrl } from './config.js';
import { createDatabasePool } from './database.js';
import { checkDatabaseSchema } from './migrations.js';
import { WorldOwnership } from './world-ownership.js';
import type { TerrainMigrationPlan } from './layout/terrain-migration.js';
import type { TerrainPoseRules } from './layout/terrain-poses.js';

// This command reserves stdout for one machine-readable result. Physics-engine
// diagnostics (including its NullEngine startup message) belong on stderr.
console.log = (...values: unknown[]) => console.error(...values);
const summary = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

async function readJson(path: string) {
  const limit = 64 * 1024 * 1024;
  if ((await stat(path)).size > limit) throw new Error('Terrain migration input exceeds 64 MiB');
  const bytes = await readFile(path);
  if (bytes.byteLength > limit) throw new Error('Terrain migration input exceeds 64 MiB');
  return JSON.parse(bytes.toString('utf8'));
}
async function writeReport(path: string, report: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    // Replace the output atomically, without following a final symlink/hard link.
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(await canonicalPath(dirname(path)), basename(path));
  }
}
async function validateReportPath(options: Map<string, string>) {
  const report = await canonicalPath(options.get('--report')!);
  for (const key of ['--rules', '--plan']) {
    const input = options.get(key);
    if (input && report === (await canonicalPath(input)))
      throw new Error('Report output must differ from rules and accepted plan');
  }
  for (const key of ['--source', '--target']) {
    const directory = await canonicalPath(options.get(key)!);
    const path = relative(directory, report);
    if (path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path)))
      throw new Error('Report output must be outside source and target release directories');
  }
}

async function run() {
  const [command, ...raw] = process.argv.slice(2);
  if (command !== 'plan' && command !== 'apply') throw new Error('Use terrain plan or apply');
  const args = raw[0] === '--' ? raw.slice(1) : raw;
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i],
      value = args[++i];
    if (
      !['--source', '--target', '--rules', '--report', '--plan'].includes(key) ||
      options.has(key)
    )
      throw new Error(`Unexpected terrain argument: ${key}`);
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options.set(key, resolve(value));
  }
  for (const key of ['--source', '--target', '--rules', '--report'])
    if (!options.has(key)) throw new Error(`Required terrain argument: ${key}`);
  if ((command === 'apply') !== options.has('--plan'))
    throw new Error('Apply requires --plan; plan creates a new read-only report');
  const reportFile = options.get('--report')!;
  await validateReportPath(options);
  const rules = (await readJson(options.get('--rules')!)) as TerrainPoseRules;
  const accepted = options.has('--plan')
    ? ((await readJson(options.get('--plan')!)) as TerrainMigrationPlan)
    : undefined;
  loadEnvironment();
  const worldId = process.env.SU_WORLD ?? 'ring-block';
  if (!/^[a-z0-9-]{1,64}$/.test(worldId)) throw new Error('Invalid SU_WORLD');
  // Load physics after routing diagnostics: Babylon captures its log destination
  // at module initialization. The imports remain part of the standalone bundle.
  const [
    { planTerrainMigration, applyTerrainMigration, TerrainMigrationOutcomeUnknownError },
    { prepareTerrainPoses },
  ] = await Promise.all([
    import('./layout/terrain-migration.js'),
    import('./layout/terrain-poses.js'),
  ]);
  const pool = createDatabasePool(readDatabaseUrl());
  const ownership = new WorldOwnership(pool, worldId, randomUUID());
  let applied: Awaited<ReturnType<typeof applyTerrainMigration>> | undefined;
  try {
    await checkDatabaseSchema(pool);
    const migration = {
      sourceDirectory: options.get('--source')!,
      targetDirectory: options.get('--target')!,
      ownership,
      algorithmVersion: 'terrain-poses/1',
      rulesHash: hash(canonicalJson(rules)),
      prepare: (context: Parameters<typeof prepareTerrainPoses>[0]) =>
        prepareTerrainPoses(context, rules),
    };
    if (command === 'plan') {
      const plan = await planTerrainMigration(migration);
      await writeReport(reportFile, plan);
      summary({
        status: plan.status,
        planHash: plan.planHash,
        issues: plan.issues.length,
        databaseChanged: false,
        publicationWritten: false,
        report: reportFile,
      });
      if (plan.status !== 'valid') process.exitCode = 1;
    } else {
      const result = await applyTerrainMigration(migration, accepted!);
      applied = result;
      await writeReport(reportFile, result);
      summary({
        status: result.alreadyApplied ? 'already-applied' : 'applied',
        operationId: result.operationId,
        currentStateMatches: result.currentStateMatches,
        planHash: result.plan.planHash,
        report: reportFile,
      });
    }
  } catch (error) {
    if (error instanceof TerrainMigrationOutcomeUnknownError) {
      const report = {
        formatVersion: 1,
        status: error.status,
        worldId,
        planHash: error.planHash,
        operationId: error.operationId,
        recovery: 'retry-same-accepted-plan',
        message: error.message,
      };
      try {
        await writeReport(reportFile, report);
      } catch (reportError) {
        console.error(
          'Terrain unknown-outcome report could not be written:',
          reportError instanceof Error ? reportError.message : 'Unknown error',
        );
      }
      summary({ ...report, report: reportFile });
      throw error;
    }
    if (applied) {
      // A successful COMMIT cannot be turned into a rejection by an output failure.
      summary({
        status: 'applied-report-failed',
        operationId: applied.operationId,
        alreadyApplied: applied.alreadyApplied,
        currentStateMatches: applied.currentStateMatches,
        planHash: applied.plan.planHash,
        report: reportFile,
      });
      throw new Error(
        'Migration is already applied; report writing failed. Retry the accepted plan to recover its report.',
        { cause: error },
      );
    }
    try {
      await writeReport(reportFile, {
        formatVersion: 1,
        status: 'rejected',
        worldId,
        issues: [
          {
            kind: 'preparation-or-apply',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        ],
      });
    } catch (reportError) {
      console.error(
        'Terrain rejection report could not be written:',
        reportError instanceof Error ? reportError.message : 'Unknown error',
      );
    }
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
    'Terrain migration failed:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = 1;
});
