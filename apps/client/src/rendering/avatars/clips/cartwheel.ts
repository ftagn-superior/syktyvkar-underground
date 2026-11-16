import { type AnimationClip, articulatedBody, neutralArticulatedPose, cycle } from './types';

// Repeating six-second wheel in the reserved ground space; no physical root motion.
export const clip: AnimationClip = {
  rig: 'humanoid-v2',
  periodMs: 6000,
  mask: articulatedBody,
  sample(pose, ms, reduced) {
    neutralArticulatedPose(pose);
    const phase = cycle(ms % 6000, 6000);
    pose.leftArmRoll = reduced ? -1.1 : -Math.PI;
    pose.rightArmRoll = reduced ? 1.1 : Math.PI;
    pose.leftLegRoll = -0.45;
    pose.rightLegRoll = 0.45;
    pose.leftElbow = pose.rightElbow = reduced ? -0.4 : 0;
    pose.leftKnee = pose.rightKnee = reduced ? 0.15 : 0.08;
    pose.rootRoll = reduced ? 0 : phase;
    // Short-armed skins need the head outside the hand-support plane at inversion.
    // Counter-pitch the shoulders so the forearms still reach down toward the floor.
    pose.rootPitch = reduced ? 0 : (-0.95 * (1 - Math.cos(phase))) / 2;
    pose.leftArm = pose.rightArm = pose.rootPitch;
    pose.rootX = reduced ? 0 : 0.08 * Math.sin(phase);
  },
};
