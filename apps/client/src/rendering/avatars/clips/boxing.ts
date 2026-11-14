import { type AnimationClip, fullBody, cycle } from './types';

const periodMs = 900;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: fullBody,
  sample(pose, ms, reduced) {
    const phase = cycle(ms, periodMs);
    const jab = (1 + Math.sin(phase)) / 2;
    pose.leftArm = -1 - 0.65 * jab;
    pose.rightArm = -1 - 0.65 * (1 - jab);
    pose.leftArmYaw = 0.4 * (1 - jab);
    pose.rightArmYaw = -0.4 * jab;
    pose.leftArmRoll = pose.rightArmRoll = 0;
    pose.leftLeg = 0.12;
    pose.rightLeg = -0.12;
    pose.lean = 0.08 * (reduced ? 0.2 : 1);
    pose.roll = 0.06 * Math.sin(phase) * (reduced ? 0.2 : 1);
    pose.lift = (1 - Math.cos(phase * 2)) * (reduced ? 0.001 : 0.006);
  },
};
