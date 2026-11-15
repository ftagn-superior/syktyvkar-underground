import { type AnimationClip, fullBody, cycle } from './types';

const periodMs = 2600;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: fullBody,
  sample(pose, ms, reduced) {
    const phase = cycle(ms, periodMs);
    const side = Math.sin(phase);
    pose.leftArm = 0.12 * Math.cos(phase);
    pose.rightArm = -pose.leftArm;
    pose.leftArmYaw = pose.rightArmYaw = 0;
    pose.leftArmRoll = -0.3 - 0.12 * side;
    pose.rightArmRoll = 0.3 - 0.12 * side;
    pose.leftLeg = 0.08 * side;
    pose.rightLeg = -0.08 * side;
    pose.lean = 0;
    pose.roll = 0.16 * side * (reduced ? 0.2 : 1);
    pose.lift = 0;
  },
};
