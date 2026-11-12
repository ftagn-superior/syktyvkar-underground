import { normalizeInput, type MoveInput } from '@su/contracts';

export const INITIAL_CAMERA_ANGLE = Math.PI / 4;
const ROTATION_SPEED = Math.PI / 2;
const SMOOTH_SECONDS = 0.045;
const SETTLED_ANGLE = 0.0001;
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Continuous orbit with a short, frame-rate-independent approach to the requested angle. */
export class CameraOrbit {
  angle = INITIAL_CAMERA_ANGLE;
  private direction: -1 | 0 | 1 = 0;
  private remaining = 0;

  get turning(): boolean {
    return this.direction !== 0 || this.remaining !== 0;
  }
  setDirection(direction: -1 | 0 | 1): void {
    this.direction = direction;
  }
  rotateBy(radians: number): void {
    this.remaining += radians;
  }
  stop(): void {
    this.direction = 0;
    this.remaining = 0;
  }
  advance(seconds: number): number {
    // A resumed tab or a slow frame must not produce a large orbit jump.
    const delta = Math.min(0.1, Math.max(0, seconds));
    if (!this.turning || delta === 0) return this.angle;
    const approach = -Math.expm1(-delta / SMOOTH_SECONDS);
    const speed = this.direction * ROTATION_SPEED;
    // Exact integration of a damped angle whose target moves at a constant keyboard speed.
    const rotation = this.remaining * approach + speed * (delta - SMOOTH_SECONDS * approach);
    this.remaining += speed * delta - rotation;
    this.angle = wrapAngle(this.angle + rotation);
    if (this.direction === 0 && Math.abs(this.remaining) < SETTLED_ANGLE) {
      this.angle = wrapAngle(this.angle + this.remaining);
      this.remaining = 0;
    }
    return this.angle;
  }
}

/** Ground-plane axes of our right-handed orthographic camera at the actual orbit angle. */
export function screenMovement(right: number, forward: number, angle: number): MoveInput {
  return normalizeInput({
    moveX: right * Math.sin(angle) - forward * Math.cos(angle),
    moveZ: -right * Math.cos(angle) - forward * Math.sin(angle),
  })!;
}

/** Projection keeps the chosen scale on every aspect ratio; graphics streaming covers the frame. */
export function orthographicFrame(
  aspect: number,
  zoom = 1,
): { halfWidth: number; halfHeight: number } {
  const halfHeight = (aspect < 1 ? 20 : 15) * zoom;
  return { halfHeight, halfWidth: halfHeight * aspect };
}
