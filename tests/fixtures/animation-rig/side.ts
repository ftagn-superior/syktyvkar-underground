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
    pose.rootRoll = -Math.PI / 2;
    pose.leftArm = -0.7;
    pose.rightArm = -0.3;
    pose.leftElbow = -1.3;
    pose.rightElbow = -0.9;
    pose.leftLeg = -0.35;
    pose.rightLeg = -0.2;
    pose.leftKnee = 0.65;
    pose.rightKnee = 0.4;
  },
};
