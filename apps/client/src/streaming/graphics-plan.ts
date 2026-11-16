import { distanceToBoundsXZ, type Bounds, type GraphicsLevel, type Vec3 } from '@su/contracts';
export const GRAPHICS_LOD_POLICY = Object.freeze({
  playerRadius: 60,
  promotePixels: 320,
  demotePixels: 240,
});
export const GRAPHICS_STREAMING_POLICY = Object.freeze({
  preloadMargin: 125,
  retainMargin: 250,
  releaseMs: 5000,
});
export interface GraphicsArea {
  center: Vec3;
  radius: number;
}
export interface GraphicsVisibility {
  isGraphicsVisible?(bounds: Bounds, margin?: number): boolean;
}
/** Camera-backed clients use the complete AABB. Headless callers supply a circular area. */
export function inGraphicsArea(
  bounds: Bounds,
  area: GraphicsArea,
  margin: number,
  graphics: GraphicsVisibility,
): boolean {
  return graphics.isGraphicsVisible
    ? graphics.isGraphicsVisible(bounds, margin)
    : distanceToBoundsXZ(area.center, bounds) <= area.radius + margin;
}
export interface GraphicsProjection {
  pixels: number;
  visible: boolean;
  nearPlane: boolean;
  pinned?: boolean;
  /** Keep an already-loaded near view active when turning inside the first-person ring. */
  retainNear?: boolean;
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
  if (!projection.visible) return projection.retainNear && previous === 'near' ? 'near' : 'far';
  if (projection.nearPlane || projection.pixels > GRAPHICS_LOD_POLICY.promotePixels) return 'near';
  if (projection.pixels < GRAPHICS_LOD_POLICY.demotePixels) return 'far';
  return previous ?? 'far';
}
