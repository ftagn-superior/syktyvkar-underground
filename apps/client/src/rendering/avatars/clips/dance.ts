import { type AnimationClip, fullBody } from './types';

const periodMs = 800;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: fullBody,
  sample(pose, ms, reduced) {
    const phase = (ms * Math.PI * 2) / periodMs;
    const sway = Math.sin(phase);
    pose.leftArm = -0.65 + 0.5 * sway;
    pose.rightArm = -0.65 - 0.5 * sway;
    pose.leftArmYaw = pose.rightArmYaw = 0;
    pose.leftArmRoll = -0.9 - 0.25 * sway;
    pose.rightArmRoll = 0.9 - 0.25 * sway;
    pose.leftLeg = 0.3 * sway;
    pose.rightLeg = -0.3 * sway;
    pose.lean = 0.08 * Math.cos(phase) * (reduced ? 0.2 : 1);
    pose.roll = 0.12 * sway * (reduced ? 0.2 : 1);
    pose.lift = (1 - Math.cos(phase * 2)) * (reduced ? 0.003 : 0.018);
  },
};
