import type { AvatarPose } from '../locomotion';
import type { AnimationRig } from '@su/contracts';

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

export interface AnimationSampler {
  mask: readonly (keyof AvatarPose)[];
  sample(pose: AvatarPose, elapsedMs: number, reducedMotion: boolean): void;
}
export interface AnimationClip extends AnimationSampler {
  rig: AnimationRig;
  /** Period of the complete pose, milliseconds. Sampling uses absolute elapsed time. */
  periodMs: number;
  /** Owned by the avatar view; never a physical item or inventory entry. */
  prop?: AnimationProp;
  /** Explicit preserve-seat alternative. Required iff metadata says seated=variant. */
  seated?: AnimationSampler;
}
export const rightArm = ['rightArm', 'rightArmYaw', 'rightArmRoll'] as const;
export const arms = ['leftArm', 'leftArmYaw', 'leftArmRoll', ...rightArm] as const;
export const fullBody = [...arms, 'leftLeg', 'rightLeg', 'lean', 'roll', 'lift'] as const;
/** Legacy masks deliberately stay byte-for-byte equivalent in meaning. */
export const articulatedArms = [...arms, 'leftElbow', 'rightElbow'] as const;
export const rootChannels = [
  'rootPitch',
  'rootYaw',
  'rootRoll',
  'rootX',
  'rootY',
  'rootZ',
] as const;
export const articulatedBody = [
  ...articulatedArms,
  'leftLeg',
  'rightLeg',
  'leftLegRoll',
  'rightLegRoll',
  'leftKnee',
  'rightKnee',
  'lean',
  'roll',
  'lift',
  ...rootChannels,
] as const;
export const v2Channels = [
  'leftElbow',
  'rightElbow',
  'leftKnee',
  'rightKnee',
  ...rootChannels,
] as const;
/** Use only with the complete articulatedBody mask. Does not write facingOffset. */
export function neutralArticulatedPose(pose: AvatarPose): void {
  for (const channel of articulatedBody) pose[channel] = 0;
}
export const cycle = (ms: number, periodMs: number) => (ms * Math.PI * 2) / periodMs;
