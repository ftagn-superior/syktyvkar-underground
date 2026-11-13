import type { StaticPlacementEffect } from './static-placement.js';
import { PROFILE_COLORS } from './accounts.js';
import type { ItemError } from './items.js';
import type { Vec3 } from './simulation.js';

export const PROTOCOL_VERSION = 12;
export const PATCH_RATE = 20;
export const MAX_PLAYERS = 8;
export const INTEREST_RADII = { enter: 500, leave: 800 } as const;
export const RECONNECT_SECONDS = 30;
export const PREPARE_TIMEOUT_MS = 15_000;
export const RESPAWN_COOLDOWN_MS = 3000;
export const PLAYER_COLORS = PROFILE_COLORS.map((color) => color.hex);

export interface WorldInfo {
  assetReleaseVersion: string;
  layoutRevision: number;
  layoutHash: string;
  roomId: string;
  worldEpoch: string;
  protocolVersion: number;
  mapVersion: string;
  simulationConfigHash: string;
  manifestUrl: string;
  maxPlayers: number;
  available: boolean;
}
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'WORLD_FULL'
  | 'WORLD_NOT_READY'
  | 'VERSION_MISMATCH'
  | 'PREPARE_TIMEOUT'
  | 'SPAWN_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'INVALID_SKIN'
  | 'ANIMATION_NOT_ALLOWED'
  | 'COMMAND_DISABLED'
  | 'UNKNOWN_COMMAND'
  | 'RATE_LIMITED'
  | 'STALE_WORLD'
  | 'ALREADY_PROCESSED'
  | 'PLAN_REPLACED';
export interface ActionResult {
  requestId: number;
  ok: boolean;
  code?: ErrorCode | ItemError;
  /** Private feedback to the sender; never replicated as character speech. */
  message?: string;
  /** Remaining server-enforced delay before the same kind of action can be accepted. */
  retryAfterMs?: number;
  effect?: StaticPlacementEffect;
}
export interface PrepareArea {
  prepareId: string;
  layoutRevision: number;
  worldEpoch: string;
  mapVersion: string;
  reason: 'spawn' | 'respawn' | 'reconnect' | 'layout';
  position: Vec3;
  cellIds: string[];
  expiresAt: number;
  requestId?: number;
}
export interface AreaReady {
  prepareId: string;
  layoutRevision: number;
  worldEpoch: string;
  mapVersion: string;
}
export interface AreaResult extends AreaReady {
  ok: boolean;
  code?: ErrorCode;
}
export interface RespawnRequest {
  requestId: number;
  worldEpoch: string;
}
