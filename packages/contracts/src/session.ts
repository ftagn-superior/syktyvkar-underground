import type { PlacementCatalogReference } from './placement-catalog.js';
import type { StaticPlacementEffect } from './static-placement.js';
import type { StaticRemovalEffect } from './static-removal.js';
import { PROFILE_COLORS } from './accounts.js';
import type { ItemError } from './items.js';
import type { Vec3 } from './simulation.js';
import type { WorldPublicationInfo } from './static-placement.js';

export const PROTOCOL_VERSION = 19;
export const PATCH_RATE = 20;
export const MAX_PLAYERS = 8;
export const INTEREST_RADII = { enter: 500, leave: 800 } as const;
export const RECONNECT_SECONDS = 30;
export const PREPARE_TIMEOUT_MS = 15_000;
export const RESPAWN_COOLDOWN_MS = 3000;
export const PLAYER_COLORS = PROFILE_COLORS.map((color) => color.hex);

export interface WorldInfo {
  placementCatalog?: PlacementCatalogReference;
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
  effect?: StaticPlacementEffect | StaticRemovalEffect;
}
export interface PrepareArea {
  prepareId: string;
  layoutRevision: number;
  worldEpoch: string;
  mapVersion: string;
  reason: 'spawn' | 'respawn' | 'reconnect' | 'layout';
  /** Initial spawn candidate; unused for respawn, reconnect and layout preparation. */
  spawnSource?: 'saved' | 'default';
  /** Center of the physical character capsule, including for ordinary spawn points. */
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
export interface AreaFailed extends AreaReady {
  code: 'RESOURCE_UNAVAILABLE';
}
/** A local resource failure cannot supply coordinates or choose a different spawn source. */
export function parseAreaFailed(value: unknown): AreaFailed | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'code,layoutRevision,mapVersion,prepareId,worldEpoch' ||
    v.code !== 'RESOURCE_UNAVAILABLE' ||
    !Number.isSafeInteger(v.layoutRevision) ||
    (v.layoutRevision as number) < 1 ||
    !['prepareId', 'worldEpoch', 'mapVersion'].every(
      (key) => typeof v[key] === 'string' && v[key].length > 0 && v[key].length <= 128,
    )
  )
    return;
  return v as unknown as AreaFailed;
}
export interface AreaResult extends AreaReady {
  ok: boolean;
  code?: ErrorCode;
}
/** Committed publication; changed cells are a hint, never a substitute for manifest verification. */
export interface LayoutChanged {
  operationId: string;
  previousLayoutRevision: number;
  previousMapVersion: string;
  publication: WorldPublicationInfo;
  changedCellIds: string[];
}
/** Sent after migration and cancellation of all consumers of the previous publication. */
export interface LayoutApplied {
  worldEpoch: string;
  layoutRevision: number;
  mapVersion: string;
}
export interface RespawnRequest {
  requestId: number;
  worldEpoch: string;
}
