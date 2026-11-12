import { randomUUID } from 'node:crypto';
import { loadEnvironment, readDatabaseUrl } from './config.js';
import { createDatabasePool } from './database.js';
import { checkDatabaseSchema } from './migrations.js';
import { WorldOwnership } from './world-ownership.js';
import { prepareLayoutWorld } from './layout/prepare.js';

loadEnvironment();
const worldId = process.env.SU_WORLD ?? 'ring-block';
if (!/^[a-z0-9-]{1,64}$/.test(worldId)) throw new Error('SU_WORLD must be a world ID');
const pool = createDatabasePool(readDatabaseUrl());
const ownership = new WorldOwnership(pool, worldId, randomUUID());
try {
  await checkDatabaseSchema(pool);
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
  console.error(
    'World geometry migration failed:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = 1;
} finally {
  try {
    await ownership.close();
  } finally {
    await pool.end();
  }
}
