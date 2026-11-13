import {
  placedStaticInstance,
  sampleTerrain,
  type PlaceStaticRequest,
  type StaticPlacementError,
} from '@su/contracts';
import { patchRange, rectangle, terrainPatch } from '@su/terrain-build';
import { planSupportPlacement, selectSupportRule } from '@su/terrain-build/supports';
import type { AuthoringRelease } from './release.js';

export class StaticPlacementRejected extends Error {
  constructor(
    readonly code: StaticPlacementError,
    message: string,
  ) {
    super(message);
  }
}

/** The wire chooses only XZ and yaw; accepted authoring data determines the absolute Y. */
export function resolveStaticPlacement(release: AuthoringRelease, request: PlaceStaticRequest) {
  const instance = placedStaticInstance(request);
  const terrain = release.terrain;
  if (!terrain) return instance;
  if (terrain.formatVersion !== 2)
    throw new StaticPlacementRejected('COMMAND_DISABLED', 'Terrain placement requires v2 policy');
  const policy = terrain.placementModels?.find(
    (model) => model.assetId === instance.assetId,
  )?.policy;
  if (!policy)
    throw new StaticPlacementRejected('ASSET_NOT_ALLOWED', 'Model has no terrain placement policy');
  const support = selectSupportRule(terrain.supports, instance);
  if (policy.kind === 'foundation') {
    if (!support)
      throw new StaticPlacementRejected('ASSET_NOT_ALLOWED', 'Model has no applicable foundation');
    let plan: ReturnType<typeof planSupportPlacement>;
    try {
      plan = planSupportPlacement(terrain.grid, support, instance);
    } catch {
      throw new StaticPlacementRejected('OUT_OF_BOUNDS', 'Foundation is outside valid terrain');
    }
    if (plan.minimumY + support.jointY - plan.terrainMin > policy.maximumVisibleHeight + 1e-8)
      throw new StaticPlacementRejected('BLOCKED', 'Foundation exceeds its authored height limit');
    instance.position.y = plan.minimumY;
  } else {
    if (support)
      throw new StaticPlacementRejected('ASSET_NOT_ALLOWED', 'Anchor conflicts with foundation');
    const yaw = 2 * Math.atan2(instance.rotation.y, instance.rotation.w);
    const x =
      instance.position.x + Math.cos(yaw) * policy.anchor.x + Math.sin(yaw) * policy.anchor.z;
    const z =
      instance.position.z - Math.sin(yaw) * policy.anchor.x + Math.cos(yaw) * policy.anchor.z;
    const contact = rectangle(x, z, policy.contactRadius * 2, policy.contactRadius * 2);
    if (!contact.every(([px, pz]) => sampleTerrain(terrain.grid, px, pz)))
      throw new StaticPlacementRejected('OUT_OF_BOUNDS', 'Anchor footprint leaves terrain');
    const range = patchRange(terrainPatch(terrain.grid, contact));
    if (range.max - range.min > policy.maximumTerrainReliefMetres + 1e-8)
      throw new StaticPlacementRejected('BLOCKED', 'Terrain exceeds the planting relief limit');
    instance.position.y =
      (policy.contactDatum === 'minimum' ? range.min : sampleTerrain(terrain.grid, x, z)!.height) -
      policy.anchor.y;
  }
  return instance;
}
