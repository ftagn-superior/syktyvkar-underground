import {
  type AnimationClip,
  articulatedBody,
  neutralArticulatedPose,
} from '../../../apps/client/src/rendering/avatars/clips/types';

export const clip: AnimationClip = {
  rig: 'humanoid-v2',
  periodMs: 4000,
  mask: articulatedBody,
  sample(pose) {
    neutralArticulatedPose(pose);
    pose.rootPitch = -Math.PI / 2;
    pose.leftArmRoll = -0.18;
    pose.rightArmRoll = 0.18;
    pose.leftElbow = pose.rightElbow = -0.15;
    pose.leftKnee = pose.rightKnee = 0.08;
  },
};
