import { type AnimationClip, rightArm } from './types';

const periodMs = 1570.7963267948965;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: rightArm,
  sample(pose, ms) {
    pose.rightArm = -0.18;
    pose.rightArmYaw = 0.12 * Math.sin(ms * 0.008);
    pose.rightArmRoll = 2.5 + 0.3 * Math.sin(ms * 0.012);
  },
};
