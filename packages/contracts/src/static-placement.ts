import type { PlacementCatalogReference } from './placement-catalog.js';
import type { Quat } from './simulation.js';
import type { StaticObjectInstance } from './world-types.js';

export const MAX_EDITABLE_STATIC_INSTANCES = 10_000;
export const LEGACY_PLACEMENT_CATALOG_VERSION = '0'.repeat(64);
/** Only for reconciling persisted v13 requests. New placements always select an asset. */
export const STATIC_PLACEMENT_ASSET_ID = 'bench-0152a250d22ef0a9';
export const STATIC_PLACEMENT_GROUND_Y = 0;
export const STATIC_PLACEMENT_YAW_STEPS = 24;
export const STATIC_PLACEMENT_COOLDOWN_MS = 2000;
export interface WorldPublicationInfo {
  worldEpoch: string;
  assetReleaseVersion: string;
  layoutRevision: number;
  layoutHash: string;
  mapVersion: string;
  simulationConfigHash: string;
  manifestUrl: string;
}
export interface PlaceStaticRequest {
  assetId: string;
  placementCatalogVersion: string;
  operationId: string;
  worldEpoch: string;
  assetReleaseVersion: string;
  expectedLayoutRevision: number;
  position: { x: number; z: number };
  yawStep: number;
}
export type StaticPlacementError =
  | 'CATALOG_CHANGED'
  | 'ASSET_NOT_ALLOWED'
  | 'AUTH_REQUIRED'
  | 'COMMAND_DISABLED'
  | 'WORLD_NOT_READY'
  | 'STALE_WORLD'
  | 'VERSION_MISMATCH'
  | 'LAYOUT_CHANGED'
  | 'INVALID_INPUT'
  | 'OUT_OF_BOUNDS'
  | 'BLOCKED'
  | 'RATE_LIMITED'
  | 'CONTENT_LIMIT'
  | 'OPERATION_CONFLICT'
  | 'STORAGE_UNAVAILABLE';
export type PlaceStaticResult =
  | { operationId: string; ok: true; entityId: string; layoutRevision: number }
  | { operationId: string; ok: false; code: StaticPlacementError; message?: string };
export interface StaticPlacementEffect {
  kind: 'staticPlacement';
  catalog: PlacementCatalogReference;
  publication: WorldPublicationInfo;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function parsePlaceStaticRequest(v: unknown): PlaceStaticRequest | undefined {
  if (
    !record(v) ||
    Object.keys(v).sort().join(',') !==
      'assetId,assetReleaseVersion,expectedLayoutRevision,operationId,placementCatalogVersion,position,worldEpoch,yawStep'
  )
    return;
  if (
    typeof v.assetId !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,79}$/.test(v.assetId) ||
    typeof v.placementCatalogVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.placementCatalogVersion) ||
    typeof v.operationId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.operationId) ||
    typeof v.worldEpoch !== 'string' ||
    v.worldEpoch.length > 80 ||
    !v.worldEpoch ||
    typeof v.assetReleaseVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.assetReleaseVersion) ||
    !Number.isSafeInteger(v.expectedLayoutRevision) ||
    (v.expectedLayoutRevision as number) < 1 ||
    !Number.isInteger(v.yawStep) ||
    (v.yawStep as number) < 0 ||
    (v.yawStep as number) >= STATIC_PLACEMENT_YAW_STEPS ||
    !record(v.position) ||
    Object.keys(v.position).sort().join(',') !== 'x,z' ||
    typeof v.position.x !== 'number' ||
    !Number.isFinite(v.position.x) ||
    typeof v.position.z !== 'number' ||
    !Number.isFinite(v.position.z)
  )
    return;
  return v as unknown as PlaceStaticRequest;
}
export function staticPlacementRotation(step: number): Quat {
  const half = (step * Math.PI) / STATIC_PLACEMENT_YAW_STEPS;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}
export function placedStaticInstance(request: PlaceStaticRequest): StaticObjectInstance {
  return {
    entityId: `placed_${request.operationId}`,
    assetId: request.assetId,
    position: { x: request.position.x, y: STATIC_PLACEMENT_GROUND_Y, z: request.position.z },
    rotation: staticPlacementRotation(request.yawStep),
    instanceRevision: 1,
    enabled: true,
  };
}

/** Local persistence adapter only: the v13 wire format remains invalid. */
export function parseStoredPlaceStaticRequest(value: unknown): PlaceStaticRequest | undefined {
  const current = parsePlaceStaticRequest(value);
  if (current) return current;
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !==
      'assetReleaseVersion,expectedLayoutRevision,operationId,position,worldEpoch,yawStep'
  )
    return;
  return parsePlaceStaticRequest({
    ...value,
    assetId: STATIC_PLACEMENT_ASSET_ID,
    placementCatalogVersion: LEGACY_PLACEMENT_CATALOG_VERSION,
  });
}
