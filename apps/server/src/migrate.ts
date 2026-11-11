import { loadEnvironment } from './config.js';
import { createAccountPool } from './accounts/store.js';
import { migrateAccounts } from './accounts/migrations.js';

loadEnvironment();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = createAccountPool(process.env.DATABASE_URL);
try {
  await migrateAccounts(pool);
  console.log('Account database migrations applied.');
} catch {
  console.error(
    'Account migration failed. Check PostgreSQL availability, role permissions and database schema.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
