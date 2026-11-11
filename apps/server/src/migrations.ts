import type { Pool } from 'pg';

export const DATABASE_SCHEMA_VERSION = 2;

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
  {
    version: 2,
    sql: `
    CREATE TABLE persistent_worlds (
      id text PRIMARY KEY,
      compatibility_hash text NOT NULL,
      initialized_at timestamptz NOT NULL DEFAULT now(),
      epoch uuid NOT NULL
    );
    CREATE TABLE inventory_slots (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES accounts(id),
      position bigint NOT NULL CHECK(position >= 0),
      UNIQUE(account_id, position) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE item_types (
      id text PRIMARY KEY,
      max_stack bigint NOT NULL CHECK(max_stack >= 1),
      physics jsonb NOT NULL
    );
    CREATE TABLE item_instances (
      id text PRIMARY KEY,
      type_id text NOT NULL REFERENCES item_types(id),
      properties jsonb NOT NULL DEFAULT '{}',
      world_id text REFERENCES persistent_worlds(id),
      slot_id uuid REFERENCES inventory_slots(id),
      physical jsonb,
      placement_version integer NOT NULL CHECK(placement_version > 0),
      snapshot_epoch uuid,
      snapshot_sequence bigint NOT NULL DEFAULT -1,
      seed_world_id text REFERENCES persistent_worlds(id),
      seed_id text,
      UNIQUE(seed_world_id, seed_id),
      CHECK ((world_id IS NOT NULL AND slot_id IS NULL AND physical IS NOT NULL)
        OR (world_id IS NULL AND slot_id IS NOT NULL AND physical IS NULL)),
      CHECK(jsonb_typeof(properties)='object'),
      CHECK(physical IS NULL OR (jsonb_typeof(physical)='object' AND
        physical ?& ARRAY['position','rotation','velocity','angularVelocity','safePose']))
    );
    CREATE INDEX item_instances_world_idx ON item_instances(world_id);
    CREATE INDEX item_instances_slot_idx ON item_instances(slot_id);
    CREATE FUNCTION validate_inventory_slot(slot uuid) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE members bigint; variants bigint; capacity bigint;
    BEGIN
      IF slot IS NULL OR NOT EXISTS(SELECT 1 FROM inventory_slots WHERE id=slot) THEN RETURN; END IF;
      SELECT count(*), count(DISTINCT (i.type_id,i.properties)), min(t.max_stack)
        INTO members,variants,capacity FROM item_instances i JOIN item_types t ON t.id=i.type_id WHERE i.slot_id=slot;
      IF members=0 OR variants<>1 OR members>capacity THEN
        RAISE EXCEPTION 'Invalid inventory stack' USING ERRCODE='check_violation';
      END IF;
    END $$;
    CREATE FUNCTION validate_item_stack_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP<>'INSERT' THEN PERFORM validate_inventory_slot(OLD.slot_id); END IF;
      IF TG_OP<>'DELETE' THEN PERFORM validate_inventory_slot(NEW.slot_id); END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER item_stack_constraint AFTER INSERT OR UPDATE OR DELETE ON item_instances
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_item_stack_trigger();
    CREATE FUNCTION validate_slot_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM validate_inventory_slot(NEW.id); RETURN NULL; END $$;
    CREATE CONSTRAINT TRIGGER inventory_slot_constraint AFTER INSERT OR UPDATE ON inventory_slots
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_slot_trigger();
    CREATE FUNCTION validate_item_type_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE slot uuid;
    BEGIN
      FOR slot IN SELECT DISTINCT slot_id FROM item_instances WHERE type_id=NEW.id AND slot_id IS NOT NULL LOOP
        PERFORM validate_inventory_slot(slot);
      END LOOP;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER item_type_stack_constraint AFTER UPDATE ON item_types
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_item_type_trigger();
    CREATE TABLE item_operations (
      account_id uuid NOT NULL REFERENCES accounts(id),
      operation_id text NOT NULL,
      world_id text NOT NULL REFERENCES persistent_worlds(id),
      request jsonb NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(account_id, operation_id)
    );
  `,
  },
];

export async function migrateDatabase(pool: Pool): Promise<void> {
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
    if (applied.rows.some((row) => row.version > DATABASE_SCHEMA_VERSION))
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

export async function checkDatabaseSchema(pool: Pool): Promise<void> {
  const table = await pool.query("SELECT to_regclass('su_schema_migrations') AS name");
  if (!table.rows[0].name) throw new Error('Run pnpm db:migrate before starting the world.');
  const versions = await pool.query<{ version: number }>(
    'SELECT version FROM su_schema_migrations ORDER BY version',
  );
  if (
    versions.rows.length !== DATABASE_SCHEMA_VERSION ||
    versions.rows.at(-1)?.version !== DATABASE_SCHEMA_VERSION
  )
    throw new Error('Database schema does not match this server. Run pnpm db:migrate.');
}
