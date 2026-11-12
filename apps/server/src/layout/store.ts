import { randomUUID } from 'node:crypto';
import {
  applyWorldLayoutPatch,
  canonicalJson,
  placedStaticInstance,
  STATIC_PLACEMENT_COOLDOWN_MS,
  type PlaceStaticRequest,
  type PlaceStaticResult,
  type StaticObjectInstance,
  type WorldLayoutSnapshot,
  type WorldLayoutPatch,
} from '@su/contracts';
import type { WorldOwnership } from '../world-ownership.js';
import { editableStaticAssetIds, type AuthoringRelease } from './release.js';

interface LayoutRow {
  asset_release_version: string;
  seed_version: string;
  revision: number;
}
interface InstanceRow {
  entity_id: string;
  asset_id: string;
  position_x: number;
  position_y: number;
  position_z: number;
  rotation_x: number;
  rotation_y: number;
  rotation_z: number;
  rotation_w: number;
  instance_revision: number;
  enabled: boolean;
  source_ref: StaticObjectInstance['sourceRef'] | null;
}
export class StaticLayoutStore {
  constructor(
    readonly ownership: WorldOwnership,
    readonly release: AuthoringRelease,
  ) {}
  private get db() {
    return this.ownership.db;
  }
  async readCandidate(
    allowReleaseChange = false,
  ): Promise<{ snapshot: WorldLayoutSnapshot; initialized: boolean; previousRelease?: string }> {
    const { worldId } = this.release.definition;
    const found = await this.db.query<LayoutRow>(
      'SELECT asset_release_version,seed_version,revision FROM world_layouts WHERE world_id=$1',
      [worldId],
    );
    const layout = found.rows[0];
    if (
      layout &&
      layout.asset_release_version !== this.release.metadata.assetReleaseVersion &&
      !allowReleaseChange
    )
      throw new Error('Asset release changed. Stop the world and run pnpm world:migrate.');
    const rows = layout
      ? (
          await this.db.query<InstanceRow>(
            'SELECT * FROM world_static_instances WHERE world_id=$1 ORDER BY entity_id',
            [worldId],
          )
        ).rows
      : [];
    const instances: StaticObjectInstance[] = layout
      ? rows.map((row) => ({
          entityId: row.entity_id,
          assetId: row.asset_id,
          position: { x: row.position_x, y: row.position_y, z: row.position_z },
          rotation: { x: row.rotation_x, y: row.rotation_y, z: row.rotation_z, w: row.rotation_w },
          instanceRevision: row.instance_revision,
          enabled: row.enabled,
          ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
        }))
      : structuredClone(this.release.seed);
    return {
      initialized: !!layout,
      previousRelease: layout?.asset_release_version,
      snapshot: {
        formatVersion: 1,
        worldId,
        assetReleaseVersion: this.release.metadata.assetReleaseVersion,
        seedVersion: layout?.seed_version ?? this.release.metadata.seedVersion,
        revision: layout?.revision ?? 1,
        instances,
      },
    };
  }
  /** Called inside the item store's validation/initialization transaction, on the owner session. */
  async commit(
    candidate: Awaited<ReturnType<StaticLayoutStore['readCandidate']>>,
    validatedHash: string,
  ) {
    const { snapshot } = candidate;
    const found = await this.db.query<LayoutRow>(
      'SELECT asset_release_version,seed_version,revision FROM world_layouts WHERE world_id=$1 FOR UPDATE',
      [snapshot.worldId],
    );
    const fixed = [
      ...this.release.metadata.fixedInstanceIds,
      ...this.release.definition.entities.map((i) => i.entityId),
    ].sort();
    const assets = editableStaticAssetIds(this.release);
    if (!candidate.initialized) {
      if (found.rowCount) throw new Error('Static placement was initialized concurrently');
      await this.db.query(
        'INSERT INTO world_layouts(world_id,asset_release_version,seed_version,asset_ids,fixed_entity_ids) VALUES($1,$2,$3,$4,$5)',
        [snapshot.worldId, snapshot.assetReleaseVersion, snapshot.seedVersion, assets, fixed],
      );
      await this.db.query(
        "SELECT set_config('su.layout_operation',$1,true),set_config('su.layout_source','seed',true)",
        [randomUUID()],
      );
      await this.db.query(
        `INSERT INTO world_static_instances(world_id,entity_id,asset_id,position_x,position_y,position_z,rotation_x,rotation_y,rotation_z,rotation_w,enabled,source_ref)
        SELECT $1,x->>'entityId',x->>'assetId',(x->'position'->>'x')::double precision,(x->'position'->>'y')::double precision,(x->'position'->>'z')::double precision,
        (x->'rotation'->>'x')::double precision,(x->'rotation'->>'y')::double precision,(x->'rotation'->>'z')::double precision,(x->'rotation'->>'w')::double precision,
        (x->>'enabled')::boolean,x->'sourceRef' FROM jsonb_array_elements($2::jsonb) AS x`,
        [snapshot.worldId, canonicalJson(snapshot.instances)],
      );
    } else {
      if (
        !found.rowCount ||
        found.rows[0].revision !== snapshot.revision ||
        found.rows[0].asset_release_version !== candidate.previousRelease
      )
        throw new Error('Static placement changed during validation');
      if (candidate.previousRelease !== snapshot.assetReleaseVersion) {
        await this.db.query(
          'UPDATE world_layouts SET asset_release_version=$2,asset_ids=$3,fixed_entity_ids=$4,revision=revision+1,validated_revision=NULL,validated_hash=NULL WHERE world_id=$1',
          [snapshot.worldId, snapshot.assetReleaseVersion, assets, fixed],
        );
        await this.db.query(
          `INSERT INTO world_static_operations(world_id,operation_id,entity_id,source,before_state,after_state,layout_revision)
          SELECT world_id,$2,'__asset-release','migration',$3::jsonb,$4::jsonb,revision FROM world_layouts WHERE world_id=$1`,
          [
            snapshot.worldId,
            randomUUID(),
            JSON.stringify({ assetReleaseVersion: candidate.previousRelease }),
            JSON.stringify({ assetReleaseVersion: snapshot.assetReleaseVersion }),
          ],
        );
      }
    }
    const result = await this.db.query<{ revision: number }>(
      'UPDATE world_layouts SET validated_revision=revision,validated_hash=$2 WHERE world_id=$1 RETURNING revision',
      [snapshot.worldId, validatedHash],
    );
    snapshot.revision = result.rows[0].revision;
    candidate.initialized = true;
    candidate.previousRelease = snapshot.assetReleaseVersion;
  }

  /** History and instance must both exist. Headers are not part of replay identity. */
  async replayGame(
    accountId: string,
    request: PlaceStaticRequest,
  ): Promise<PlaceStaticResult | undefined> {
    const i = placedStaticInstance(request);
    const prior = await this.db.query(
      `SELECT o.*, i.entity_id AS present FROM world_static_operations o
      LEFT JOIN world_static_instances i ON i.world_id=o.world_id AND i.entity_id=o.entity_id
      WHERE o.world_id=$1 AND o.operation_id=$2 AND o.entity_id=$3`,
      [this.release.definition.worldId, request.operationId, i.entityId],
    );
    if (!prior.rowCount) {
      const partial = await this.db.query(
        'SELECT 1 FROM world_static_instances WHERE world_id=$1 AND entity_id=$2',
        [this.release.definition.worldId, i.entityId],
      );
      if (partial.rowCount) throw new Error('Placement has no successful history');
      return;
    }
    const row = prior.rows[0],
      after = row.after_state;
    if (!row.present || !after) throw new Error('Successful placement is incomplete');
    if (
      row.source !== 'game' ||
      row.account_id !== accountId ||
      after.asset_id !== i.assetId ||
      after.position_x !== i.position.x ||
      after.position_y !== i.position.y ||
      after.position_z !== i.position.z ||
      after.rotation_x !== i.rotation.x ||
      after.rotation_y !== i.rotation.y ||
      after.rotation_z !== i.rotation.z ||
      after.rotation_w !== i.rotation.w
    )
      return { operationId: request.operationId, ok: false, code: 'OPERATION_CONFLICT' };
    return {
      operationId: request.operationId,
      ok: true,
      entityId: i.entityId,
      layoutRevision: row.layout_revision,
    };
  }
  async gameRateLimited(accountId: string) {
    return !!(
      await this.db.query(
        `SELECT 1 FROM world_static_operations WHERE world_id=$1
      AND account_id=$2 AND source='game' AND created_at > clock_timestamp() - $3 * INTERVAL '1 millisecond' LIMIT 1`,
        [this.release.definition.worldId, accountId, STATIC_PLACEMENT_COOLDOWN_MS],
      )
    ).rowCount;
  }
  /** One additive live transaction on the advisory-lock owner. An uncertain commit is replayed. */
  async createGame(
    accountId: string,
    request: PlaceStaticRequest,
    validatedHash: string,
    compatibilityHash: string,
  ) {
    const db = this.db;
    try {
      await db.query('BEGIN');
      const row = await db.query(
        'SELECT revision FROM world_layouts WHERE world_id=$1 FOR UPDATE',
        [this.release.definition.worldId],
      );
      if (row.rows[0]?.revision !== request.expectedLayoutRevision) {
        await db.query('ROLLBACK');
        return undefined;
      }
      const i = placedStaticInstance(request);
      await db.query(
        `SELECT set_config('su.layout_operation',$1,true),set_config('su.layout_source','game',true),set_config('su.layout_account',$2,true)`,
        [request.operationId, accountId],
      );
      await db.query(
        `INSERT INTO world_static_instances(world_id,entity_id,asset_id,position_x,position_y,position_z,rotation_x,rotation_y,rotation_z,rotation_w,enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
        [
          this.release.definition.worldId,
          i.entityId,
          i.assetId,
          i.position.x,
          i.position.y,
          i.position.z,
          i.rotation.x,
          i.rotation.y,
          i.rotation.z,
          i.rotation.w,
        ],
      );
      const updated = await db.query(
        'UPDATE world_layouts SET validated_revision=revision,validated_hash=$2 WHERE world_id=$1 RETURNING revision',
        [this.release.definition.worldId, validatedHash],
      );
      await db.query('UPDATE persistent_worlds SET compatibility_hash=$2 WHERE id=$1', [
        this.release.definition.worldId,
        compatibilityHash,
      ]);
      await db.query('COMMIT');
      return updated.rows[0].revision as number;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  /** Only called inside ItemStore.migrateGeometry's transaction on the owning session. */
  async applyPatch(patch: WorldLayoutPatch, validatedHash: string, operationId: string) {
    await this.db.query('SELECT world_id FROM world_layouts WHERE world_id=$1 FOR UPDATE', [
      patch.worldId,
    ]);
    const before = await this.readCandidate();
    if (!before.initialized) throw new Error('World layout is not initialized');
    const expected = applyWorldLayoutPatch(before.snapshot, patch);
    await this.db.query(
      "SELECT set_config('su.layout_operation',$1,true),set_config('su.layout_source','sql',true)",
      [operationId],
    );
    for (const operation of patch.operations) {
      let changed;
      if (operation.op === 'delete') {
        changed = await this.db.query(
          'DELETE FROM world_static_instances WHERE world_id=$1 AND entity_id=$2 AND instance_revision=$3',
          [patch.worldId, operation.entityId, operation.expectedRevision],
        );
      } else {
        const i = operation.instance;
        const values = [
          patch.worldId,
          i.entityId,
          i.assetId,
          i.position.x,
          i.position.y,
          i.position.z,
          i.rotation.x,
          i.rotation.y,
          i.rotation.z,
          i.rotation.w,
          i.enabled,
          i.sourceRef ?? null,
        ];
        changed =
          operation.op === 'add'
            ? await this.db.query(
                `INSERT INTO world_static_instances(world_id,entity_id,asset_id,position_x,position_y,position_z,rotation_x,rotation_y,rotation_z,rotation_w,enabled,source_ref)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                values,
              )
            : await this.db.query(
                `UPDATE world_static_instances SET asset_id=$3,position_x=$4,position_y=$5,position_z=$6,
             rotation_x=$7,rotation_y=$8,rotation_z=$9,rotation_w=$10,enabled=$11,source_ref=$12
             WHERE world_id=$1 AND entity_id=$2 AND instance_revision=$13`,
                [...values, operation.expectedRevision],
              );
      }
      if (changed.rowCount !== 1)
        throw new Error('Static placement changed during patch application');
    }
    const after = await this.readCandidate();
    const sorted = {
      ...after.snapshot,
      instances: [...after.snapshot.instances].sort((a, b) =>
        a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0,
      ),
    };
    if (canonicalJson(sorted) !== canonicalJson(expected))
      throw new Error('Stored patch differs from the validated candidate');
    await this.commit(after, validatedHash);
    return after.snapshot;
  }
}
