import { type AnimationClip, fullBody, cycle } from './types';

const periodMs = 1200;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: fullBody,
  sample(pose, ms, reduced) {
    const phase = cycle(ms, periodMs);
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
};
