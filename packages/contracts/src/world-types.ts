import type { ItemCatalog, InitialItem } from './items.js';
import type { Bounds, Quat, SimulationConfig, Vec3 } from './simulation.js';

export const WORLD_FORMAT_VERSION = 5;
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
  /** Validated static GLB profile, rendered in spatial thin-instance groups. */
  renderMode?: 'thin-instance';
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
