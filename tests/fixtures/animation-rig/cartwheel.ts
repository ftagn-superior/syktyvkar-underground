import {
  type AnimationClip,
  articulatedBody,
  neutralArticulatedPose,
  cycle,
} from '../../../apps/client/src/rendering/avatars/clips/types';

export const clip: AnimationClip = {
  rig: 'humanoid-v2',
  periodMs: 6000,
  mask: articulatedBody,
  sample(pose, ms, reduced) {
    neutralArticulatedPose(pose);
    const phase = cycle(ms % 6000, 6000);
    pose.leftArmRoll = reduced ? -1.1 : -2.9;
    pose.rightArmRoll = reduced ? 1.1 : 2.9;
    pose.leftLegRoll = -0.45;
    pose.rightLegRoll = 0.45;
    pose.leftElbow = pose.rightElbow = reduced ? -0.4 : -0.08;
    pose.leftKnee = pose.rightKnee = reduced ? 0.15 : 0.08;
    pose.rootRoll = reduced ? 0 : phase;
    pose.rootX = reduced ? 0 : 0.08 * Math.sin(phase);
  },
};
