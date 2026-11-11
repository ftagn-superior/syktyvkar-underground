import type { DisplayPlayer } from '../../presentation/display-state';
import { restingPose, sampleLocomotion } from './locomotion';

export type AvatarMotion = Pick<
  DisplayPlayer,
  | 'position'
  | 'rotation'
  | 'velocity'
  | 'grounded'
  | 'revision'
  | 'motionRevision'
  | 'motionEnabled'
  | 'connected'
>;
const TAU = Math.PI * 2;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const angleDifference = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** One visual update per rendered frame, never from a physics replay step. */
export class CharacterAnimator {
  readonly pose = restingPose();
  private previous?: { x: number; z: number; revision: number; motionRevision: number };
  private phase = 0;
  private speed = 0;
  private movement = 0;
  private running = 0;
  private airborne = 0;
  private yaw = 0;
  private mode: 'idle' | 'walk' | 'run' | 'airborne' = 'idle';

  constructor(
    private readonly walkSpeed: number,
    private readonly sprintSpeed: number,
  ) {}

  resetMotion(): void {
    this.previous = undefined;
  }

  update(frame: AvatarMotion, delta: number, predicted: boolean, reducedMotion = false) {
    const q = frame.rotation;
    // Remote quaternion components are interpolated before the root normalizes them.
    const targetYaw = Math.atan2(
      2 * (q.w * q.y + q.x * q.z),
      q.w * q.w + q.x * q.x - q.y * q.y - q.z * q.z,
    );
    const previous = this.previous;
    const distance = previous
      ? Math.hypot(frame.position.x - previous.x, frame.position.z - previous.z)
      : 0;
    const discontinuity =
      !previous ||
      previous.revision !== frame.revision ||
      previous.motionRevision !== frame.motionRevision ||
      !Number.isFinite(delta) ||
      delta <= 0 ||
      delta > 0.25 ||
      distance > Math.max(2, this.sprintSpeed * delta * 1.8);
    if (!this.previous) this.previous = { x: 0, z: 0, revision: 0, motionRevision: 0 };
    Object.assign(this.previous, {
      x: frame.position.x,
      z: frame.position.z,
      revision: frame.revision,
      motionRevision: frame.motionRevision,
    });
    const enabled = frame.motionEnabled && frame.connected !== false;
    if (discontinuity) {
      this.phase = this.speed = this.movement = this.running = 0;
      this.airborne = frame.grounded ? 0 : 1;
      this.yaw = targetYaw;
    } else {
      const measuredSpeed = !enabled
        ? 0
        : predicted
          ? Math.hypot(frame.velocity.x, frame.velocity.z)
          : distance / delta;
      const speed = Math.min(this.sprintSpeed, measuredSpeed);
      const blend = 1 - Math.exp(-14 * delta);
      this.speed += (speed - this.speed) * blend;
      const moving = frame.grounded && enabled && speed > 0.08;
      this.movement += ((moving ? clamp(this.speed / 0.8) : 0) - this.movement) * blend;
      const run = clamp(
        (this.speed - this.walkSpeed) / Math.max(0.001, this.sprintSpeed - this.walkSpeed),
      );
      this.running += (run - this.running) * blend;
      this.airborne += ((frame.grounded ? 0 : 1) - this.airborne) * blend;
      if (moving) {
        const cyclesPerSecond = 1.85 * clamp(this.speed / this.walkSpeed) + 0.95 * this.running;
        this.phase = (this.phase + TAU * cyclesPerSecond * delta) % TAU;
      }
      this.yaw += angleDifference(targetYaw - this.yaw) * (1 - Math.exp(-18 * delta));
    }
    this.mode = !frame.grounded
      ? 'airborne'
      : !enabled || this.speed < 0.08
        ? 'idle'
        : this.speed > this.walkSpeed * 1.15
          ? 'run'
          : 'walk';
    sampleLocomotion(
      this.pose,
      this.phase,
      this.movement,
      this.running,
      this.airborne,
      reducedMotion,
    );
    this.pose.facingOffset = angleDifference(this.yaw - targetYaw);
    return this.pose;
  }

  diagnostics() {
    return {
      mode: this.mode,
      speed: this.speed,
      phase: this.phase,
      movement: this.movement,
      running: this.running,
      airborne: this.airborne,
      pose: { ...this.pose },
    };
  }
}
