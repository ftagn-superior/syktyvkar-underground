import { randomUUID } from 'node:crypto';
import { loadEnvironment, readDatabaseUrl } from './config.js';
import { createDatabasePool } from './database.js';
import { checkDatabaseSchema } from './migrations.js';
import { readWorldDirectory } from './world-bundle.js';
import { ItemStore } from './items/store.js';

loadEnvironment();
const worldId = process.env.SU_WORLD ?? 'ring-block';
if (!/^[a-z0-9-]{1,64}$/.test(worldId)) throw new Error('SU_WORLD must be a world ID');
const pool = createDatabasePool(readDatabaseUrl());
let store: ItemStore | undefined;
try {
  await checkDatabaseSchema(pool);
  const { definition } = await readWorldDirectory(`dist/worlds/${worldId}`);
  store = new ItemStore(pool, definition, randomUUID());
  const result = await store.migrateGeometry();
  console.log(
    result.changed
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
    await store?.close();
  } finally {
    await pool.end();
  }
}
