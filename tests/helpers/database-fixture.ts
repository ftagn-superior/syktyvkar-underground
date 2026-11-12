import { randomBytes } from 'node:crypto';
import { createDatabasePool } from '../../apps/server/src/database.js';
import { migrateDatabase } from '../../apps/server/src/migrations.js';

/** Every test writes only inside a unique disposable schema. */
export async function createDatabaseFixture(databaseUrl = process.env.SU_TEST_DATABASE_URL) {
  if (!databaseUrl) throw new Error('SU_TEST_DATABASE_URL is required for persistent-world tests.');
  const admin = createDatabasePool(databaseUrl),
    schema = 'su_items_' + randomBytes(12).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createDatabasePool(databaseUrl, { options: `-c search_path=${schema}` });
  try {
    await migrateDatabase(pool);
  } catch (error) {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    throw error;
  }
  return {
    pool,
    schema,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
