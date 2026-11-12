import type { AnimationId } from '@su/contracts';
import type { AvatarPose } from './locomotion';

export interface AnimationClip {
  rig: 'humanoid-v1';
  mask: readonly (keyof AvatarPose)[];
  sample(pose: AvatarPose, elapsedMs: number, reducedMotion: boolean): void;
}
const rightArm = ['rightArm', 'rightArmYaw', 'rightArmRoll'] as const;
const arms = ['leftArm', 'leftArmYaw', 'leftArmRoll', ...rightArm] as const;

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
    mask: [...arms, 'leftLeg', 'rightLeg', 'lean', 'roll', 'lift'],
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
