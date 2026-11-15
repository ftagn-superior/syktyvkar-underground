import { type AnimationClip, arms } from './types';

const periodMs = 550;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: arms,
  sample(pose, ms) {
    // Raise the rigid arms in front, then sweep both hands to the centre.
    const opening = (1 + Math.cos((ms * Math.PI * 2) / periodMs)) / 2;
    pose.leftArm = pose.rightArm = -Math.PI / 2;
    pose.leftArmYaw = 0.58 - 0.73 * opening;
    pose.rightArmYaw = -pose.leftArmYaw;
    pose.leftArmRoll = pose.rightArmRoll = 0;
  },
};
