import { PROFILE_COLORS } from './accounts.js';
export * from './accounts.js';
export * from './items.js';
export * from './avatars.js';
import type { ItemCatalog, InitialItem, ItemState } from './items.js';

export const PROTOCOL_VERSION = 5;
export const WORLD_FORMAT_VERSION = 3;
export const TICK_RATE = 60;
export const STEP_SECONDS = 1 / TICK_RATE;
export const PATCH_RATE = 20;
export const MAX_PLAYERS = 8;
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
  formatVersion: 1;
  cellId: string;
  buildings: BuildingInstance[];
}
export interface WorldCellManifest {
  cellId: string;
  file: string;
  bounds: Bounds;
}
export type MoveInput = { moveX: number; moveZ: number; sprint?: boolean };
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
  /** Подписи заметных мест. Только отображение: в физический хеш не входят. */
  landmarks?: Landmark[];
}
export interface Landmark {
  id: string;
  name: string;
  /** Точка привязки подписи в мире, обычно над крышей. */
  position: Vec3;
}
export type WorldBase = Omit<WorldDefinition, 'buildings' | 'buildingAssets'>;
export interface WorldSource extends Omit<WorldBase, 'itemCatalog'> {
  itemCatalog: string;
  cells: string[];
  assetCatalog: string;
}
export interface WorldManifest {
  formatVersion: number;
  worldId: string;
  mapVersion: string;
  simulationConfigHash: string;
  bounds: WorldDefinition['bounds'];
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
  players: PlayerState[];
  items: ItemState[];
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
  | 'INVALID_SKIN'
  | 'RATE_LIMITED'
  | 'STALE_WORLD'
  | 'ALREADY_PROCESSED';
export interface ActionResult {
  requestId: number;
  ok: boolean;
  code?: ErrorCode;
  /** Remaining server-enforced delay before the same kind of action can be accepted. */
  retryAfterMs?: number;
}
export interface RespawnRequest {
  requestId: number;
  worldEpoch: string;
}
export const PLAYER_COLORS = PROFILE_COLORS.map((color) => color.hex);
export function normalizeInput(value: unknown): MoveInput | undefined {
  if (!value || typeof value !== 'object') return;
  const { moveX, moveZ, sprint = false } = value as MoveInput;
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
  return { moveX: moveX / length, moveZ: moveZ / length, sprint };
}
export { validateWorld, canonicalJson } from './world.js';
export * from './reactions.js';
export { validateClosedMeshTopology, pointInsideClosedMesh } from './mesh-volume.js';
export {
  validateWorldManifest,
  validateBuildingPhysicsAsset,
  validateBuildingParts,
  validateWorldCell,
  loadWorldBundle,
  simulationProjection,
  worldManifestIdentity,
} from './world-bundle.js';
