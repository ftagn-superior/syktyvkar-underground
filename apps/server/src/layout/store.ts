import { randomUUID } from 'node:crypto';
import { canonicalJson, type StaticObjectInstance, type WorldLayoutSnapshot } from '@su/contracts';
import type { WorldOwnership } from '../world-ownership.js';
import type { AuthoringRelease } from './release.js';

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
    const fixedAssets = new Set(
      this.release.definition.buildings
        .filter((i) => this.release.metadata.fixedInstanceIds.includes(i.entityId))
        .map((i) => i.assetId),
    );
    const assets = Object.keys(this.release.manifest.assets)
      .filter((id) => !fixedAssets.has(id))
      .sort();
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
}
