import type {
  AnimationPlayback,
  AvatarSkinId,
  DisplayReaction,
  ItemState,
  PlayerState,
} from '@su/contracts';

export interface DisplayAnimation extends AnimationPlayback {
  worldEpoch: string;
  displayTick: number;
  /** Room-clock display time continues through a paused simulation for decorative fades. */
  displayTimeMs?: number;
}

interface Appearance {
  name?: string;
  color?: string;
  connected?: boolean;
  reaction?: DisplayReaction;
}

export interface DisplayPlayer extends PlayerState, Appearance {
  skinId: AvatarSkinId;
  /** Local discontinuities, independent of the server's respawn revision. */
  motionRevision: number;
  motionEnabled: boolean;
  animation?: DisplayAnimation;
  /** Local accepted control intent gives locomotion immediate priority over a dance. */
  animationMoving?: boolean;
}

export type DisplayEntity = DisplayPlayer | (ItemState & Appearance);
