import { distanceToBoundsXZ, type Bounds, type GraphicsLevel, type Vec3 } from '@su/contracts';
export const GRAPHICS_LOD_POLICY = Object.freeze({
  playerRadius: 60,
  promotePixels: 320,
  demotePixels: 240,
});
export interface GraphicsProjection {
  pixels: number;
  visible: boolean;
  nearPlane: boolean;
  pinned?: boolean;
}
/** Forward distance to a complete AABB; input direction is normalized. */
export function rayBoundsDistance(
  origin: Vec3,
  direction: Vec3,
  bounds: Bounds,
  length: number,
): number | undefined {
  let enter = 0,
    leave = length;
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = direction[axis],
      p = origin[axis],
      min = bounds.min[axis],
      max = bounds.max[axis];
    if (Math.abs(d) < 1e-12) {
      if (p < min || p > max) return;
      continue;
    }
    const a = (min - p) / d,
      b = (max - p) / d;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
    if (enter > leave) return;
  }
  return enter;
}
export function graphicsLevel(
  bounds: Bounds,
  projection: GraphicsProjection,
  players: readonly Vec3[],
  previous?: GraphicsLevel,
): GraphicsLevel {
  if (
    projection.pinned ||
    players.some((p) => distanceToBoundsXZ(p, bounds) <= GRAPHICS_LOD_POLICY.playerRadius)
  )
    return 'near';
  if (!projection.visible) return 'far';
  if (projection.nearPlane || projection.pixels > GRAPHICS_LOD_POLICY.promotePixels) return 'near';
  if (projection.pixels < GRAPHICS_LOD_POLICY.demotePixels) return 'far';
  return previous ?? 'far';
}
