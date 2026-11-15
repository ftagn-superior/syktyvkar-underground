import type { AvatarPose } from '../locomotion';

/** Cosmetic geometry only. Dimensions/positions are fractions of character height. */
export interface AnimationProp {
  anchor: 'right-hand' | 'body';
  /** Assembly orientation around the attachment, radians. */
  rotation?: readonly [number, number, number];
  parts: readonly {
    shape: 'box' | 'cylinder';
    size: readonly [number, number, number];
    position: readonly [number, number, number];
    rotation?: readonly [number, number, number];
    color: string;
  }[];
}

export interface AnimationClip {
  rig: 'humanoid-v1';
  /** Period of the complete pose, milliseconds. Sampling uses absolute elapsed time. */
  periodMs: number;
  mask: readonly (keyof AvatarPose)[];
  /** Owned by the avatar view; never a physical item or inventory entry. */
  prop?: AnimationProp;
  sample(pose: AvatarPose, elapsedMs: number, reducedMotion: boolean): void;
}
export const rightArm = ['rightArm', 'rightArmYaw', 'rightArmRoll'] as const;
export const arms = ['leftArm', 'leftArmYaw', 'leftArmRoll', ...rightArm] as const;
export const fullBody = [...arms, 'leftLeg', 'rightLeg', 'lean', 'roll', 'lift'] as const;
export const cycle = (ms: number, periodMs: number) => (ms * Math.PI * 2) / periodMs;
