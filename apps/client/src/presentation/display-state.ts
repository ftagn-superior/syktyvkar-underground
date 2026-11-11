import type { AvatarSkinId, DisplayReaction, ItemState, PlayerState } from '@su/contracts';

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
}

export type DisplayEntity = DisplayPlayer | (ItemState & Appearance);
