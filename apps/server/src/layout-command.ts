import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createWorldLayoutPatch,
  validateWorldLayoutPatch,
  validateWorldLayoutSnapshot,
  type WorldLayoutPatch,
} from '@su/contracts';
import { loadEnvironment, readDatabaseUrl } from './config.js';
import { createDatabasePool } from './database.js';
import { checkDatabaseSchema } from './migrations.js';
import { WorldOwnership } from './world-ownership.js';
import { readAuthoringRelease, createLayoutPublication } from './layout/release.js';
import { StaticLayoutStore } from './layout/store.js';
import { ItemStore } from './items/store.js';
import { validateLayoutSpawns } from './layout/prepare.js';
import { applyStaticLayoutPatch } from './layout/patch.js';

const maxFileBytes = 16 * 1024 * 1024;
async function readJson(file: string): Promise<unknown> {
  if ((await stat(file)).size > maxFileBytes)
    throw new Error(`Layout file exceeds 16 MiB: ${file}`);
  const bytes = await readFile(file);
  if (bytes.byteLength > maxFileBytes) throw new Error(`Layout file exceeds 16 MiB: ${file}`);
  return JSON.parse(bytes.toString('utf8'));
}
async function writeJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
function describePatch(patch: WorldLayoutPatch) {
  for (const operation of patch.operations)
    console.log(
      operation.op === 'delete'
        ? `DELETE ${operation.entityId} (revision ${operation.expectedRevision})`
        : `${operation.op.toUpperCase()} ${operation.instance.entityId}: ${JSON.stringify(operation.instance)}`,
    );
  return ['add', 'update', 'delete']
    .map((op) => `${patch.operations.filter((operation) => operation.op === op).length} ${op}`)
    .join(', ');
}

async function run() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const allowed: Record<string, string[]> = {
    export: ['--file'],
    validate: ['--file'],
    patch: ['--base', '--edited', '--file'],
    apply: ['--file', '--dry-run'],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error('Use export, validate, patch or apply');
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed[command].includes(key) || options.has(key))
      throw new Error(`Unexpected argument: ${key}`);
    if (key === '--dry-run') options.set(key, 'true');
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options.set(key, value);
    }
  }
  const file = options.get('--file');
  if (command === 'patch') {
    const baseFile = options.get('--base'),
      editedFile = options.get('--edited');
    if (!baseFile || !editedFile || !file)
      throw new Error('Expected --base <export> --edited <candidate> --file <patch>');
    if ([baseFile, editedFile].some((input) => resolve(input) === resolve(file)))
      throw new Error('Patch output must differ from its input files');
    const patch = createWorldLayoutPatch(await readJson(baseFile), await readJson(editedFile));
    const summary = describePatch(patch);
    await writeJson(file, patch);
    console.log(
      `Created patch for ${patch.worldId}, base revision ${patch.baseRevision}: ${summary}. ${file}`,
    );
    return; // File diff is entirely offline: no .env, database or built world is required.
  }
  if (command === 'apply' && !file) throw new Error('Expected --file <patch> [--dry-run]');
  const input = file && command !== 'export' ? await readJson(file) : undefined;
  if (command === 'apply') validateWorldLayoutPatch(input);
  loadEnvironment();
  const worldId = process.env.SU_WORLD ?? 'ring-block';
  if (!/^[a-z0-9-]{1,64}$/.test(worldId)) throw new Error('Invalid SU_WORLD');
  const pool = createDatabasePool(readDatabaseUrl());
  const owner = new WorldOwnership(pool, worldId, randomUUID());
  try {
    await checkDatabaseSchema(pool);
    if (command === 'apply') {
      const dryRun = options.has('--dry-run');
      const result = await applyStaticLayoutPatch(`dist/worlds/${worldId}`, owner, input, dryRun);
      const summary = describePatch(input as WorldLayoutPatch);
      console.log(
        `${dryRun ? 'Valid patch' : 'Applied patch'}: ${summary}; revision ${result.before.revision} -> ${result.snapshot.revision}; hash ${result.hash}. ${dryRun ? 'Database unchanged.' : `Operation ${result.operationId}. Restart the server to load it.`}`,
      );
      return;
    }
    const release = await readAuthoringRelease(`dist/worlds/${worldId}`);
    await owner.connect();
    const candidate = await new StaticLayoutStore(owner, release).readCandidate(true);
    if (command === 'export') {
      if (!candidate.initialized)
        throw new Error('World layout is not initialized; start or migrate the world first');
      const output = file ?? `dist/layouts/${worldId}.json`;
      await writeJson(output, {
        ...candidate.snapshot,
        assetReleaseVersion: candidate.previousRelease,
      });
      console.log(
        `Exported ${candidate.snapshot.instances.length} placements, revision ${candidate.snapshot.revision}, to ${output}`,
      );
    } else {
      const snapshot = file ? input : candidate.snapshot;
      validateWorldLayoutSnapshot(snapshot);
      const { world, publication, hash } = await createLayoutPublication(release, snapshot);
      await validateLayoutSpawns(world);
      const items = new ItemStore(pool, world, owner.epoch, owner);
      await items.migrateGeometry(undefined, true);
      console.log(
        `Valid layout: ${world.buildings.length} active/fixed instances, ${publication.manifest.cells.length} cells, hash ${hash}. Database unchanged.`,
      );
    }
  } finally {
    try {
      await owner.close();
    } finally {
      await pool.end();
    }
  }
}

await run().catch((error) => {
  console.error(
    'World layout command failed:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = 1;
});
