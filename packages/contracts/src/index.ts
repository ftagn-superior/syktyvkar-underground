import type { StaticPlacementEffect } from './static-placement.js';
import { PROFILE_COLORS } from './accounts.js';
export * from './accounts.js';
export * from './static-placement.js';
export * from './items.js';
export * from './item-shapes.js';
export * from './foliage-shapes.js';
export * from './avatars.js';
export * from './animations.js';
export * from './sounds.js';
export * from './world-layout-patch.js';
export * from './day-clock.js';
import type { ItemCatalog, InitialItem, ItemState, ItemError } from './items.js';

export const PROTOCOL_VERSION = 13;
export const WORLD_FORMAT_VERSION = 5;
export const TICK_RATE = 60;
export const STEP_SECONDS = 1 / TICK_RATE;
export const PATCH_RATE = 20;
export const MAX_PLAYERS = 8;
export const INTEREST_RADII = { enter: 500, leave: 800 } as const;
export const RECONNECT_SECONDS = 30;
export const PREPARE_TIMEOUT_MS = 15_000;
export const INPUT_TIMEOUT_MS = 250;
export const MAX_INPUT_QUEUE = 32;
export const MAX_PREDICTION_MS = 500;
export const RESPAWN_COOLDOWN_MS = 3000;
/** Chat, reactions and animations expire this long after the author's first movement. */
export const WORLD_ACTIVITY_MOVE_DURATION_MS = 5000;
export type Vec3 = { x: number; y: number; z: number };
export type Quat = Vec3 & { w: number };
export type Bounds = { min: Vec3; max: Vec3 };
export interface BuildingInstance {
  entityId: string;
  assetId: string;
  position: Vec3;
  rotation: Quat;
  sourceRef?: { provider: string; type: string; id: string };
}
/** Editable placement. Active instances use the existing v5/v2 cell transport. */
export interface StaticObjectInstance extends BuildingInstance {
  instanceRevision: number;
  enabled: boolean;
}
export interface WorldLayoutSnapshot {
  formatVersion: 1;
  worldId: string;
  assetReleaseVersion: string;
  seedVersion: string;
  revision: number;
  instances: StaticObjectInstance[];
}
interface ColliderTransform {
  id: string;
  position: Vec3;
  rotation: Quat;
  friction: number;
  restitution: number;
}
export type StaticCollider = ColliderTransform &
  ({ kind: 'box'; size: Vec3 } | { kind: 'mesh'; vertices: number[]; indices: number[] });
export interface BuildingPhysicsAsset {
  assetId: string;
  bounds: Bounds;
  colliders: StaticCollider[];
}
export interface BuildingPart {
  partId: string;
  role: 'wall' | 'roof' | 'detail';
  occlusionGroup: string | null;
  nodeIndex: number;
}
export interface BuildingParts {
  formatVersion: 1;
  assetId: string;
  parts: BuildingPart[];
  /** The sole visual representation of an instanced tree; no GLB accompanies it. */
  tree?: TreeRenderRecipe;
}
/** Current instanced tree profile. Broadleaf crowns always use baked local AO. */
export interface TreeRenderRecipe {
  formatVersion: 2;
  foliage: 'broadleaf' | 'spruce';
  /** bottom radius, top radius (including the kit's minimum tip), base Y, height */
  crowns: [[number, number, number, number], [number, number, number, number]];
  /** X/Y/Z dimensions and yaw in radians; centered on X/Z = 0. */
  trunk: [number, number, number, number];
  trunkBase: number;
  crownColor: string;
  trunkColor: string;
}
export interface BuildingAssetManifest {
  assetId: string;
  version: string;
  /** Present for GLB assets, absent for trees rendered from partsFile. */
  modelFile?: string;
  partsFile: string;
  collisionFile: string;
  bounds: Bounds;
}
export interface WorldCell {
  formatVersion: 2;
  cellId: string;
  statics: StaticEntityDefinition[];
  buildings: BuildingInstance[];
}
export interface WorldGrid {
  origin: { x: number; z: number };
  cellSize: number;
  columns: number;
  rows: number;
}
export interface WorldCellManifest {
  cellId: string;
  file: string;
  bounds: Bounds;
  assetIds: string[];
  /** Optional bounded transport packs; individual files remain the authoritative fallback. */
  graphicsPacks?: string[];
}
export type MoveInput = { moveX: number; moveZ: number; sprint?: boolean; facingYaw?: number };
export const NEUTRAL_INPUT: Readonly<MoveInput> = Object.freeze({
  moveX: 0,
  moveZ: 0,
  sprint: false,
});
export interface SimulationConfig {
  tickRate: number;
  gravity: Vec3;
  character: { height: number; radius: number; speed: number; sprintSpeed: number; mass: number };
}
export interface EntityDefinition {
  entityId: string;
  kind: 'obstacle';
  position: Vec3;
  size: Vec3;
  mass: number;
  friction: number;
  restitution: number;
  color: string;
}
export type StaticEntityDefinition = EntityDefinition & { kind: 'obstacle' };
export type WorldRoutes = Record<string, { x: number; z: number }[]>;
export interface WorldDefinition {
  formatVersion: number;
  worldId: string;
  bounds: Bounds;
  simulation: SimulationConfig;
  spawnPoints: Vec3[];
  entities: EntityDefinition[];
  itemCatalog: ItemCatalog;
  initialItems: InitialItem[];
  buildings: BuildingInstance[];
  buildingAssets: Record<string, BuildingPhysicsAsset>;
  routes?: WorldRoutes;
  landmarks?: Landmark[];
}
export interface Landmark {
  id: string;
  name: string;
  position: Vec3;
}
export type WorldBase = Omit<WorldDefinition, 'buildings' | 'buildingAssets'>;
/** Small immutable entry point; every static primitive belongs to cells. */
export type WorldHeader = Omit<WorldDefinition, 'entities' | 'buildings' | 'buildingAssets'>;
export interface WorldSource extends Omit<WorldBase, 'itemCatalog'> {
  itemCatalog: string;
  cellSize: number;
  cells: string[];
  assetCatalog: string;
  generator?: { kind: 'streaming-lab'; seed: number };
}
export interface LocalStaticSet {
  cell: WorldCell;
  buildingAssets: Record<string, BuildingPhysicsAsset>;
}
export interface WorldManifest {
  formatVersion: number;
  worldId: string;
  mapVersion: string;
  simulationConfigHash: string;
  bounds: WorldDefinition['bounds'];
  grid: WorldGrid;
  files: Record<string, string>;
  worldFile: string;
  cells: WorldCellManifest[];
  assets: Record<string, BuildingAssetManifest>;
}
export interface EntityState {
  entityId: string;
  kind: 'player' | 'item';
  revision: number;
  position: Vec3;
  rotation: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
}
export interface PlayerState extends EntityState {
  kind: 'player';
  grounded: boolean;
}
export interface SimulationSnapshot {
  scope: 'authoritative';
  players: PlayerState[];
  items: ItemState[];
}
/** Partial replication must never be passed as the authoritative server snapshot. */
export interface LocalSimulationSnapshot {
  scope: 'local';
  players: PlayerState[];
  items: ItemState[];
}
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
export const PLAYER_COLORS = PROFILE_COLORS.map((color) => color.hex);
export function normalizeInput(value: unknown): MoveInput | undefined {
  if (!value || typeof value !== 'object') return;
  const { moveX, moveZ, sprint = false, facingYaw } = value as MoveInput;
  if (
    typeof moveX !== 'number' ||
    typeof moveZ !== 'number' ||
    !Number.isFinite(moveX) ||
    !Number.isFinite(moveZ) ||
    typeof sprint !== 'boolean'
  )
    return;
  if (Math.abs(moveX) > 100 || Math.abs(moveZ) > 100) return;
  const length = Math.max(1, Math.hypot(moveX, moveZ));
  const input: MoveInput = { moveX: moveX / length, moveZ: moveZ / length, sprint };
  if (typeof facingYaw === 'number' && Number.isFinite(facingYaw))
    input.facingYaw = normalizeYaw(facingYaw);
  return input;
}
/** World yaw: zero faces +Z. Canonical range includes -PI and excludes +PI. */
export function normalizeYaw(yaw: number): number {
  if (yaw >= -Math.PI && yaw < Math.PI) return yaw;
  const turn = Math.PI * 2;
  return (((yaw % turn) + Math.PI + turn) % turn) - Math.PI;
}
export { validateWorld, validateWorldHeader, validateEntities, canonicalJson } from './world.js';
export {
  worldNeighborhood,
  createWorldGrid,
  worldCellAt,
  worldCellBounds,
  cellsIntersectingBounds,
  cellsIntersectingCircle,
  distanceToBoundsXZ,
  primitiveBounds,
  buildingBounds,
  mergeWorldCells,
} from './world-grid.js';
export * from './reactions.js';
export * from './chat.js';
export { GRAPHICS_PACK_LIMITS, encodeGraphicsPack, decodeGraphicsPack } from './graphics-pack.js';
export { validateClosedMeshTopology, pointInsideClosedMesh } from './mesh-volume.js';
export {
  validateWorldManifest,
  trustWorldManifest,
  validateBuildingPhysicsAsset,
  validateBuildingParts,
  validateWorldCell,
  loadWorldBundle,
  loadWorldHeader,
  loadWorldCell,
  loadCellPhysics,
  WORLD_RESOURCE_LIMITS,
  type ReadVerifiedBytes,
  simulationProjection,
  worldManifestIdentity,
} from './world-bundle.js';
