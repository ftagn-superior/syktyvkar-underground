import type { Pool } from 'pg';

export const ACCOUNT_SCHEMA_VERSION = 1;

/** Kept in the server bundle so source and built migration commands use identical SQL. */
const migrations = [
  {
    version: 1,
    sql: `
  CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE account_identities (
    issuer text NOT NULL,
    subject text NOT NULL,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (issuer, subject)
  );
  CREATE INDEX account_identities_account_idx ON account_identities(account_id);
  CREATE TABLE player_profiles (
    account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 24),
    color_id text NOT NULL CHECK (color_id IN ('mint','amber','indigo','rose','lime','sky','lilac','coral')),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );
  CREATE INDEX auth_sessions_account_idx ON auth_sessions(account_id);
  CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
`,
  },
];

export async function migrateAccounts(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(193707, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS su_schema_migrations (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ version: number }>(
      'SELECT version FROM su_schema_migrations ORDER BY version',
    );
    if (applied.rows.some((row) => row.version > ACCOUNT_SCHEMA_VERSION))
      throw new Error('Database schema is newer than this server.');
    for (const migration of migrations) {
      if (applied.rows.some((row) => row.version === migration.version)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO su_schema_migrations(version) VALUES ($1)', [
        migration.version,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function checkAccountSchema(pool: Pool): Promise<void> {
  const table = await pool.query("SELECT to_regclass('su_schema_migrations') AS name");
  if (!table.rows[0].name) throw new Error('Run pnpm db:migrate before starting accounts.');
  const versions = await pool.query<{ version: number }>(
    'SELECT version FROM su_schema_migrations ORDER BY version',
  );
  if (
    versions.rows.length !== ACCOUNT_SCHEMA_VERSION ||
    versions.rows.at(-1)?.version !== ACCOUNT_SCHEMA_VERSION
  )
    throw new Error('Account schema does not match this server. Run pnpm db:migrate.');
}
