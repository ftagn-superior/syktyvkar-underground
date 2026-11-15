import { type AnimationClip, fullBody, cycle } from './types';

const periodMs = 1000;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: fullBody,
  sample(pose, ms, reduced) {
    const phase = cycle(ms, periodMs);
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
};
