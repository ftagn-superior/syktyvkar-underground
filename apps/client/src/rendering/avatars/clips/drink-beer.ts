import { type AnimationClip, rightArm, cycle } from './types';

const periodMs = 5000;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: rightArm,
  prop: {
    anchor: 'right-hand',
    rotation: [1.05, 0, 0],
    parts: [
      {
        shape: 'cylinder',
        size: [0.055, 0.105, 0.055],
        position: [0, -0.012, 0.025],
        color: '#c69a32',
      },
      {
        shape: 'cylinder',
        size: [0.056, 0.045, 0.056],
        position: [0, -0.012, 0.025],
        color: '#f6e8b3',
      },
      {
        shape: 'cylinder',
        size: [0.054, 0.006, 0.054],
        position: [0, 0.0435, 0.025],
        color: '#c4cdd0',
      },
      { shape: 'box', size: [0.013, 0.002, 0.022], position: [0, 0.0475, 0.025], color: '#37434b' },
    ],
  },
  sample(pose, ms, reduced) {
    const phase = cycle(ms, periodMs);
    const sip = Math.pow((1 - Math.cos(phase)) / 2, 2);
    pose.rightArm = -1.05 - 1.15 * sip;
    pose.rightArmYaw = 0.05;
    pose.rightArmRoll = -0.12 - 0.42 * sip + (reduced ? 0 : 0.012 * Math.sin(phase * 2));
  },
};
