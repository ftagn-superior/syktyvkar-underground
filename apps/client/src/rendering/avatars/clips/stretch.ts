import { type AnimationClip, fullBody, cycle } from './types';

const periodMs = 3200;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: fullBody,
  sample(pose, ms, reduced) {
    const reach = Math.sin(cycle(ms, periodMs));
    pose.leftArm = pose.rightArm = -0.08;
    pose.leftArmYaw = pose.rightArmYaw = 0;
    pose.leftArmRoll = -2.9 - 0.1 * reach;
    pose.rightArmRoll = 2.9 + 0.1 * reach;
    pose.lean = (-0.05 - 0.03 * reach) * (reduced ? 0.2 : 1);
    pose.leftLeg = pose.rightLeg = -pose.lean;
    pose.roll = 0;
    pose.lift = (1 + reach) * (reduced ? 0.001 : 0.005);
  },
};
