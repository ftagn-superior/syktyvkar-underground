export const PROTOCOL_VERSION = 3;
export const WORLD_FORMAT_VERSION = 3;
export const TICK_RATE = 60;
export const STEP_SECONDS = 1 / TICK_RATE;
export const PATCH_RATE = 20;
export const MAX_PLAYERS = 8;
export const INTEREST_RADII = { enter: 80, leave: 100 } as const;
export const RECONNECT_SECONDS = 30;
export const PREPARE_TIMEOUT_MS = 15_000;
export const INPUT_TIMEOUT_MS = 250;
export const MAX_INPUT_QUEUE = 32;
export const MAX_PREDICTION_MS = 500;
export const RESPAWN_COOLDOWN_MS = 3000;
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
}
export interface BuildingAssetManifest {
  assetId: string;
  version: string;
  modelFile: string;
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
}
export type MoveInput = { moveX: number; moveZ: number };
export const NEUTRAL_INPUT: Readonly<MoveInput> = Object.freeze({ moveX: 0, moveZ: 0 });
export interface SimulationConfig {
  tickRate: number;
  gravity: Vec3;
  character: { height: number; radius: number; speed: number; mass: number };
}
export interface EntityDefinition {
  entityId: string;
  kind: 'obstacle' | 'crate';
  position: Vec3;
  size: Vec3;
  mass: number;
  friction: number;
  restitution: number;
  color: string;
}
export type StaticEntityDefinition = EntityDefinition & { kind: 'obstacle' };
export type CrateDefinition = EntityDefinition & { kind: 'crate' };
export type WorldRoutes = Record<string, { x: number; z: number }[]>;
export interface WorldDefinition {
  formatVersion: number;
  worldId: string;
  bounds: Bounds;
  simulation: SimulationConfig;
  spawnPoints: Vec3[];
  entities: EntityDefinition[];
  buildings: BuildingInstance[];
  buildingAssets: Record<string, BuildingPhysicsAsset>;
  routes?: WorldRoutes;
}
/** Small immutable entry point; every static primitive belongs to cells. */
export interface WorldHeader extends Omit<
  WorldDefinition,
  'entities' | 'buildings' | 'buildingAssets'
> {
  crate: CrateDefinition;
}
export interface WorldSource extends WorldHeader {
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
  kind: 'player' | 'crate';
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
  players: PlayerState[];
  crate: EntityState;
}
/** Partial replication must never be passed as the authoritative server snapshot. */
export interface LocalSimulationSnapshot {
  players: PlayerState[];
  crate?: EntityState;
}
export interface WorldInfo {
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
  | 'WORLD_FULL'
  | 'WORLD_NOT_READY'
  | 'VERSION_MISMATCH'
  | 'PREPARE_TIMEOUT'
  | 'SPAWN_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'RATE_LIMITED'
  | 'STALE_WORLD'
  | 'ALREADY_PROCESSED'
  | 'PLAN_REPLACED';
export interface ActionResult {
  requestId: number;
  ok: boolean;
  code?: ErrorCode;
  /** Remaining server-enforced delay before another respawn can be accepted. */
  retryAfterMs?: number;
}
export interface PrepareArea {
  prepareId: string;
  worldEpoch: string;
  mapVersion: string;
  reason: 'spawn' | 'respawn' | 'reconnect';
  position: Vec3;
  cellIds: string[];
  expiresAt: number;
  requestId?: number;
}
export interface AreaReady {
  prepareId: string;
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
export const PLAYER_COLORS = [
  '#65d6bc',
  '#f3b35a',
  '#8c9eff',
  '#ed88b7',
  '#9bd06d',
  '#68c8ed',
  '#c7a0ed',
  '#e98b69',
];
export function normalizeInput(value: unknown): MoveInput | undefined {
  if (!value || typeof value !== 'object') return;
  const { moveX, moveZ } = value as MoveInput;
  if (
    typeof moveX !== 'number' ||
    typeof moveZ !== 'number' ||
    !Number.isFinite(moveX) ||
    !Number.isFinite(moveZ)
  )
    return;
  if (Math.abs(moveX) > 100 || Math.abs(moveZ) > 100) return;
  const length = Math.max(1, Math.hypot(moveX, moveZ));
  return { moveX: moveX / length, moveZ: moveZ / length };
}
export { validateWorld, validateWorldHeader, validateEntities, canonicalJson } from './world.js';
export {
  worldNeighborhood,
  createWorldGrid,
  worldCellAt,
  worldCellBounds,
  cellsIntersectingBounds,
  primitiveBounds,
  buildingBounds,
  mergeWorldCells,
} from './world-grid.js';
export { validateClosedMeshTopology, pointInsideClosedMesh } from './mesh-volume.js';
export {
  validateWorldManifest,
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
