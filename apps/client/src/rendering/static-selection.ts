import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Ray } from '@babylonjs/core/Culling/ray';
import type { BuildingInstance, Vec3 } from '@su/contracts';
import { radialOpacity, type RadialState } from './radial-fog';

/** Stable placement identity, independent of meshes, GPU batches and streamed cell owners. */
export interface StaticObjectSelection {
  entityId: string;
  assetId: string;
  position: Vec3;
  minimum: Vec3;
  maximum: Vec3;
}
export interface StaticObjectHit extends StaticObjectSelection {
  distance: number;
}

export function staticObjectSelection(
  definition: BuildingInstance,
  minimum: Vector3,
  maximum: Vector3,
): StaticObjectSelection {
  return {
    entityId: definition.entityId,
    assetId: definition.assetId,
    position: { ...definition.position },
    minimum: { x: minimum.x, y: minimum.y, z: minimum.z },
    maximum: { x: maximum.x, y: maximum.y, z: maximum.z },
  };
}

export function staticRayBounds(ray: Ray) {
  const end = ray.origin.add(ray.direction.scale(ray.length));
  return { min: Vector3.Minimize(ray.origin, end), max: Vector3.Maximize(ray.origin, end) };
}

export function staticHitVisible(
  radial: RadialState | undefined,
  ray: Ray,
  distance: number,
  born = -Infinity,
) {
  return (
    !radial ||
    (radial.time > born &&
      radialOpacity(radial.center, ray.origin.add(ray.direction.scale(distance)), radial.radius) >
        0)
  );
}
