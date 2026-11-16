import { type AnimationClip, rightArm, cycle } from './types';

const periodMs = 6000;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: rightArm,
  prop: {
    anchor: 'right-hand',
    parts: [
      {
        shape: 'cylinder',
        size: [0.007, 0.048, 0.007],
        position: [0.052, 0, 0.04],
        rotation: [0, 0, Math.PI / 2],
        color: '#f4eee1',
      },
      {
        shape: 'cylinder',
        size: [0.008, 0.016, 0.008],
        position: [0.02, 0, 0.04],
        rotation: [0, 0, Math.PI / 2],
        color: '#bc844e',
      },
      {
        shape: 'cylinder',
        size: [0.008, 0.004, 0.008],
        position: [0.078, 0, 0.04],
        rotation: [0, 0, Math.PI / 2],
        color: '#e75e32',
      },
    ],
  },
  sample(pose, ms, reduced) {
    const phase = cycle(ms, periodMs);
    // Bring the cigarette to the mouth, pause, then lower it between draws.
    const draw = Math.pow((1 - Math.cos(phase)) / 2, 2);
    pose.rightArm = -1.15 - 1.05 * draw;
    pose.rightArmYaw = 0.12;
    pose.rightArmRoll = -0.18 - 0.32 * draw + (reduced ? 0 : 0.015 * Math.sin(phase * 2));
  },
};
