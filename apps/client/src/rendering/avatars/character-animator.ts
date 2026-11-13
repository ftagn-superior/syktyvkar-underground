import type { DisplayPlayer } from '../../presentation/display-state';
import { findAnimation, TICK_RATE } from '@su/contracts';
import { restingPose, sampleLocomotion, type AvatarPose } from './locomotion';
import {
  ANIMATION_CLIPS,
  ANIMATION_BLEND_MS,
  animationWeight,
  smoothWeight,
} from './animation-clips';

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
> &
  Pick<DisplayPlayer, 'animation'> &
  Partial<Pick<DisplayPlayer, 'entityId'>>;
const TAU = Math.PI * 2;
/** Путь сворачивается ради точности float; рывок колеса раз в километр незаметен. */
const TRAVEL_WRAP = 1000;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const angleDifference = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

export interface FootstepMarkers {
  /** Contacts crossed in this displayed frame, not accumulated physics steps. */
  count: number;
  running: boolean;
}

/** One visual update per rendered frame, never from a physics replay step. */
export class CharacterAnimator {
  readonly pose = restingPose();
  readonly footsteps: FootstepMarkers = { count: 0, running: false };
  private previous?: { x: number; z: number; revision: number; motionRevision: number };
  private phase = 0;
  /** Путь по земле в метрах для колёс и других вращающихся деталей. */
  private distance = 0;
  private speed = 0;
  private movement = 0;
  private running = 0;
  private airborne = 0;
  private yaw = 0;
  private mode: 'idle' | 'walk' | 'run' | 'airborne' = 'idle';
  private readonly clipPose = restingPose();
  private animationKey = '';
  private animationMask: readonly (keyof AvatarPose)[] = [];
  private transition?: { pose: AvatarPose; mask: readonly (keyof AvatarPose)[]; time: number };
  private animationDiagnostic = { id: '', elapsedMs: 0, weight: 0, reason: 'inactive' };

  constructor(
    private readonly walkSpeed: number,
    private readonly sprintSpeed: number,
  ) {}

  get travel(): number {
    return this.distance;
  }

  resetMotion(): void {
    this.previous = undefined;
    this.footsteps.count = 0;
  }

  update(frame: AvatarMotion, delta: number, predicted: boolean, reducedMotion = false) {
    this.footsteps.count = 0;
    const previousPose = { ...this.pose };
    const q = frame.rotation;
    // Remote quaternion components are interpolated before the root normalizes them.
    const targetYaw = Math.atan2(
      2 * (q.w * q.y + q.x * q.z),
      q.w * q.w + q.x * q.x - q.y * q.y - q.z * q.z,
    );
    const previous = this.previous;
    const vx = predicted
      ? frame.velocity.x
      : previous
        ? (frame.position.x - previous.x) / delta
        : 0;
    const vz = predicted
      ? frame.velocity.z
      : previous
        ? (frame.position.z - previous.z) / delta
        : 0;
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
      if (frame.grounded) this.distance = (this.distance + this.speed * delta) % TRAVEL_WRAP;
      if (moving) {
        const cyclesPerSecond = 1.85 * clamp(this.speed / this.walkSpeed) + 0.95 * this.running;
        const nextPhase = this.phase + TAU * cyclesPerSecond * delta;
        // The procedural body's vertical motion reaches the ground at 0 and PI.
        // Count crossings before wrapping so one cycle has exactly two contacts.
        this.footsteps.count = Math.floor(nextPhase / Math.PI) - Math.floor(this.phase / Math.PI);
        this.phase = nextPhase % TAU;
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
    this.footsteps.running = this.mode === 'run';
    sampleLocomotion(
      this.pose,
      this.phase,
      this.movement,
      this.running,
      this.airborne,
      reducedMotion,
    );
    const speed = Math.hypot(vx, vz);
    if (!discontinuity && enabled && frame.grounded && speed > 0.08) {
      const forward = (vx * Math.sin(targetYaw) + vz * Math.cos(targetYaw)) / speed;
      const lateral = (vx * Math.cos(targetYaw) - vz * Math.sin(targetYaw)) / speed;
      const swing = (this.pose.rightLeg - this.pose.leftLeg) / 2;
      this.pose.leftLeg = -swing * forward + 0.2 * this.airborne;
      this.pose.rightLeg = swing * forward + 0.2 * this.airborne;
      this.pose.leftLegRoll = swing * lateral;
      this.pose.rightLegRoll = -swing * lateral;
      this.pose.leftArm *= forward;
      this.pose.rightArm *= forward;
      this.pose.lean *= forward;
    }
    this.pose.facingOffset = angleDifference(this.yaw - targetYaw);
    this.applyAnimation(frame, previousPose, reducedMotion);
    return this.pose;
  }

  private applyAnimation(frame: AvatarMotion, previousPose: AvatarPose, reduced: boolean): void {
    const playback = frame.animation;
    if (!playback) {
      this.animationKey = '';
      this.transition = undefined;
      this.animationMask = [];
      this.animationDiagnostic = { id: '', elapsedMs: 0, weight: 0, reason: 'inactive' };
      return;
    }
    const identity = `${playback.worldEpoch}/${frame.entityId ?? ''}/${frame.revision}`;
    const key = `${identity}/${playback.sequence}/${playback.animationId ?? ''}`;
    const definition = findAnimation(playback.animationId);
    const clip = definition && ANIMATION_CLIPS[definition.id];
    const elapsedMs = ((playback.displayTick - playback.startedAtTick) * 1000) / TICK_RATE;
    const time = playback.displayTimeMs ?? (playback.displayTick * 1000) / TICK_RATE;
    const reason = !definition
      ? 'inactive'
      : !clip
        ? 'missing-clip'
        : clip.rig !== definition.rig
          ? 'incompatible-rig'
          : !frame.grounded
            ? 'airborne'
            : playback.endsAtTick && playback.displayTick >= playback.endsAtTick
              ? 'expired'
              : 'playing';
    const mask = reason === 'playing' ? clip!.mask : [];
    if (key !== this.animationKey) {
      // Entity/revision changes must discard decorative history as well as locomotion.
      this.transition =
        this.animationKey.startsWith(`${identity}/`) && this.animationMask.length
          ? { pose: previousPose, mask: this.animationMask, time }
          : undefined;
      this.animationKey = key;
    }
    // Falling always wins over the decorative pose.
    if (!frame.grounded) this.transition = undefined;
    const weight =
      reason === 'playing'
        ? animationWeight(
            elapsedMs,
            playback.endsAtTick
              ? ((playback.endsAtTick - playback.startedAtTick) * 1000) / TICK_RATE
              : Infinity,
          )
        : 0;
    if (weight > 0) {
      clip!.sample(this.clipPose, elapsedMs, reduced);
      for (const joint of mask)
        this.pose[joint] += (this.clipPose[joint] - this.pose[joint]) * weight;
    }
    if (this.transition) {
      const t = smoothWeight((time - this.transition.time) / ANIMATION_BLEND_MS);
      for (const joint of this.transition.mask)
        this.pose[joint] =
          this.transition.pose[joint] + (this.pose[joint] - this.transition.pose[joint]) * t;
      if (t >= 1) this.transition = undefined;
    }
    this.animationMask = mask.length ? mask : (this.transition?.mask ?? []);
    this.animationDiagnostic = { id: playback.animationId ?? '', elapsedMs, weight, reason };
  }

  diagnostics() {
    return {
      mode: this.mode,
      speed: this.speed,
      phase: this.phase,
      movement: this.movement,
      running: this.running,
      airborne: this.airborne,
      animation: { ...this.animationDiagnostic },
      pose: { ...this.pose },
    };
  }
}
