import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Ray } from '@babylonjs/core/Culling/ray';

const FADED_OPACITY = 0.22;
const CLEAR_DELAY_MS = 160;

/** Rays start on the camera near plane and stay parallel, even away from screen centre. */
export function orthographicSightRay(
  cameraPosition: Vector3,
  viewDirection: Vector3,
  target: Vector3,
  near: number,
): Ray {
  const depth = Vector3.Dot(target.subtract(cameraPosition), viewDirection) - near;
  return new Ray(
    target.subtract(viewDirection.scale(Math.max(0, depth))),
    viewDirection.clone(),
    Math.max(0, depth - 0.04),
  );
}

/** The hold interval prevents an occluder's silhouette flickering along the player's edge. */
export class OcclusionFade {
  opacity = 1;
  blocked = false;
  private lastBlockedAt = -Infinity;

  clear(): void {
    this.opacity = 1;
    this.blocked = false;
    this.lastBlockedAt = -Infinity;
  }

  update(blocked: boolean, now: number, seconds: number): number {
    this.blocked = blocked;
    if (blocked) this.lastBlockedAt = now;
    const target = now - this.lastBlockedAt < CLEAR_DELAY_MS ? FADED_OPACITY : 1;
    const rate = target < this.opacity ? 22 : 12;
    this.opacity += (target - this.opacity) * (1 - Math.exp(-Math.min(seconds, 0.1) * rate));
    if (Math.abs(this.opacity - target) < 0.002) this.opacity = target;
    return this.opacity;
  }
}
