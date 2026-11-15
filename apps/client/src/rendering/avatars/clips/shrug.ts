import { type AnimationClip, arms, cycle } from './types';

const periodMs = 2200;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: arms,
  sample(pose, ms) {
    const raise = (1 + Math.sin(cycle(ms, periodMs))) / 2;
    pose.leftArm = pose.rightArm = -0.3;
    pose.leftArmYaw = -0.2;
    pose.rightArmYaw = 0.2;
    pose.leftArmRoll = -0.55 - 0.55 * raise;
    pose.rightArmRoll = 0.55 + 0.55 * raise;
  },
};
