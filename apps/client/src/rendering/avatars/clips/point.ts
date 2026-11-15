import { type AnimationClip, rightArm, cycle } from './types';

const periodMs = 1800;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: rightArm,
  sample(pose, ms) {
    pose.rightArm = -1.5 + 0.08 * Math.sin(cycle(ms, periodMs));
    pose.rightArmYaw = -0.25;
    pose.rightArmRoll = 0.1;
  },
};
