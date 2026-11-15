import { type AnimationClip, arms, cycle } from './types';

const periodMs = 1100;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: arms,
  sample(pose, ms) {
    const beat = cycle(ms, periodMs);
    pose.leftArm = -1.15 + 0.45 * Math.sin(beat);
    pose.rightArm = -1.15 + 0.45 * Math.sin(beat + 0.5);
    pose.leftArmYaw = 0.3 + 0.25 * Math.cos(beat);
    pose.rightArmYaw = -0.3 - 0.25 * Math.cos(beat);
    pose.leftArmRoll = -0.2;
    pose.rightArmRoll = 0.2;
  },
};
