import { cellsIntersectingBounds, type Vec3, type WorldManifest } from '@su/contracts';

/** Replay pins collision cells touched by the capsule, including a seam/diagonal crossing. */
export function predictionCells(
  manifest: WorldManifest,
  from: Vec3,
  to: Vec3,
  radius: number,
): string[] {
  return cellsIntersectingBounds(manifest.bounds, manifest.grid, {
    min: {
      x: Math.min(from.x, to.x) - radius,
      y: manifest.bounds.min.y,
      z: Math.min(from.z, to.z) - radius,
    },
    max: {
      x: Math.max(from.x, to.x) + radius,
      y: manifest.bounds.max.y,
      z: Math.max(from.z, to.z) + radius,
    },
  });
}
