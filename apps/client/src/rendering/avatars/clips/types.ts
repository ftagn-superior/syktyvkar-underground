import type { AvatarPose } from '../locomotion';

export interface AnimationClip {
  rig: 'humanoid-v1';
  /** Period of the complete pose, milliseconds. Sampling uses absolute elapsed time. */
  periodMs: number;
  mask: readonly (keyof AvatarPose)[];
  sample(pose: AvatarPose, elapsedMs: number, reducedMotion: boolean): void;
}
export const rightArm = ['rightArm', 'rightArmYaw', 'rightArmRoll'] as const;
export const arms = ['leftArm', 'leftArmYaw', 'leftArmRoll', ...rightArm] as const;
export const fullBody = [...arms, 'leftLeg', 'rightLeg', 'lean', 'roll', 'lift'] as const;
export const cycle = (ms: number, periodMs: number) => (ms * Math.PI * 2) / periodMs;
