import { normalizeInput, INTEREST_RADII, type MoveInput } from '@su/contracts';

export const INITIAL_CAMERA_ANGLE = Math.PI / 4;
const TURN_SECONDS = 0.28;

/** A bounded quarter-turn: no accumulated orbit queue after repeated key events. */
export class CameraTurn {
  angle = INITIAL_CAMERA_ANGLE;
  private start = this.angle;
  private target = this.angle;
  private elapsed = TURN_SECONDS;

  get turning(): boolean {
    return this.elapsed < TURN_SECONDS;
  }
  rotate(direction: -1 | 1): void {
    if (this.turning) return;
    this.start = this.angle;
    this.target = this.angle + (direction * Math.PI) / 2;
    this.elapsed = 0;
  }
  advance(seconds: number): number {
    if (!this.turning) return this.angle;
    this.elapsed = Math.min(TURN_SECONDS, this.elapsed + Math.max(0, seconds));
    const t = this.elapsed / TURN_SECONDS;
    const eased = t * t * (3 - 2 * t);
    this.angle = this.start + (this.target - this.start) * eased;
    if (!this.turning) this.angle = Math.atan2(Math.sin(this.target), Math.cos(this.target));
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

/** Keep very wide windows within network interest; preserve the projection's aspect ratio. */
export function orthographicFrame(aspect: number): { halfWidth: number; halfHeight: number } {
  const halfHeight = Math.min(aspect < 1 ? 20 : 15, (INTEREST_RADII.enter * 0.75) / aspect);
  return { halfHeight, halfWidth: halfHeight * aspect };
}
