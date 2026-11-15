import {
  type AnimationClip,
  articulatedBody,
  articulatedArms,
  neutralArticulatedPose,
} from '../../../apps/client/src/rendering/avatars/clips/types';

export const clip: AnimationClip = {
  rig: 'humanoid-v2',
  periodMs: 4000,
  mask: articulatedBody,
  sample(pose) {
    neutralArticulatedPose(pose);
    pose.leftLeg = pose.rightLeg = -2.1;
    pose.leftKnee = pose.rightKnee = 1.1;
    pose.leftArm = pose.rightArm = -0.1;
    pose.leftArmRoll = -0.2;
    pose.rightArmRoll = 0.2;
    pose.leftElbow = pose.rightElbow = -0.6;
  },
  seated: {
    mask: articulatedArms,
    sample(pose) {
      for (const channel of articulatedArms) pose[channel] = 0;
      pose.leftArm = pose.rightArm = -0.15;
      pose.leftArmRoll = -0.15;
      pose.rightArmRoll = 0.15;
      pose.leftElbow = pose.rightElbow = -0.7;
    },
  },
};
