export interface AvatarPose {
  leftArm: number;
  rightArm: number;
  leftLeg: number;
  rightLeg: number;
  leftLegRoll: number;
  rightLegRoll: number;
  leftArmYaw: number;
  rightArmYaw: number;
  leftArmRoll: number;
  rightArmRoll: number;
  lean: number;
  roll: number;
  /** Vertical offset as a fraction of character height. */
  lift: number;
  /** Local correction relative to the entity's world rotation. */
  facingOffset: number;
}

export function restingPose(): AvatarPose {
  return {
    leftArm: 0,
    rightArm: 0,
    leftLeg: 0,
    rightLeg: 0,
    leftLegRoll: 0,
    rightLegRoll: 0,
    leftArmYaw: 0,
    rightArmYaw: 0,
    leftArmRoll: -0.1,
    rightArmRoll: 0.1,
    lean: 0,
    roll: 0,
    lift: 0,
    facingOffset: 0,
  };
}

/** Pure pose calculation; scene nodes are written only by AvatarView. */
export function sampleLocomotion(
  pose: AvatarPose,
  phase: number,
  movement: number,
  running: number,
  airborne: number,
  reducedMotion: boolean,
): void {
  const groundedMovement = movement * (1 - airborne);
  const swing = Math.sin(phase) * (0.62 + 0.4 * running) * groundedMovement;
  pose.leftLeg = -swing + 0.2 * airborne;
  pose.rightLeg = swing + 0.2 * airborne;
  pose.leftLegRoll = pose.rightLegRoll = 0;
  pose.leftArm = swing * 0.8 - 0.3 * airborne;
  pose.rightArm = -swing * 0.8 - 0.3 * airborne;
  pose.leftArmYaw = pose.rightArmYaw = 0;
  pose.leftArmRoll = -(0.1 + 0.6 * airborne);
  pose.rightArmRoll = 0.1 + 0.6 * airborne;
  pose.lean =
    ((0.07 + 0.14 * running) * groundedMovement - 0.06 * airborne) * (reducedMotion ? 0.35 : 1);
  pose.roll = reducedMotion ? 0 : Math.sin(phase) * 0.025 * groundedMovement;
  pose.lift = reducedMotion
    ? 0
    : (1 - Math.cos(phase * 2)) * (0.008 + 0.005 * running) * groundedMovement;
}
