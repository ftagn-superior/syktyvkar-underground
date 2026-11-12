import type { AnimationId } from '@su/contracts';
import type { AvatarPose } from './locomotion';

export interface AnimationClip {
  rig: 'humanoid-v1';
  mask: readonly (keyof AvatarPose)[];
  sample(pose: AvatarPose, elapsedMs: number, reducedMotion: boolean): void;
}
const rightArm = ['rightArm', 'rightArmYaw', 'rightArmRoll'] as const;
const arms = ['leftArm', 'leftArmYaw', 'leftArmRoll', ...rightArm] as const;
const fullBody = [...arms, 'leftLeg', 'rightLeg', 'lean', 'roll', 'lift'] as const;
const cycle = (ms: number, periodMs: number) => (ms * Math.PI * 2) / periodMs;

/** Pure joint poses. No scene resources or physics are owned by a clip. */
export const ANIMATION_CLIPS: Record<AnimationId, AnimationClip> = {
  wave: {
    rig: 'humanoid-v1',
    mask: rightArm,
    sample(pose, ms) {
      pose.rightArm = -0.18;
      pose.rightArmYaw = 0.12 * Math.sin(ms * 0.008);
      pose.rightArmRoll = 2.5 + 0.3 * Math.sin(ms * 0.012);
    },
  },
  clap: {
    rig: 'humanoid-v1',
    mask: arms,
    sample(pose, ms) {
      // Raise the rigid arms in front, then sweep both hands to the centre.
      const opening = (1 + Math.cos((ms * Math.PI * 2) / 550)) / 2;
      pose.leftArm = pose.rightArm = -Math.PI / 2;
      pose.leftArmYaw = 0.58 - 0.73 * opening;
      pose.rightArmYaw = -pose.leftArmYaw;
      pose.leftArmRoll = pose.rightArmRoll = 0;
    },
  },
  dance: {
    rig: 'humanoid-v1',
    mask: fullBody,
    sample(pose, ms, reduced) {
      const phase = (ms * Math.PI * 2) / 800;
      const sway = Math.sin(phase);
      pose.leftArm = -0.65 + 0.5 * sway;
      pose.rightArm = -0.65 - 0.5 * sway;
      pose.leftArmYaw = pose.rightArmYaw = 0;
      pose.leftArmRoll = -0.9 - 0.25 * sway;
      pose.rightArmRoll = 0.9 - 0.25 * sway;
      pose.leftLeg = 0.3 * sway;
      pose.rightLeg = -0.3 * sway;
      pose.lean = 0.08 * Math.cos(phase) * (reduced ? 0.2 : 1);
      pose.roll = 0.12 * sway * (reduced ? 0.2 : 1);
      pose.lift = (1 - Math.cos(phase * 2)) * (reduced ? 0.003 : 0.018);
    },
  },
  point: {
    rig: 'humanoid-v1',
    mask: rightArm,
    sample(pose, ms) {
      pose.rightArm = -1.5 + 0.08 * Math.sin(cycle(ms, 1800));
      pose.rightArmYaw = -0.25;
      pose.rightArmRoll = 0.1;
    },
  },
  cheer: {
    rig: 'humanoid-v1',
    mask: arms,
    sample(pose, ms) {
      const pump = Math.sin(cycle(ms, 650));
      pose.leftArm = pose.rightArm = -0.15;
      pose.leftArmYaw = pose.rightArmYaw = 0;
      pose.leftArmRoll = -2.55 - 0.25 * pump;
      pose.rightArmRoll = 2.55 + 0.25 * pump;
    },
  },
  shrug: {
    rig: 'humanoid-v1',
    mask: arms,
    sample(pose, ms) {
      const raise = (1 + Math.sin(cycle(ms, 2200))) / 2;
      pose.leftArm = pose.rightArm = -0.3;
      pose.leftArmYaw = -0.2;
      pose.rightArmYaw = 0.2;
      pose.leftArmRoll = -0.55 - 0.55 * raise;
      pose.rightArmRoll = 0.55 + 0.55 * raise;
    },
  },
  bow: {
    rig: 'humanoid-v1',
    mask: fullBody,
    sample(pose, ms, reduced) {
      const bend = (1 - Math.cos(cycle(ms, 2800))) * 0.28 * (reduced ? 0.35 : 1);
      pose.leftArm = pose.rightArm = -0.15;
      pose.leftArmYaw = pose.rightArmYaw = 0;
      pose.leftArmRoll = -0.12;
      pose.rightArmRoll = 0.12;
      pose.leftLeg = pose.rightLeg = -bend;
      pose.lean = bend;
      pose.roll = pose.lift = 0;
    },
  },
  stretch: {
    rig: 'humanoid-v1',
    mask: fullBody,
    sample(pose, ms, reduced) {
      const reach = Math.sin(cycle(ms, 3200));
      pose.leftArm = pose.rightArm = -0.08;
      pose.leftArmYaw = pose.rightArmYaw = 0;
      pose.leftArmRoll = -2.9 - 0.1 * reach;
      pose.rightArmRoll = 2.9 + 0.1 * reach;
      pose.lean = (-0.05 - 0.03 * reach) * (reduced ? 0.2 : 1);
      pose.leftLeg = pose.rightLeg = -pose.lean;
      pose.roll = 0;
      pose.lift = (1 + reach) * (reduced ? 0.001 : 0.005);
    },
  },
  march: {
    rig: 'humanoid-v1',
    mask: fullBody,
    sample(pose, ms, reduced) {
      const phase = cycle(ms, 1000);
      const step = Math.sin(phase);
      pose.leftArm = 0.8 * step;
      pose.rightArm = -0.8 * step;
      pose.leftArmYaw = pose.rightArmYaw = 0;
      pose.leftArmRoll = -0.12;
      pose.rightArmRoll = 0.12;
      pose.leftLeg = -0.75 * step;
      pose.rightLeg = 0.75 * step;
      pose.lean = pose.roll = 0;
      pose.lift = (1 - Math.cos(phase * 2)) * (reduced ? 0.002 : 0.012);
    },
  },
  balance: {
    rig: 'humanoid-v1',
    mask: fullBody,
    sample(pose, ms, reduced) {
      const wobble = Math.sin(cycle(ms, 2400));
      pose.leftArm = pose.rightArm = 0;
      pose.leftArmYaw = pose.rightArmYaw = 0;
      pose.leftArmRoll = -1.5 - 0.08 * wobble;
      pose.rightArmRoll = 1.5 - 0.08 * wobble;
      pose.lean = 0.25 * (reduced ? 0.2 : 1);
      pose.leftLeg = -pose.lean;
      pose.rightLeg = 0.85 + 0.08 * wobble - pose.lean;
      pose.roll = 0.04 * wobble * (reduced ? 0.2 : 1);
      pose.lift = 0;
    },
  },
  boxing: {
    rig: 'humanoid-v1',
    mask: fullBody,
    sample(pose, ms, reduced) {
      const phase = cycle(ms, 900);
      const jab = (1 + Math.sin(phase)) / 2;
      pose.leftArm = -1 - 0.65 * jab;
      pose.rightArm = -1 - 0.65 * (1 - jab);
      pose.leftArmYaw = 0.4 * (1 - jab);
      pose.rightArmYaw = -0.4 * jab;
      pose.leftArmRoll = pose.rightArmRoll = 0;
      pose.leftLeg = 0.12;
      pose.rightLeg = -0.12;
      pose.lean = 0.08 * (reduced ? 0.2 : 1);
      pose.roll = 0.06 * Math.sin(phase) * (reduced ? 0.2 : 1);
      pose.lift = (1 - Math.cos(phase * 2)) * (reduced ? 0.001 : 0.006);
    },
  },
  disco: {
    rig: 'humanoid-v1',
    mask: fullBody,
    sample(pose, ms, reduced) {
      const phase = cycle(ms, 1200);
      const point = Math.sin(phase);
      pose.leftArm = pose.rightArm = -0.15;
      pose.leftArmYaw = 0.15;
      pose.rightArmYaw = -0.15;
      pose.leftArmRoll = -1.5 + 1.1 * point;
      pose.rightArmRoll = 1.5 + 1.1 * point;
      pose.leftLeg = 0.22 * point;
      pose.rightLeg = -0.22 * point;
      pose.lean = 0.04 * Math.cos(phase) * (reduced ? 0.2 : 1);
      pose.roll = 0.1 * point * (reduced ? 0.2 : 1);
      pose.lift = 0;
    },
  },
  robot: {
    rig: 'humanoid-v1',
    mask: fullBody,
    sample(pose, ms, reduced) {
      const phase = cycle(ms, 1800);
      // Smooth, short transitions between angular poses rather than discontinuous steps.
      const turn = Math.tanh(4 * Math.sin(phase));
      const step = Math.tanh(4 * Math.cos(phase));
      pose.leftArm = -1.2 - 0.4 * step;
      pose.rightArm = -1.2 + 0.4 * step;
      pose.leftArmYaw = 0.65 * turn;
      pose.rightArmYaw = -0.65 * turn;
      pose.leftArmRoll = -0.25;
      pose.rightArmRoll = 0.25;
      pose.leftLeg = 0.18 * step;
      pose.rightLeg = -0.18 * step;
      pose.lean = 0;
      pose.roll = 0.08 * turn * (reduced ? 0.2 : 1);
      pose.lift = 0;
    },
  },
  sway: {
    rig: 'humanoid-v1',
    mask: fullBody,
    sample(pose, ms, reduced) {
      const phase = cycle(ms, 2600);
      const side = Math.sin(phase);
      pose.leftArm = 0.12 * Math.cos(phase);
      pose.rightArm = -pose.leftArm;
      pose.leftArmYaw = pose.rightArmYaw = 0;
      pose.leftArmRoll = -0.3 - 0.12 * side;
      pose.rightArmRoll = 0.3 - 0.12 * side;
      pose.leftLeg = 0.08 * side;
      pose.rightLeg = -0.08 * side;
      pose.lean = 0;
      pose.roll = 0.16 * side * (reduced ? 0.2 : 1);
      pose.lift = 0;
    },
  },
  conduct: {
    rig: 'humanoid-v1',
    mask: arms,
    sample(pose, ms) {
      const beat = cycle(ms, 1100);
      pose.leftArm = -1.15 + 0.45 * Math.sin(beat);
      pose.rightArm = -1.15 + 0.45 * Math.sin(beat + 0.5);
      pose.leftArmYaw = 0.3 + 0.25 * Math.cos(beat);
      pose.rightArmYaw = -0.3 - 0.25 * Math.cos(beat);
      pose.leftArmRoll = -0.2;
      pose.rightArmRoll = 0.2;
    },
  },
};
export const ANIMATION_BLEND_MS = 150;
export const smoothWeight = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
export function animationWeight(elapsedMs: number, durationMs: number): number {
  return (
    smoothWeight(elapsedMs / ANIMATION_BLEND_MS) *
    smoothWeight((durationMs - elapsedMs) / ANIMATION_BLEND_MS)
  );
}
