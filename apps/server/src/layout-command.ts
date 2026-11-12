import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadEnvironment, readDatabaseUrl } from './config.js';
import { createDatabasePool } from './database.js';
import { checkDatabaseSchema } from './migrations.js';
import { WorldOwnership } from './world-ownership.js';
import { readAuthoringRelease, createLayoutPublication } from './layout/release.js';
import { StaticLayoutStore } from './layout/store.js';
import { ItemStore } from './items/store.js';
import { createAuthoritativeWorld } from '@su/simulation/server';
import type { WorldLayoutSnapshot } from '@su/contracts';

loadEnvironment();
const [command, ...args] = process.argv.slice(2);
if (command !== 'validate' && command !== 'export') throw new Error('Use validate or export');
const worldId = process.env.SU_WORLD ?? 'ring-block';
if (!/^[a-z0-9-]{1,64}$/.test(worldId)) throw new Error('Invalid SU_WORLD');
if (args.length && (args.length !== 2 || args[0] !== '--file'))
  throw new Error('Expected --file <path>');
const pool = createDatabasePool(readDatabaseUrl());
const owner = new WorldOwnership(pool, worldId, randomUUID());
try {
  await checkDatabaseSchema(pool);
  const release = await readAuthoringRelease(`dist/worlds/${worldId}`);
  await owner.connect();
  const candidate = await new StaticLayoutStore(owner, release).readCandidate(true);
  const file = args[1];
  if (command === 'export') {
    if (!candidate.initialized)
      throw new Error('World layout is not initialized; start or migrate the world first');
    const output = file ?? `dist/layouts/${worldId}.json`;
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        { ...candidate.snapshot, assetReleaseVersion: candidate.previousRelease },
        null,
        2,
      ) + '\n',
    );
    console.log(`Exported ${candidate.snapshot.instances.length} placements to ${output}`);
  } else {
    const snapshot: WorldLayoutSnapshot = file
      ? JSON.parse(await readFile(file, 'utf8'))
      : candidate.snapshot;
    if (snapshot.formatVersion !== 1 || !Array.isArray(snapshot.instances))
      throw new Error('Invalid layout snapshot');
    const { world, publication, hash } = await createLayoutPublication(release, snapshot);
    const physics = await createAuthoritativeWorld({ ...world, initialItems: [] });
    try {
      for (const spawn of world.spawnPoints)
        if (!physics.findSpawn(undefined, [spawn]))
          throw new Error('Static placement blocks a spawn point');
    } finally {
      physics.dispose();
    }
    const items = new ItemStore(pool, world, owner.epoch, owner);
    await items.migrateGeometry(undefined, true);
    console.log(
      `Valid layout: ${snapshot.instances.length} rows, ${world.buildings.length} active/fixed instances, ${publication.manifest.cells.length} cells, hash ${hash}. Database unchanged.`,
    );
  }
} catch (error) {
  console.error(
    'World layout command failed:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = 1;
} finally {
  await owner.close();
  await pool.end();
}
