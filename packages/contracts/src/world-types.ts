import type { ItemCatalog, InitialItem } from './items.js';
import type { Bounds, Quat, SimulationConfig, Vec3 } from './simulation.js';
import type { TerrainSource } from './terrain.js';

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
  /** Источники ночного света модели (фонари) в её локальных осях. */
  lights?: StaticLightSource[];
  /** TEXCOORD_0 сгенерированного GLB несёт ночное свечение (`GLOW_KIND`), а не UV. */
  glow?: true;
}
/**
 * Классы ночного свечения. Сборщик пишет их в TEXCOORD_0 статичных GLB: `u` — класс,
 * `v` — случайное число 0..1 отдельного окна или вывески. Клиент включает их по расписанию:
 * `window` — жилые окна, `office` — школы, вузы, учреждения, `shop` — витрины,
 * `sign` — полосы вывесок витрин, `lamp` — плафоны фонарей, `neon` — фирменные вывески
 * на крышах и стенах: светится лицевая сторона букв, горят всю ночь.
 */
export const GLOW_KIND = { window: 1, shop: 2, sign: 3, lamp: 4, office: 5, neon: 6 } as const;
export type GlowKind = keyof typeof GLOW_KIND;
/**
 * Материалы стен для процедурного рисунка без текстур. Сборщик пишет их в TEXCOORD_1
 * статичных GLB: `u` = класс × 1000 + координата вдоль фасада, `v` — по высоте. Координаты
 * в метрах, у `panel` — в шагах окон и этажах, чтобы швы панелей шли между окнами.
 */
export const SURFACE_KIND = {
  plaster: 1,
  brick: 2,
  wood: 3,
  panel: 4,
  tile: 5,
  metal: 6,
  block: 7,
  siding: 8,
} as const;
export type SurfaceKind = keyof typeof SURFACE_KIND;
/** Точечный источник ночного света: лужа света вокруг фонаря, без настоящей лампы Babylon. */
export interface StaticLightSource {
  position: Vec3;
  /** Радиус, на котором свет гаснет полностью, в метрах. */
  radius: number;
  /** sRGB #RRGGBB. */
  color: string;
  /** Расписание: фонарь (по умолчанию) или неоновая вывеска, горящая от сумерек до утра. */
  kind?: 'lamp' | 'neon';
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
  /** Optional verified transport envelopes containing this cell's collision files. */
  physicsPacks?: string[];
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
  /** Relative authoring file for a pinned, already-reviewed terrain release. */
  terrainRelease?: string;
  itemCatalog: string;
  cellSize: number;
  cells: string[];
  assetCatalog: string;
  /** Separate authoring policy; excluded from world and geometry identities. */
  placementPolicy?: string;
  generator?: { kind: 'streaming-lab'; seed: number };
  /** Build-time only; resolved to ordinary absolute poses and static assets. */
  terrain?: TerrainSource;
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
