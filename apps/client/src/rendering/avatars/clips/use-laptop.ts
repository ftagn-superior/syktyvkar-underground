import { type AnimationClip, arms, cycle } from './types';

const periodMs = 1600;
export const clip: AnimationClip = {
  rig: 'humanoid-v1',
  periodMs,
  mask: arms,
  prop: {
    anchor: 'body',
    rotation: [0, -0.18, 0],
    parts: [
      { shape: 'box', size: [0.36, 0.018, 0.23], position: [0, 0.035, 0.3], color: '#37434b' },
      { shape: 'box', size: [0.31, 0.004, 0.11], position: [0, 0.046, 0.32], color: '#9aaeb8' },
      { shape: 'box', size: [0.095, 0.004, 0.04], position: [0, 0.046, 0.23], color: '#71838d' },
      {
        shape: 'cylinder',
        size: [0.014, 0.34, 0.014],
        position: [0, 0.045, 0.41],
        rotation: [0, 0, Math.PI / 2],
        color: '#71838d',
      },
      {
        shape: 'box',
        size: [0.36, 0.19, 0.016],
        position: [0, 0.138, 0.438],
        rotation: [-0.28, 0, 0],
        color: '#37434b',
      },
      {
        shape: 'box',
        size: [0.32, 0.155, 0.003],
        position: [0, 0.138, 0.427],
        rotation: [-0.28, 0, 0],
        color: '#71c7d5',
      },
      {
        shape: 'box',
        size: [0.18, 0.008, 0.004],
        position: [-0.03, 0.16, 0.418],
        rotation: [-0.28, 0, 0],
        color: '#d9f0ee',
      },
      {
        shape: 'box',
        size: [0.13, 0.008, 0.004],
        position: [-0.055, 0.135, 0.425],
        rotation: [-0.28, 0, 0],
        color: '#d9f0ee',
      },
      {
        shape: 'box',
        size: [0.045, 0.028, 0.004],
        position: [0, 0.14, 0.449],
        rotation: [-0.28, 0, 0],
        color: '#b7cbd0',
      },
    ],
  },
  sample(pose, ms, reduced) {
    const phase = cycle(ms, periodMs);
    const typing = (reduced ? 0.025 : 0.07) * Math.sin(phase * 2);
    pose.leftArm = -1.2 + typing;
    pose.rightArm = -1.2 - typing;
    pose.leftArmYaw = -0.12;
    pose.rightArmYaw = 0.12;
    pose.leftArmRoll = 0.16;
    pose.rightArmRoll = -0.16;
  },
};
