import { type AnimationClip, arms, cycle } from './types';

const periodMs = 650;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: arms,
  sample(pose, ms) {
    const pump = Math.sin(cycle(ms, periodMs));
    pose.leftArm = pose.rightArm = -0.15;
    pose.leftArmYaw = pose.rightArmYaw = 0;
    pose.leftArmRoll = -2.55 - 0.25 * pump;
    pose.rightArmRoll = 2.55 + 0.25 * pump;
  },
};
