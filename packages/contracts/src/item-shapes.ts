import type { ItemType } from './items.js';
import type { Quat, Vec3 } from './simulation.js';

export type ItemShapePart = { center: Vec3 } & (
  | { kind: 'box'; size: Vec3 }
  | { kind: 'sphere'; radius: number }
  | { kind: 'capsule'; radius: number; height: number }
);

/** Shared geometry for rendering, server physics, prediction and placement. Units are metres. */
export function itemShapeParts(type: ItemType): ItemShapePart[] {
  const { size } = type;
  switch (type.model) {
    case 'watermelon':
      return [{ kind: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: size.x / 2 }];
    case 'monument': {
      const radius = size.z / 2;
      const baseHeight = size.y * 0.04;
      return [
        {
          kind: 'capsule',
          center: { x: 0, y: size.y * 0.025, z: 0 },
          radius: Math.min(size.x * 0.25, size.z * 0.375),
          height: size.y * 0.95,
        },
        ...[-1, 1].map((side): ItemShapePart => ({
          kind: 'sphere',
          center: { x: side * (size.x / 2 - radius), y: -size.y / 2 + baseHeight + radius, z: 0 },
          radius,
        })),
        {
          kind: 'box',
          center: { x: 0, y: -size.y / 2 + baseHeight / 2, z: 0 },
          size: { x: size.x, y: baseHeight, z: size.z },
        },
      ];
    }
    default:
      return [{ kind: 'box', center: { x: 0, y: 0, z: 0 }, size }];
  }
}

/** Physics hashes and saved type compatibility include the actual procedural geometry. */
export function itemPhysicsDefinition(type: ItemType) {
  return {
    model: type.model,
    size: { x: type.size.x, y: type.size.y, z: type.size.z },
    mass: type.mass,
    friction: type.friction,
    restitution: type.restitution,
    // Keep the existing box record byte-for-byte compatible with saved crates.
    ...(type.model === 'box' ? {} : { parts: itemShapeParts(type) }),
  };
}

/** Furthest projection from the item's origin along a world-space unit direction. */
export function itemSupportDistance(type: ItemType, rotation: Quat, direction: Vec3): number {
  const { x, y, z, w } = rotation;
  // Transform the direction into the item's local frame using the inverse rotation.
  const local = {
    x:
      direction.x * (1 - 2 * (y * y + z * z)) +
      direction.y * 2 * (x * y + w * z) +
      direction.z * 2 * (x * z - w * y),
    y:
      direction.x * 2 * (x * y - w * z) +
      direction.y * (1 - 2 * (x * x + z * z)) +
      direction.z * 2 * (y * z + w * x),
    z:
      direction.x * 2 * (x * z + w * y) +
      direction.y * 2 * (y * z - w * x) +
      direction.z * (1 - 2 * (x * x + y * y)),
  };
  return Math.max(
    ...itemShapeParts(type).map((part) => {
      const center = part.center.x * local.x + part.center.y * local.y + part.center.z * local.z;
      switch (part.kind) {
        case 'box':
          return (
            center +
            (Math.abs(local.x) * part.size.x +
              Math.abs(local.y) * part.size.y +
              Math.abs(local.z) * part.size.z) /
              2
          );
        case 'sphere':
          return center + part.radius;
        case 'capsule':
          return center + part.radius + Math.abs(local.y) * (part.height / 2 - part.radius);
      }
    }),
  );
}
