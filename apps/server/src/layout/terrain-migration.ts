import { resolve } from 'node:path';
import {
  canonicalJson,
  itemPhysicsDefinition,
  validPose,
  validVector,
  type ItemState,
  type WorldDefinition,
  type WorldLayoutSnapshot,
} from '@su/contracts';
import { createAuthoritativeWorld } from '@su/simulation/server';
import { hash, writeWorldPublication } from '@su/world-release';
import { worldCompatibility } from '../items/store.js';
import type { WorldOwnership } from '../world-ownership.js';
import { createLayoutPublication, readAuthoringRelease, type AuthoringRelease } from './release.js';
import { StaticLayoutStore } from './store.js';

export interface TerrainMigrationIssue {
  kind: string;
  message: string;
  entityId?: string;
}
export interface TerrainMigrationContext {
  sourceRelease: AuthoringRelease;
  targetRelease: AuthoringRelease;
  sourceSnapshot: WorldLayoutSnapshot;
  /** Reconstructed from the saved placements, never from the authored seed. */
  sourceWorld: WorldDefinition;
  sourceItems: ItemState[];
}
export interface TerrainMigrationPreparation {
  targetSnapshot: WorldLayoutSnapshot;
  targetItems: ItemState[];
  audit: unknown;
  issues: TerrainMigrationIssue[];
}
export type TerrainMigrationPrepare = (
  context: TerrainMigrationContext,
) => Promise<TerrainMigrationPreparation>;
export interface TerrainMigrationOptions {
  sourceDirectory: string;
  targetDirectory: string;
  ownership: WorldOwnership;
  algorithmVersion: string;
  rulesHash: string;
  prepare: TerrainMigrationPrepare;
}
export interface TerrainMigrationPlan {
  formatVersion: 1;
  status: 'valid' | 'rejected';
  worldId: string;
  algorithmVersion: string;
  rulesHash: string;
  sourceReleaseHash: string;
  targetReleaseHash: string;
  sourceStateHash: string;
  targetStateHash: string | null;
  preservedStateHash: string;
  sourceCompatibility: string;
  targetCompatibility: string | null;
  targetLayoutHash: string | null;
  before: { snapshot: WorldLayoutSnapshot; items: ItemState[] };
  after: { snapshot: WorldLayoutSnapshot; items: ItemState[] };
  audit: unknown;
  issues: TerrainMigrationIssue[];
  planHash: string;
}

/** COMMIT may have succeeded even when its acknowledgement never reached the client. */
export class TerrainMigrationOutcomeUnknownError extends Error {
  override readonly name = 'TerrainMigrationOutcomeUnknownError';
  readonly status = 'outcome-unknown';
  constructor(
    readonly planHash: string,
    readonly operationId: string,
    cause: unknown,
  ) {
    super(
      'Migration COMMIT outcome is unknown. Retry the same accepted plan to check its durable marker; do not create a new plan.',
      { cause },
    );
  }
}

function knownCommitRejection(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  // These PostgreSQL errors prove transaction rejection. Connection failures,
  // statement_completion_unknown (40003), and unrecognized failures do not.
  return (
    typeof error.code === 'string' &&
    /^(?:23[0-9A-Z]{3}|40000|40001|40002|40P01|P000[1-4])$/.test(error.code)
  );
}

interface ItemRow extends Record<string, unknown> {
  id: string;
  type_id: string;
  world_id: string | null;
  physical: ItemState | null;
  placement_version: number;
}
interface RawState {
  world: Record<string, unknown> & { compatibility_hash: string };
  layout: Record<string, unknown>;
  statics: Record<string, unknown>[];
  items: ItemRow[];
  slots: Record<string, unknown>[];
  types: (Record<string, unknown> & { id: string; max_stack: string; physics: unknown })[];
}
const digest = (value: unknown) => hash(canonicalJson(value));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sorted = <T extends { entityId: string }>(values: T[]) =>
  values.slice().sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
const markerId = '__terrain-migration';
const fail = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`Terrain migration: ${message}`);
};

/** Read JSON in PostgreSQL so timestamps retain their full precision in the source hash. */
async function readState(ownership: WorldOwnership, lock = false): Promise<RawState> {
  const db = ownership.db;
  if (lock) {
    await db.query('SELECT id FROM persistent_worlds WHERE id=$1 FOR UPDATE', [ownership.worldId]);
    await db.query('SELECT world_id FROM world_layouts WHERE world_id=$1 FOR UPDATE', [
      ownership.worldId,
    ]);
    await db.query('SELECT id FROM item_instances WHERE world_id=$1 ORDER BY id FOR UPDATE', [
      ownership.worldId,
    ]);
  }
  const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> =>
    (await db.query<{ value: T }>(sql, values)).rows.map((row) => row.value);
  const worlds = await rows<RawState['world']>(
    'SELECT to_jsonb(w) AS value FROM persistent_worlds w WHERE id=$1',
    [ownership.worldId],
  );
  const layouts = await rows<RawState['layout']>(
    'SELECT to_jsonb(l) AS value FROM world_layouts l WHERE world_id=$1',
    [ownership.worldId],
  );
  fail(worlds.length === 1 && layouts.length === 1, 'requires an initialized saved world');
  return {
    world: worlds[0],
    layout: layouts[0],
    statics: await rows(
      'SELECT to_jsonb(s) AS value FROM world_static_instances s WHERE world_id=$1 ORDER BY entity_id',
      [ownership.worldId],
    ),
    // Inventory and unrelated world rows are hashed and checked for preservation, never migrated.
    items: await rows(
      `SELECT to_jsonb(i)||jsonb_build_object('snapshot_sequence',i.snapshot_sequence::text) AS value
      FROM item_instances i ORDER BY id`,
    ),
    slots: await rows(
      `SELECT to_jsonb(s)||jsonb_build_object('position',s.position::text) AS value
      FROM inventory_slots s ORDER BY id`,
    ),
    types: await rows(
      `SELECT to_jsonb(t)||jsonb_build_object('max_stack',t.max_stack::text) AS value
      FROM item_types t ORDER BY id`,
    ),
  };
}

function savedItems(raw: RawState, worldId: string, release: AuthoringRelease): ItemState[] {
  return raw.items
    .filter((row) => row.world_id === worldId)
    .map((row) => {
      const state = row.physical;
      fail(
        state &&
          Object.hasOwn(release.definition.itemCatalog.types, row.type_id) &&
          validPose(state) &&
          validPose(state.safePose) &&
          validVector(state.velocity) &&
          validVector(state.angularVelocity) &&
          Number.isSafeInteger(row.placement_version) &&
          row.placement_version > 0,
        `invalid saved item ${row.id}`,
      );
      return {
        ...state!,
        entityId: row.id,
        kind: 'item' as const,
        typeId: row.type_id,
        placementVersion: row.placement_version,
      };
    });
}

/** Includes every protected column, seed link, property and inventory row. */
function preservedState(raw: RawState, worldId: string, changedItems: Set<string>) {
  return {
    world: { id: raw.world.id, initialized_at: raw.world.initialized_at },
    layout: { seed_version: raw.layout.seed_version, initialized_at: raw.layout.initialized_at },
    items: raw.items.map((row) => {
      if (row.world_id !== worldId || !changedItems.has(row.id)) return row;
      const {
        physical: _p,
        placement_version: _v,
        snapshot_epoch: _e,
        snapshot_sequence: _s,
        ...rest
      } = row;
      return rest;
    }),
    slots: raw.slots,
    types: raw.types,
  };
}

function releaseHash(release: AuthoringRelease) {
  return digest({ metadata: release.metadata, manifest: release.manifest });
}
function checkOptions(options: TerrainMigrationOptions) {
  fail(/^[a-f0-9]{64}$/.test(options.rulesHash), 'rulesHash must be a SHA-256 digest');
  fail(
    typeof options.algorithmVersion === 'string' &&
      options.algorithmVersion.length > 0 &&
      options.algorithmVersion.length <= 200,
    'algorithmVersion is required',
  );
}
async function readReleases(options: TerrainMigrationOptions) {
  const [source, target] = await Promise.all([
    readAuthoringRelease(options.sourceDirectory),
    readAuthoringRelease(options.targetDirectory),
  ]);
  fail(
    source.definition.worldId === options.ownership.worldId &&
      target.definition.worldId === options.ownership.worldId,
    'release and ownership world IDs differ',
  );
  fail(
    source.metadata.assetReleaseVersion !== target.metadata.assetReleaseVersion,
    'source and target releases must differ',
  );
  return { source, target };
}

/** Restrict this migration to heights; identity, enabled state, X/Z and rotations are immutable. */
function prepareHeights(
  source: WorldLayoutSnapshot,
  sourceItems: ItemState[],
  prepared: TerrainMigrationPreparation,
  target: AuthoringRelease,
) {
  const candidate = structuredClone(prepared.targetSnapshot);
  fail(
    same(
      { ...candidate, assetReleaseVersion: source.assetReleaseVersion, instances: [] },
      { ...source, instances: [] },
    ) && candidate.assetReleaseVersion === target.metadata.assetReleaseVersion,
    'planner changed layout identity, seed version or revision',
  );
  const instances = sorted(candidate.instances),
    before = sorted(source.instances);
  fail(instances.length === before.length, 'planner added or removed static instances');
  let changes = 0;
  instances.forEach((instance, index) => {
    const previous = before[index];
    fail(
      Number.isFinite(instance.position.y) &&
        same({ ...instance, position: previous.position }, previous) &&
        instance.position.x === previous.position.x &&
        instance.position.z === previous.position.z,
      `planner changed more than static height: ${previous.entityId}`,
    );
    if (instance.position.y !== previous.position.y) {
      changes++;
      instance.instanceRevision++;
      fail(instance.instanceRevision <= 2147483647, 'static revision overflow');
    }
  });
  candidate.instances = instances;
  candidate.revision += changes + 1; // Catalog cutover and each changed row trigger a revision.
  fail(candidate.revision <= 2147483647, 'layout revision overflow');
  const items = sorted(structuredClone(prepared.targetItems)),
    oldItems = sorted(sourceItems),
    changedItems = new Set<string>();
  fail(items.length === oldItems.length, 'planner added or removed world items');
  items.forEach((item, index) => {
    const previous = oldItems[index];
    fail(
      validPose(item) &&
        validPose(item.safePose) &&
        item.position.x === previous.position.x &&
        item.position.z === previous.position.z &&
        item.safePose.position.x === previous.safePose.position.x &&
        item.safePose.position.z === previous.safePose.position.z &&
        same(
          {
            ...item,
            position: previous.position,
            safePose: { ...item.safePose, position: previous.safePose.position },
          },
          previous,
        ),
      `planner changed more than item heights: ${previous.entityId}`,
    );
    if (!same(item, previous)) {
      changedItems.add(item.entityId);
      item.placementVersion++;
      fail(item.placementVersion <= 2147483647, 'item placement version overflow');
    }
  });
  return { snapshot: candidate, items, changedItems };
}

async function preparePlan(
  options: TerrainMigrationOptions,
  releases: Awaited<ReturnType<typeof readReleases>>,
  raw: RawState,
) {
  const { source, target } = releases;
  const before = await new StaticLayoutStore(options.ownership, source).readCandidate();
  fail(before.initialized, 'requires an initialized saved layout');
  const sourcePublication = await createLayoutPublication(source, before.snapshot);
  const sourceCompatibility = worldCompatibility(sourcePublication.world);
  fail(raw.world.compatibility_hash === sourceCompatibility, 'source geometry is not accepted');
  const sourceItems = sorted(savedItems(raw, options.ownership.worldId, source));
  for (const type of raw.types) {
    if (!raw.items.some((item) => item.type_id === type.id)) continue;
    const next = target.definition.itemCatalog.types[type.id];
    fail(
      next &&
        same(type.physics, itemPhysicsDefinition(next)) &&
        type.max_stack === String(next.maxStack),
      `saved item type or stack limit changed: ${type.id}`,
    );
  }
  const prepared = await options.prepare({
    sourceRelease: structuredClone(source),
    targetRelease: structuredClone(target),
    sourceSnapshot: structuredClone(before.snapshot),
    sourceWorld: structuredClone(sourcePublication.world),
    sourceItems: structuredClone(sourceItems),
  });
  fail(Array.isArray(prepared.issues), 'planner must return an issues array');
  const after = prepareHeights(before.snapshot, sourceItems, prepared, target);
  const preservedStateHash = digest(
    preservedState(raw, options.ownership.worldId, after.changedItems),
  );
  const issues = structuredClone(prepared.issues);
  let publication: Awaited<ReturnType<typeof createLayoutPublication>> | undefined;
  if (!issues.length) {
    try {
      publication = await createLayoutPublication(target, after.snapshot);
      const physics = await createAuthoritativeWorld({ ...publication.world, initialItems: [] });
      try {
        for (const spawn of publication.world.spawnPoints)
          if (!physics.findSpawn(undefined, [spawn]))
            issues.push({ kind: 'spawn', message: 'Target spawn has no free supported capsule' });
        for (const item of after.items) {
          const error = physics.checkSavedItem(item);
          if (error) issues.push({ kind: 'item-pose', entityId: item.entityId, message: error });
        }
      } finally {
        physics.dispose();
      }
    } catch (error) {
      issues.push({ kind: 'target-geometry', message: String(error) });
    }
  }
  const targetCompatibility = publication ? worldCompatibility(publication.world) : null;
  const value: Omit<TerrainMigrationPlan, 'planHash'> = {
    formatVersion: 1,
    status: issues.length ? 'rejected' : 'valid',
    worldId: options.ownership.worldId,
    algorithmVersion: options.algorithmVersion,
    rulesHash: options.rulesHash,
    sourceReleaseHash: releaseHash(source),
    targetReleaseHash: releaseHash(target),
    sourceStateHash: digest(raw),
    targetStateHash: publication
      ? digest({
          snapshot: after.snapshot,
          items: after.items,
          preservedStateHash,
          targetCompatibility,
        })
      : null,
    preservedStateHash,
    sourceCompatibility,
    targetCompatibility,
    targetLayoutHash: publication?.hash ?? null,
    before: { snapshot: before.snapshot, items: sourceItems },
    after: { snapshot: after.snapshot, items: after.items },
    audit: prepared.audit ?? null,
    issues,
  };
  const plan: TerrainMigrationPlan = { ...value, planHash: digest(value) };
  return { plan, publication, changedItems: after.changedItems };
}

/** Read-only consistent snapshot. No files, markers, rows, epochs or revisions are written. */
export async function planTerrainMigration(
  options: TerrainMigrationOptions,
): Promise<TerrainMigrationPlan> {
  checkOptions(options);
  const releases = await readReleases(options);
  await options.ownership.connect();
  const db = options.ownership.db;
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const result = await preparePlan(options, releases, await readState(options.ownership));
    await db.query('ROLLBACK');
    return result.plan;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function operationId(planHash: string) {
  return `${planHash.slice(0, 8)}-${planHash.slice(8, 12)}-5${planHash.slice(13, 16)}-a${planHash.slice(17, 20)}-${planHash.slice(20, 32)}`;
}

/** Offline atomic cutover; a durable marker makes retries safe even after later gameplay. */
export async function applyTerrainMigration(
  options: TerrainMigrationOptions,
  accepted: TerrainMigrationPlan,
) {
  checkOptions(options);
  const plan = structuredClone(accepted),
    { planHash, ...body } = plan;
  fail(
    plan.formatVersion === 1 &&
      plan.status === 'valid' &&
      !plan.issues.length &&
      /^[a-f0-9]{64}$/.test(planHash) &&
      digest(body) === planHash &&
      plan.worldId === options.ownership.worldId &&
      plan.rulesHash === options.rulesHash &&
      plan.algorithmVersion === options.algorithmVersion,
    'requires an intact, matching valid plan',
  );
  const releases = await readReleases(options);
  fail(
    plan.sourceReleaseHash === releaseHash(releases.source) &&
      plan.targetReleaseHash === releaseHash(releases.target),
    'release changed since planning',
  );
  await options.ownership.connect();
  const db = options.ownership.db,
    id = operationId(planHash);
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    const marker = await db.query<{
      after_state: { planHash: string; targetStateHash: string; committedStateHash: string };
    }>(
      'SELECT after_state FROM world_static_operations WHERE world_id=$1 AND operation_id=$2 AND entity_id=$3',
      [plan.worldId, id, markerId],
    );
    if (marker.rowCount) {
      fail(
        marker.rows[0].after_state.planHash === planHash &&
          marker.rows[0].after_state.targetStateHash === plan.targetStateHash,
        'operation ID conflicts with a different migration',
      );
      const current = await readState(options.ownership);
      await db.query('ROLLBACK');
      return {
        plan,
        operationId: id,
        alreadyApplied: true,
        currentStateMatches: digest(current) === marker.rows[0].after_state.committedStateHash,
      };
    }
    const raw = await readState(options.ownership, true);
    fail(digest(raw) === plan.sourceStateHash, 'saved state changed since planning');
    const prepared = await preparePlan(options, releases, raw);
    fail(same(prepared.plan, plan), 'recomputed migration differs from the accepted plan');
    fail(
      prepared.publication && plan.targetCompatibility && plan.targetLayoutHash,
      'target is not valid',
    );
    const beforeTarget = await new StaticLayoutStore(
      options.ownership,
      releases.target,
    ).readCandidate(true);
    const layouts = new StaticLayoutStore(options.ownership, releases.target);
    const stored = await layouts.applyAssetRemap(
      beforeTarget,
      structuredClone(plan.after.snapshot),
      plan.targetLayoutHash!,
      id,
    );
    fail(same(stored, plan.after.snapshot), 'stored layout revisions differ from plan');
    for (const item of plan.after.items) {
      if (!prepared.changedItems.has(item.entityId)) continue;
      const updated = await db.query(
        `UPDATE item_instances SET physical=$4,placement_version=placement_version+1,
        snapshot_epoch=$5,snapshot_sequence=-1 WHERE id=$1 AND world_id=$2 AND placement_version=$3`,
        [item.entityId, plan.worldId, item.placementVersion - 1, item, options.ownership.epoch],
      );
      fail(updated.rowCount === 1, `item changed during migration: ${item.entityId}`);
    }
    await db.query('UPDATE persistent_worlds SET compatibility_hash=$2,epoch=$3 WHERE id=$1', [
      plan.worldId,
      plan.targetCompatibility,
      options.ownership.epoch,
    ]);
    const after = await readState(options.ownership);
    fail(
      digest(preservedState(after, plan.worldId, prepared.changedItems)) ===
        plan.preservedStateHash,
      'protected rows or inventory changed during migration',
    );
    fail(
      digest({
        snapshot: stored,
        items: sorted(savedItems(after, plan.worldId, releases.target)),
        preservedStateHash: plan.preservedStateHash,
        targetCompatibility: after.world.compatibility_hash,
      }) === plan.targetStateHash,
      'stored target state differs from plan',
    );
    // Publication is immutable. A subsequent SQL/commit failure leaves only inactive files.
    await writeWorldPublication(
      prepared.publication!.publication,
      resolve(
        options.targetDirectory,
        'layouts',
        releases.target.metadata.assetReleaseVersion,
        plan.targetLayoutHash!,
      ),
    );
    await db.query(
      `INSERT INTO world_static_operations(world_id,operation_id,entity_id,source,before_state,after_state,layout_revision)
      VALUES($1,$2,$3,'migration',$4,$5,$6)`,
      [
        plan.worldId,
        id,
        markerId,
        {
          planHash,
          sourceStateHash: plan.sourceStateHash,
          sourceReleaseHash: plan.sourceReleaseHash,
        },
        {
          planHash,
          targetStateHash: plan.targetStateHash,
          targetReleaseHash: plan.targetReleaseHash,
          committedStateHash: digest(after),
        },
        stored.revision,
      ],
    );
    try {
      await db.query('COMMIT');
    } catch (error) {
      if (knownCommitRejection(error)) throw error;
      throw new TerrainMigrationOutcomeUnknownError(planHash, id, error);
    }
    return { plan, operationId: id, alreadyApplied: false, currentStateMatches: true };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
