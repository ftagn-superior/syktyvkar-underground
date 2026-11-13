import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  canonicalJson,
  MAX_EDITABLE_STATIC_INSTANCES,
  validateWorld,
  type StaticObjectInstance,
  type WorldLayoutSnapshot,
} from '@su/contracts';
import {
  authoringMetadata,
  createWorldPublication,
  WorldPublicationContentLimitError,
  hash,
  type AuthoringMetadata,
  type CompiledWorldAsset,
} from '@su/world-release';
import { readWorldDirectory } from '../world-bundle.js';

export async function readAuthoringRelease(directory: string) {
  const { manifest, definition } = await readWorldDirectory(directory);
  const metadata: AuthoringMetadata = JSON.parse(
    await readFile(resolve(directory, 'authoring.json'), 'utf8'),
  );
  if (
    metadata.formatVersion !== 1 ||
    !Array.isArray(metadata.fixedInstanceIds) ||
    canonicalJson(metadata) !==
      canonicalJson(authoringMetadata(definition, manifest, metadata.fixedInstanceIds))
  )
    throw new Error('Invalid authored release metadata. Run pnpm world:build.');
  const fixed = new Set(metadata.fixedInstanceIds);
  const seed: StaticObjectInstance[] = definition.buildings
    .filter((i) => !fixed.has(i.entityId))
    .map((i) => ({ ...i, instanceRevision: 1, enabled: true }));
  return { manifest, definition, metadata, seed, directory: resolve(directory) };
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
export async function createLayoutPublication(
  release: AuthoringRelease,
  snapshot: WorldLayoutSnapshot,
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
    buildings: [
      ...release.definition.buildings.filter((i) => reserved.has(i.entityId)),
      ...instances.filter((_, index) => snapshot.instances[index].enabled),
    ],
  };
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
  return {
    world,
    publication: createWorldPublication(world, release.manifest.grid, assets),
    hash: layoutHash(snapshot),
  };
}
