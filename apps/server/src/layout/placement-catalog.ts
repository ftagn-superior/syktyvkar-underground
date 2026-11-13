import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  canonicalJson,
  placementCatalogIdentity,
  validateBuildingParts,
  validatePlacementCatalog,
  validateWorldPlacementAssets,
  sampleTerrain,
  type BuildingParts,
  type PlacementCatalog,
  type PlacementCatalogReference,
  type WorldDefinition,
  type WorldManifest,
} from '@su/contracts';
import { hash, readWorldModelCatalog, readWorldPlacementPolicy } from '@su/world-release';
import type { AuthoringRelease } from './release.js';
import { selectSupportRule } from '@su/terrain-build/supports';

/** One immutable, verified snapshot, shared by discovery, the command and HTTP. */
export interface ServerPlacementCatalog {
  modelNames?: Record<string, string>;
  catalog: PlacementCatalog;
  reference: PlacementCatalogReference;
  body: string;
  assetIds: ReadonlySet<string>;
}

export async function readPlacementCatalog(
  release: AuthoringRelease,
  directory: string,
): Promise<ServerPlacementCatalog | undefined> {
  const { manifest, definition, metadata } = release;
  const policy = await readWorldPlacementPolicy(directory, manifest, metadata.assetReleaseVersion);
  if (!policy) return;
  const source = await readWorldModelCatalog(directory, manifest, metadata.assetReleaseVersion);
  const parts: Record<string, BuildingParts> = {};
  for (const assetId of policy.assetIds) {
    const descriptor = manifest.assets[assetId];
    if (!descriptor)
      throw new Error(`World ${manifest.worldId}, placement ${assetId}: missing asset`);
    const bytes = await readFile(resolve(release.directory, descriptor.partsFile));
    if (hash(bytes) !== manifest.files[descriptor.partsFile])
      throw new Error(`World ${manifest.worldId}, placement ${assetId}: parts hash mismatch`);
    parts[assetId] = validateBuildingParts(JSON.parse(bytes.toString('utf8')));
  }
  validateWorldPlacementAssets(
    policy,
    source,
    manifest,
    definition,
    parts,
    metadata.fixedInstanceIds,
  );
  const terrain = release.terrain?.formatVersion === 2 ? release.terrain : undefined;
  const models = [...policy.assetIds].sort().map((assetId) => ({
    assetId,
    metadata: {
      ...source.models[assetId].metadata,
      tags: [...source.models[assetId].metadata.tags].sort(),
    },
    ...(terrain ? { placement: terrainPlacementModel(release, assetId) } : {}),
  }));
  const categories = Object.fromEntries(
    [...new Set(models.map((m) => m.metadata.category))]
      .sort()
      .map((id) => [id, source.categories[id]]),
  );
  const catalog: PlacementCatalog = {
    formatVersion: 1,
    worldId: manifest.worldId,
    assetReleaseVersion: metadata.assetReleaseVersion,
    modelCatalogVersion: source.catalogVersion,
    placementCatalogVersion: '0'.repeat(64),
    groundY: terrain ? null : 0,
    ...(terrain ? { terrain: { groundEntityIds: terrain.placementGroundIds ?? [] } } : {}),
    yawSteps: 24,
    categories,
    models,
  };
  catalog.placementCatalogVersion = hash(canonicalJson(placementCatalogIdentity(catalog)));
  validatePlacementCatalog(catalog, manifest);
  return {
    modelNames: Object.fromEntries(
      Object.values(source.models).flatMap((model) =>
        model.runtimeAssetIds.map((assetId) => [assetId, model.metadata.name]),
      ),
    ),
    catalog,
    body: canonicalJson(catalog),
    assetIds: new Set(policy.assetIds),
    reference: {
      assetReleaseVersion: catalog.assetReleaseVersion,
      modelCatalogVersion: catalog.modelCatalogVersion,
      placementCatalogVersion: catalog.placementCatalogVersion,
      url: `/worlds/${manifest.worldId}/placement-catalogs/${catalog.placementCatalogVersion}.json`,
    },
  };
}

function terrainPlacementModel(release: AuthoringRelease, assetId: string) {
  const terrain = release.terrain;
  if (terrain?.formatVersion !== 2) throw new Error('Terrain placement requires v2 authoring');
  const policy = terrain.placementModels?.find((model) => model.assetId === assetId)?.policy;
  if (!policy) throw new Error(`Missing terrain placement policy: ${assetId}`);
  if (policy.kind === 'ground-anchor')
    return { ...policy, contactDatum: policy.contactDatum ?? 'anchor' };
  const support = selectSupportRule(terrain.supports, {
    entityId: 'placement-preview',
    assetId,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  });
  if (!support) throw new Error(`Missing default terrain foundation: ${assetId}`);
  const offsetY = Math.max(support.clearance, -support.burial + 0.002 + 1e-8) - support.jointY;
  const heightSamples = support.components.flatMap((component) =>
    [component.outline, ...(component.holes ?? [])].flatMap((ring) =>
      ring.map(([x, z]) => ({ x, z, offsetY })),
    ),
  );
  for (const approach of support.approaches ?? [])
    for (const [x, z] of approach.edge)
      for (const length of [0, approach.length])
        heightSamples.push({
          x: x + approach.outward[0] * length,
          z: z + approach.outward[1] * length,
          offsetY: -approach.targetY,
        });
  return { kind: 'foundation' as const, heightSamples };
}

/** Private grid and its explicit fixed publication bodies are required together. */
export function hasTerrainPlacementGround(release: AuthoringRelease): boolean {
  const terrain = release.terrain;
  if (
    terrain?.formatVersion !== 2 ||
    !terrain.placementGroundIds?.length ||
    !terrain.placementModels?.length
  )
    return false;
  const fixed = new Set(release.metadata.fixedInstanceIds);
  return (
    terrain.placementGroundIds.every((id) => {
      const instance = release.definition.buildings.find((building) => building.entityId === id);
      return (
        fixed.has(id) &&
        !!instance &&
        release.definition.buildingAssets[instance.assetId]?.colliders.some(
          (collider) => collider.kind === 'mesh',
        )
      );
    }) &&
    release.manifest.cells.every(({ bounds }) =>
      [
        [bounds.min.x, bounds.min.z],
        [bounds.max.x, bounds.max.z],
      ].every(([x, z]) => !!sampleTerrain(terrain.grid, x, z)),
    )
  );
}

/** Placement currently supports a flat foundation covering every published cell at Y=0. */
export function hasPlacementGround(definition: WorldDefinition, manifest: WorldManifest): boolean {
  const flat = (q: { x: number; y: number; z: number; w: number }) =>
    Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) < 1e-8;
  const slabs = definition.buildings.flatMap((instance) =>
    !flat(instance.rotation)
      ? []
      : (definition.buildingAssets[instance.assetId]?.colliders ?? []).flatMap((collider) =>
          collider.kind !== 'box' ||
          !flat(collider.rotation) ||
          Math.abs(instance.position.y + collider.position.y + collider.size.y / 2) > 1e-6
            ? []
            : [
                {
                  x: instance.position.x + collider.position.x,
                  z: instance.position.z + collider.position.z,
                  sx: collider.size.x,
                  sz: collider.size.z,
                },
              ],
        ),
  );
  for (const instance of definition.entities)
    if (Math.abs(instance.position.y + instance.size.y / 2) < 1e-6)
      slabs.push({
        x: instance.position.x,
        z: instance.position.z,
        sx: instance.size.x,
        sz: instance.size.z,
      });
  return manifest.cells.every(({ bounds }) =>
    slabs.some(
      (slab) =>
        slab.x - slab.sx / 2 <= bounds.min.x + 1e-6 &&
        slab.x + slab.sx / 2 >= bounds.max.x - 1e-6 &&
        slab.z - slab.sz / 2 <= bounds.min.z + 1e-6 &&
        slab.z + slab.sz / 2 >= bounds.max.z - 1e-6,
    ),
  );
}
