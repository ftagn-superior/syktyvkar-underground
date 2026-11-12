import pg from 'pg';

export function createDatabasePool(
  connectionString: string,
  settings: Pick<pg.PoolConfig, 'options'> = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    application_name: 'syktyvkar-underground',
    ...settings,
  });
  pool.on('error', () => console.error('PostgreSQL connection failed.'));
  return pool;
}
