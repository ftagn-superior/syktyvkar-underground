import { loadEnvironment } from './config.js';
import { createDatabasePool } from './database.js';
import { migrateDatabase } from './migrations.js';

loadEnvironment();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = createDatabasePool(process.env.DATABASE_URL);
try {
  await migrateDatabase(pool);
  console.log('Database migrations applied.');
} catch {
  console.error(
    'Database migration failed. Check PostgreSQL availability, role permissions and database schema.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
