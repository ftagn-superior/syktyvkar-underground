import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  canonicalJson,
  MAX_EDITABLE_STATIC_INSTANCES,
  validateWorld,
  type StaticObjectInstance,
  type WorldLayoutSnapshot,
  type WorldDefinition,
  type BuildingInstance,
  type BuildingPhysicsAsset,
} from '@su/contracts';
import {
  authoringMetadata,
  createWorldPublication,
  WorldPublicationContentLimitError,
  hash,
  PRIVATE_TERRAIN_MAX_BYTES,
  validatePrivateTerrainReference,
  type AuthoringMetadata,
  type CompiledWorldAsset,
} from '@su/world-release';
import {
  validateTerrainPrivateData,
  validateTerrainCoverage,
  type TerrainPrivateData,
} from '@su/terrain-build/private-data';
import { compileGeneratedAsset } from '@su/terrain-build/assets';
import { generateSupportAssets, selectSupportRule } from '@su/terrain-build/supports';
import { readWorldDirectory } from '../world-bundle.js';

export async function readAuthoringRelease(directory: string) {
  const { manifest, definition } = await readWorldDirectory(directory);
  const metadata: AuthoringMetadata = JSON.parse(
    await readFile(resolve(directory, 'authoring.json'), 'utf8'),
  );
  if (
    !metadata ||
    metadata.formatVersion !== 1 ||
    !Array.isArray(metadata.fixedInstanceIds) ||
    canonicalJson(metadata) !==
      canonicalJson(
        authoringMetadata(definition, manifest, metadata.fixedInstanceIds, metadata.terrain),
      )
  )
    throw new Error('Invalid authored release metadata. Run pnpm world:build.');
  let terrain: TerrainPrivateData | undefined;
  if (metadata.terrain !== undefined) {
    const reference = validatePrivateTerrainReference(metadata.terrain);
    const path = resolve(directory, reference.file);
    if ((await stat(path)).size > PRIVATE_TERRAIN_MAX_BYTES)
      throw new Error('Private terrain byte limit');
    const bytes = await readFile(path);
    if (bytes.byteLength > PRIVATE_TERRAIN_MAX_BYTES || hash(bytes) !== reference.sha256)
      throw new Error('Private terrain hash mismatch');
    terrain = validateTerrainPrivateData(JSON.parse(bytes.toString('utf8')));
    if (terrain.worldId !== manifest.worldId) throw new Error('Private terrain world mismatch');
    validateTerrainCoverage(terrain.grid, manifest.bounds);
    const owners = new Map(definition.buildings.map((b) => [b.entityId, b.assetId]));
    const fixed = new Set(metadata.fixedInstanceIds);
    const fixedAssets = new Set(
      definition.buildings.filter((b) => fixed.has(b.entityId)).map((b) => b.assetId),
    );
    for (const support of terrain.supports) {
      // The lab's v1 foundations are authored fixed geometry. V2 rules are inputs
      // for editable owners, including instances created after this release.
      if (support.kind === 'rectangle-v1' && owners.get(support.ownerId) !== support.assetId)
        throw new Error(`Unknown terrain support owner: ${support.ownerId}`);
      if (
        support.kind !== 'rectangle-v1' &&
        (!Object.hasOwn(manifest.assets, support.assetId) || fixedAssets.has(support.assetId))
      )
        throw new Error(`Terrain support requires an editable model: ${support.assetId}`);
    }
  }
  const fixed = new Set(metadata.fixedInstanceIds);
  const seed: StaticObjectInstance[] = definition.buildings
    .filter((i) => !fixed.has(i.entityId))
    .map((i) => ({ ...i, instanceRevision: 1, enabled: true }));
  return { manifest, definition, metadata, seed, terrain, directory: resolve(directory) };
}
export type AuthoringRelease = Awaited<ReturnType<typeof readAuthoringRelease>>;
export function editableStaticAssetIds(release: AuthoringRelease): string[] {
  const fixed = new Set(release.metadata.fixedInstanceIds);
  const fixedAssets = new Set(
    release.definition.buildings.filter((i) => fixed.has(i.entityId)).map((i) => i.assetId),
  );
  return Object.keys(release.manifest.assets)
    .filter((id) => !fixedAssets.has(id))
    .sort();
}
export function layoutHash(snapshot: WorldLayoutSnapshot) {
  return hash(
    canonicalJson({
      assetReleaseVersion: snapshot.assetReleaseVersion,
      instances: snapshot.instances
        .filter((i) => i.enabled)
        .map(({ instanceRevision: _r, enabled: _e, ...instance }) => instance)
        .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0)),
    }),
  );
}
/** Stable identity; geometry/resource versions change independently with accepted poses. */
export function terrainSupportId(worldId: string, ownerId: string, role: string) {
  return `support-${hash(canonicalJson({ worldId, ownerId, role }))}`;
}
/** Offline callers re-read source files, while a worker can pin one verified release. */
export function createLayoutPublication(release: AuthoringRelease, snapshot: WorldLayoutSnapshot) {
  return prepareLayoutPublication(release, snapshot, () => readCompiledLayoutAssets(release));
}
export function createReleaseLayoutPublisher(release: AuthoringRelease) {
  let assets: Promise<Record<string, CompiledWorldAsset>> | undefined;
  return (snapshot: WorldLayoutSnapshot) =>
    prepareLayoutPublication(
      release,
      snapshot,
      () => (assets ??= readCompiledLayoutAssets(release)),
    );
}
async function prepareLayoutPublication(
  release: AuthoringRelease,
  snapshot: WorldLayoutSnapshot,
  compiledAssets: () => Promise<Record<string, CompiledWorldAsset>>,
) {
  if (
    snapshot.formatVersion !== 1 ||
    !Array.isArray(snapshot.instances) ||
    !Number.isInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    snapshot.revision > 2147483647 ||
    !/^[a-f0-9]{64}$/.test(snapshot.seedVersion)
  )
    throw new Error('Invalid layout snapshot');
  if (snapshot.instances.length > MAX_EDITABLE_STATIC_INSTANCES)
    throw new WorldPublicationContentLimitError('editable static instances');
  const reserved = new Set([
    ...release.metadata.fixedInstanceIds,
    ...release.definition.entities.map((i) => i.entityId),
  ]);
  const ids = new Set<string>();
  const editableAssets = new Set(editableStaticAssetIds(release));
  for (const instance of snapshot.instances) {
    if (reserved.has(instance.entityId) || ids.has(instance.entityId))
      throw new Error(`Reserved/duplicate static ID: ${instance.entityId}`);
    ids.add(instance.entityId);
    if (
      !Number.isSafeInteger(instance.instanceRevision) ||
      instance.instanceRevision < 1 ||
      instance.instanceRevision > 2147483647 ||
      typeof instance.enabled !== 'boolean'
    )
      throw new Error('Invalid static instance revision or enabled state');
    const q = instance.rotation;
    if (
      !q ||
      !Number.isFinite(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) ||
      Math.abs(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w - 1) >= 0.000001
    )
      throw new Error('Static rotation must be a finite unit quaternion');
    if (!editableAssets.has(instance.assetId))
      throw new Error(`Unknown static asset: ${instance.assetId}`);
  }
  if (
    snapshot.worldId !== release.definition.worldId ||
    snapshot.assetReleaseVersion !== release.metadata.assetReleaseVersion
  )
    throw new Error('Layout belongs to a different world or asset release');
  const instances = snapshot.instances.map(({ instanceRevision: _r, enabled: _e, ...i }) => i);
  // Disabled records must still have valid references, transforms and containing world bounds.
  if (
    release.definition.buildings.filter((i) => reserved.has(i.entityId)).length + instances.length >
    10_000
  )
    throw new WorldPublicationContentLimitError('world building references');
  validateWorld({
    ...release.definition,
    buildings: [
      ...release.definition.buildings.filter((i) => reserved.has(i.entityId)),
      ...instances,
    ],
  });
  const world = {
    ...release.definition,
    buildingAssets: { ...release.definition.buildingAssets },
    buildings: [
      ...release.definition.buildings.filter((i) => reserved.has(i.entityId)),
      ...instances.filter((_, index) => snapshot.instances[index].enabled),
    ],
  };
  const assets = { ...(await compiledAssets()) };
  const generatedSupports: Record<string, { ownerId: string; role: string }> = {};
  // Start from the immutable authored release every time. Dynamic supports are
  // never source buildings, DB rows or editable catalog entries, so disabling,
  // deleting or changing a model cannot retain an earlier generated resource.
  if (release.terrain?.formatVersion === 2) {
    const usedIds = new Set([...reserved, ...ids, ...Object.keys(assets)]);
    const owners = snapshot.instances
      .filter((instance) => instance.enabled)
      .slice()
      .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
    for (const owner of owners) {
      const rule = selectSupportRule(release.terrain.supports, owner);
      if (!rule) continue;
      const derivedIds = {
        foundation: terrainSupportId(world.worldId, owner.entityId, 'foundation'),
        approaches: Object.fromEntries(
          (rule.approaches ?? []).map((approach) => [
            approach.id,
            terrainSupportId(world.worldId, owner.entityId, `approach:${approach.id}`),
          ]),
        ),
      };
      for (const id of [derivedIds.foundation, ...Object.values(derivedIds.approaches)]) {
        if (usedIds.has(id)) throw new Error(`Reserved/duplicate terrain support ID: ${id}`);
        usedIds.add(id);
      }
      const generated: ReturnType<typeof generateSupportAssets> = (() => {
        try {
          return generateSupportAssets(release.terrain!.grid, rule, owner, derivedIds);
        } catch (error) {
          throw new Error(
            `Terrain support for ${owner.entityId} (${owner.assetId}): ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      })();
      for (const [id, role] of [
        [derivedIds.foundation, 'foundation'],
        ...Object.entries(derivedIds.approaches).map(([role, id]) => [id, `approach:${role}`]),
      ])
        generatedSupports[id] = { ownerId: owner.entityId, role };
      for (const { asset } of generated) {
        const assetId = asset.physics.assetId;
        const compiled = compileGeneratedAsset(assetId, asset);
        assets[assetId] = compiled;
        world.buildingAssets[assetId] = compiled.physics;
        world.buildings.push({
          entityId: assetId,
          assetId,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        });
      }
    }
  }
  world.buildings.sort((a, b) => a.entityId.localeCompare(b.entityId));
  return {
    world,
    publication: createWorldPublication(world, release.manifest.grid, assets, {
      physicsPacks: release.manifest.cells.some((cell) => cell.physicsPacks?.length),
      ...(Object.keys(generatedSupports).length ? { generatedSupports } : {}),
    }),
    hash: layoutHash(snapshot),
  };
}

async function readCompiledLayoutAssets(release: AuthoringRelease) {
  const read = async (path: string) => {
    const bytes = await readFile(resolve(release.directory, path));
    if (hash(bytes) !== release.manifest.files[path])
      throw new Error(`World resource changed during preparation: ${path}`);
    return bytes;
  };
  const assets: Record<string, CompiledWorldAsset> = {};
  for (const [id, descriptor] of Object.entries(release.manifest.assets)) {
    const [model, collision, parts] = await Promise.all([
      descriptor.modelFile ? read(descriptor.modelFile) : undefined,
      read(descriptor.collisionFile),
      read(descriptor.partsFile),
    ]);
    assets[id] = {
      version: descriptor.version,
      bounds: descriptor.bounds,
      physics: release.definition.buildingAssets[id],
      model,
      collision,
      parts,
    };
  }
  return assets;
}

/** Only the changed owner and its declared generated collision geometry cross the worker boundary. */
export interface StaticLayoutGeometryDelta {
  removedIds: string[];
  buildings: BuildingInstance[];
  assets: Record<string, BuildingPhysicsAsset>;
}
/** Assemble the same world as the publisher without regenerating terrain meshes or GLB payloads. */
export function applyPreparedLayoutDelta(
  release: AuthoringRelease,
  snapshot: WorldLayoutSnapshot,
  current: WorldDefinition,
  delta: StaticLayoutGeometryDelta,
): WorldDefinition {
  const fixed = new Set(release.metadata.fixedInstanceIds);
  const owners = new Set(snapshot.instances.map((i) => i.entityId));
  const removed = new Set(delta.removedIds);
  const derived = [
    ...current.buildings.filter(
      (i) => !fixed.has(i.entityId) && !owners.has(i.entityId) && !removed.has(i.entityId),
    ),
    ...delta.buildings.filter((i) => !fixed.has(i.entityId) && !owners.has(i.entityId)),
  ];
  const buildingAssets = { ...release.definition.buildingAssets };
  for (const instance of derived) {
    const asset = delta.assets[instance.assetId] ?? current.buildingAssets[instance.assetId];
    if (!asset) throw new Error(`Missing prepared terrain asset: ${instance.assetId}`);
    buildingAssets[instance.assetId] = asset;
  }
  return {
    ...release.definition,
    buildingAssets,
    buildings: [
      ...release.definition.buildings.filter((i) => fixed.has(i.entityId)),
      ...snapshot.instances
        .filter((i) => i.enabled)
        .map(({ instanceRevision: _r, enabled: _e, ...i }) => i),
      ...derived,
    ].sort((a, b) => a.entityId.localeCompare(b.entityId)),
  };
}
