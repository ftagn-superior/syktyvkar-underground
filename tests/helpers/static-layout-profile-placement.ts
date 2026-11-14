import type {
  BuildingInstance,
  BuildingPhysicsAsset,
  PlaceStaticRequest,
} from '../../packages/contracts/src/index.js';
import type { AuthoritativeWorld } from '../../packages/simulation/src/server.js';
import {
  generateSupportAssets,
  selectSupportRule,
} from '../../packages/terrain-build/src/supports.js';
import { resolveStaticPlacement } from '../../apps/server/src/layout/placement-pose.js';
import { terrainSupportId, type AuthoringRelease } from '../../apps/server/src/layout/release.js';

type StaticGeometry = { instance: BuildingInstance; asset: BuildingPhysicsAsset };

/** Untimed preflight over the same authored policy; the operation still runs the real server checks. */
export function profilePlacementGeometry(release: AuthoringRelease, request: PlaceStaticRequest) {
  const owner = resolveStaticPlacement(release, request);
  const geometry: StaticGeometry[] = [
    { instance: owner, asset: release.definition.buildingAssets[owner.assetId] },
  ];
  if (release.terrain?.formatVersion === 2) {
    const rule = selectSupportRule(release.terrain.supports, owner);
    if (rule) {
      const generated = generateSupportAssets(release.terrain.grid, rule, owner, {
        foundation: terrainSupportId(release.definition.worldId, owner.entityId, 'foundation'),
        approaches: Object.fromEntries(
          (rule.approaches ?? []).map((approach) => [
            approach.id,
            terrainSupportId(release.definition.worldId, owner.entityId, `approach:${approach.id}`),
          ]),
        ),
      });
      for (const { asset } of generated)
        geometry.push({
          instance: {
            entityId: asset.physics.assetId,
            assetId: asset.physics.assetId,
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          },
          asset: asset.physics,
        });
    }
  }
  return { owner, geometry };
}

export function profilePlacementIsBlocked(
  world: AuthoritativeWorld,
  release: AuthoringRelease,
  candidate: ReturnType<typeof profilePlacementGeometry>,
) {
  const ground = new Set(
    release.terrain?.formatVersion === 2 ? (release.terrain.placementGroundIds ?? []) : [],
  );
  for (let index = 0; index < candidate.geometry.length; index++) {
    const { instance, asset } = candidate.geometry[index];
    const { min, max } = asset.bounds;
    const checked: BuildingPhysicsAsset =
      index === 0
        ? asset
        : {
            ...asset,
            colliders: [
              {
                id: 'profile-support-bound',
                kind: 'box',
                position: {
                  x: (min.x + max.x) / 2,
                  y: (min.y + max.y) / 2,
                  z: (min.z + max.z) / 2,
                },
                size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
                friction: 0.6,
                restitution: 0,
              },
            ],
          };
    if (world.checkStaticPlacement(instance, checked, ground)) return true;
  }
  return false;
}
