import { canonicalJson } from '@su/contracts';
import type { AuthoringRelease } from '../../../apps/server/src/layout/release.js';
import type { TerrainPoseRules } from '../../../apps/server/src/layout/terrain-poses.js';

/** Derive explicit migration inputs from verified releases, without a saved layout or database.
 * Models absent from runtime placement authoring still need a reviewed migration policy. */
export function terrainPoseRules(
  source: AuthoringRelease,
  target: AuthoringRelease,
  migrationModels: TerrainPoseRules['models'] = [],
): TerrainPoseRules {
  if (source.definition.worldId !== target.definition.worldId)
    throw new Error('Terrain migration releases must belong to the same world');
  if (source.terrain?.formatVersion !== 2 || target.terrain?.formatVersion !== 2)
    throw new Error('Terrain rule generation requires source and target terrain v2');
  for (const axis of ['x', 'z'] as const)
    for (const side of ['min', 'max'] as const)
      if (source.definition.bounds[side][axis] !== target.definition.bounds[side][axis])
        throw new Error('Terrain rule generation requires unchanged X/Z world bounds');
  for (const [name, release] of [
    ['source', source],
    ['target', target],
  ] as const) {
    const ids =
      release.terrain?.formatVersion === 2 ? release.terrain.placementGroundIds : undefined;
    if (!ids?.length || new Set(ids).size !== ids.length)
      throw new Error(`${name} release has no explicit terrain ground IDs`);
    for (const id of ids)
      if (
        !release.metadata.fixedInstanceIds.includes(id) ||
        !release.definition.buildings.some((owner) => owner.entityId === id)
      )
        throw new Error(`${name} terrain ground ID is not an immutable ground owner: ${id}`);
  }
  if (!target.terrain.placementModels?.length)
    throw new Error('Target release has no explicit terrain placement policies');
  const models = [...target.terrain.placementModels, ...migrationModels];
  const seen = new Set<string>();
  for (const { assetId } of models) {
    if (seen.has(assetId)) throw new Error(`Duplicate terrain placement policy: ${assetId}`);
    seen.add(assetId);
    const previous = source.definition.buildingAssets[assetId];
    const next = target.definition.buildingAssets[assetId];
    if (!previous || !next || canonicalJson(previous) !== canonicalJson(next))
      throw new Error(`Terrain rule generation requires an unchanged model: ${assetId}`);
  }
  return {
    formatVersion: 1,
    algorithmVersion: 'terrain-poses/1',
    sourceGroundIds: [...source.terrain.placementGroundIds!].sort(),
    targetGroundIds: [...target.terrain.placementGroundIds!].sort(),
    models: structuredClone(models).sort((a, b) => a.assetId.localeCompare(b.assetId)),
  };
}
