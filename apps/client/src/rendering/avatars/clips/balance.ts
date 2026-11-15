import { type AnimationClip, fullBody, cycle } from './types';

const periodMs = 2400;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: fullBody,
  sample(pose, ms, reduced) {
    const wobble = Math.sin(cycle(ms, periodMs));
    pose.leftArm = pose.rightArm = 0;
    pose.leftArmYaw = pose.rightArmYaw = 0;
    pose.leftArmRoll = -1.5 - 0.08 * wobble;
    pose.rightArmRoll = 1.5 - 0.08 * wobble;
    pose.lean = 0.25 * (reduced ? 0.2 : 1);
    pose.leftLeg = -pose.lean;
    pose.rightLeg = 0.85 + 0.08 * wobble - pose.lean;
    pose.roll = 0.04 * wobble * (reduced ? 0.2 : 1);
    pose.lift = 0;
  },
};
