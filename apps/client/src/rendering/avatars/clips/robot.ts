import { type AnimationClip, fullBody, cycle } from './types';

const periodMs = 1800;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: fullBody,
  sample(pose, ms, reduced) {
    const phase = cycle(ms, periodMs);
    // Smooth, short transitions between angular poses rather than discontinuous steps.
    const turn = Math.tanh(4 * Math.sin(phase));
    const step = Math.tanh(4 * Math.cos(phase));
    pose.leftArm = -1.2 - 0.4 * step;
    pose.rightArm = -1.2 + 0.4 * step;
    pose.leftArmYaw = 0.65 * turn;
    pose.rightArmYaw = -0.65 * turn;
    pose.leftArmRoll = -0.25;
    pose.rightArmRoll = 0.25;
    pose.leftLeg = 0.18 * step;
    pose.rightLeg = -0.18 * step;
    pose.lean = 0;
    pose.roll = 0.08 * turn * (reduced ? 0.2 : 1);
    pose.lift = 0;
  },
};
