import { type AnimationClip, fullBody, cycle } from './types';

const periodMs = 2800;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: fullBody,
  sample(pose, ms, reduced) {
    const bend = (1 - Math.cos(cycle(ms, periodMs))) * 0.28 * (reduced ? 0.35 : 1);
    pose.leftArm = pose.rightArm = -0.15;
    pose.leftArmYaw = pose.rightArmYaw = 0;
    pose.leftArmRoll = -0.12;
    pose.rightArmRoll = 0.12;
    pose.leftLeg = pose.rightLeg = -bend;
    pose.lean = bend;
    pose.roll = pose.lift = 0;
  },
};
