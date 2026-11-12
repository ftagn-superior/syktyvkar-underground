/** Additive placement schema. No existing items, inventories, accounts or hashes are rewritten. */
export const staticLayoutSchema = `
CREATE TABLE world_layouts (
  world_id text PRIMARY KEY REFERENCES persistent_worlds(id),
  asset_release_version text NOT NULL CHECK(asset_release_version ~ '^[a-f0-9]{64}$'),
  seed_version text NOT NULL CHECK(seed_version ~ '^[a-f0-9]{64}$'),
  asset_ids text[] NOT NULL,
  fixed_entity_ids text[] NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  validated_revision integer CHECK(validated_revision > 0),
  validated_hash text CHECK(validated_hash ~ '^[a-f0-9]{64}$'),
  initialized_at timestamptz NOT NULL DEFAULT now(),
  CHECK((validated_revision IS NULL) = (validated_hash IS NULL)),
  CHECK(validated_revision IS NULL OR validated_revision = revision)
);
CREATE FUNCTION su_finite(value double precision) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value > '-Infinity'::double precision AND value < 'Infinity'::double precision
$$;
CREATE TABLE world_static_instances (
  world_id text NOT NULL REFERENCES world_layouts(world_id),
  entity_id text NOT NULL CHECK(entity_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  asset_id text NOT NULL CHECK(asset_id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  position_x double precision NOT NULL CHECK(su_finite(position_x)),
  position_y double precision NOT NULL CHECK(su_finite(position_y)),
  position_z double precision NOT NULL CHECK(su_finite(position_z)),
  rotation_x double precision NOT NULL CHECK(su_finite(rotation_x)),
  rotation_y double precision NOT NULL CHECK(su_finite(rotation_y)),
  rotation_z double precision NOT NULL CHECK(su_finite(rotation_z)),
  rotation_w double precision NOT NULL CHECK(su_finite(rotation_w)),
  instance_revision integer NOT NULL DEFAULT 1 CHECK(instance_revision > 0),
  enabled boolean NOT NULL DEFAULT true,
  source_ref jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(world_id,entity_id),
  CHECK(abs(rotation_x*rotation_x + rotation_y*rotation_y + rotation_z*rotation_z + rotation_w*rotation_w - 1) < 0.000001),
  CHECK(source_ref IS NULL OR (jsonb_typeof(source_ref)='object'
    AND source_ref ?& ARRAY['provider','type','id']
    AND jsonb_typeof(source_ref->'provider')='string' AND char_length(source_ref->>'provider') BETWEEN 1 AND 200
    AND jsonb_typeof(source_ref->'type')='string' AND char_length(source_ref->>'type') BETWEEN 1 AND 200
    AND jsonb_typeof(source_ref->'id')='string' AND char_length(source_ref->>'id') BETWEEN 1 AND 200))
);
CREATE TABLE world_static_operations (
  world_id text NOT NULL REFERENCES world_layouts(world_id),
  operation_id uuid NOT NULL,
  entity_id text NOT NULL,
  source text NOT NULL CHECK(source IN ('sql','seed','migration')),
  account_id uuid REFERENCES accounts(id),
  before_state jsonb,
  after_state jsonb,
  layout_revision integer NOT NULL CHECK(layout_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(world_id,operation_id,entity_id)
);
CREATE FUNCTION world_static_before_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; catalog text[]; fixed text[];
BEGIN
  target := CASE WHEN TG_OP='DELETE' THEN OLD.world_id ELSE NEW.world_id END;
  IF NOT pg_try_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':' || target,193708)) THEN
    RAISE EXCEPTION 'Stop the world before editing static placement';
  END IF;
  SELECT asset_ids,fixed_entity_ids INTO STRICT catalog,fixed FROM world_layouts WHERE world_id=target FOR UPDATE;
  IF TG_OP<>'INSERT' AND (TG_OP='DELETE' OR NEW.world_id<>OLD.world_id OR NEW.entity_id<>OLD.entity_id) THEN
    IF TG_OP<>'DELETE' THEN RAISE EXCEPTION 'Static identity is immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.entity_id=ANY(fixed) THEN RAISE EXCEPTION 'Fixed placement ID is reserved'; END IF;
  IF NOT NEW.asset_id=ANY(catalog) THEN RAISE EXCEPTION 'Unknown static asset'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.asset_id,NEW.position_x,NEW.position_y,NEW.position_z,NEW.rotation_x,NEW.rotation_y,NEW.rotation_z,NEW.rotation_w,NEW.enabled,NEW.source_ref)
      IS NOT DISTINCT FROM ROW(OLD.asset_id,OLD.position_x,OLD.position_y,OLD.position_z,OLD.rotation_x,OLD.rotation_y,OLD.rotation_z,OLD.rotation_w,OLD.enabled,OLD.source_ref) THEN RETURN NULL; END IF;
    NEW.instance_revision := OLD.instance_revision+1;
  ELSE NEW.instance_revision := 1;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER world_static_before BEFORE INSERT OR UPDATE OR DELETE ON world_static_instances
  FOR EACH ROW EXECUTE FUNCTION world_static_before_change();
CREATE FUNCTION world_static_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; entity text; next_revision integer; operation uuid; origin text;
BEGIN
  target := CASE WHEN TG_OP='DELETE' THEN OLD.world_id ELSE NEW.world_id END;
  entity := CASE WHEN TG_OP='DELETE' THEN OLD.entity_id ELSE NEW.entity_id END;
  UPDATE world_layouts SET revision=revision+1,validated_revision=NULL,validated_hash=NULL WHERE world_id=target RETURNING revision INTO next_revision;
  operation := COALESCE(NULLIF(current_setting('su.layout_operation',true),'' )::uuid,gen_random_uuid());
  origin := COALESCE(NULLIF(current_setting('su.layout_source',true),''),'sql');
  INSERT INTO world_static_operations(world_id,operation_id,entity_id,source,before_state,after_state,layout_revision)
    VALUES(target,operation,entity,origin,CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
      CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,next_revision)
    ON CONFLICT(world_id,operation_id,entity_id) DO UPDATE SET after_state=EXCLUDED.after_state,layout_revision=EXCLUDED.layout_revision;
  RETURN NULL;
END $$;
CREATE TRIGGER world_static_after AFTER INSERT OR UPDATE OR DELETE ON world_static_instances
  FOR EACH ROW EXECUTE FUNCTION world_static_after_change();
CREATE FUNCTION world_layout_before_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':' || OLD.world_id,193708)) THEN
    RAISE EXCEPTION 'Stop the world before editing static placement';
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'The initialized layout marker cannot be deleted'; END IF;
  IF NEW.world_id<>OLD.world_id OR NEW.seed_version<>OLD.seed_version OR NEW.initialized_at<>OLD.initialized_at THEN
    RAISE EXCEPTION 'Layout initialization identity is immutable';
  END IF;
  IF ROW(NEW.asset_release_version,NEW.asset_ids,NEW.fixed_entity_ids) IS DISTINCT FROM ROW(OLD.asset_release_version,OLD.asset_ids,OLD.fixed_entity_ids) THEN
    NEW.revision:=OLD.revision+1; NEW.validated_revision:=NULL; NEW.validated_hash:=NULL;
  END IF;
  IF NEW.revision<OLD.revision THEN RAISE EXCEPTION 'Layout revision cannot decrease'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_layout_before BEFORE UPDATE OR DELETE ON world_layouts FOR EACH ROW EXECUTE FUNCTION world_layout_before_change();
`;
