import { validateTerrainGrid, type TerrainGrid, type Bounds } from '@su/contracts';

/** Increment when support geometry conventions change (including colors and approach direction). */
export const TERRAIN_GENERATOR_VERSION = 'terrain-build/1' as const;
export interface TerrainSupportRule {
  ownerId: string;
  assetId: string;
  kind: 'rectangle-v1';
  width: number;
  depth: number;
  clearance: number;
  burial: number;
  approach?: { length: number; width: number };
}
/** Private build input, independent of CLI anchors, spawn policy and live object poses. */
export interface TerrainPrivateData {
  formatVersion: 1;
  generatorVersion: typeof TERRAIN_GENERATOR_VERSION;
  worldId: string;
  grid: TerrainGrid;
  supports: TerrainSupportRule[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: object, allowed: string[]) =>
  Object.keys(value).every((k) => allowed.includes(k));
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
// Owner IDs are the world's existing IDs, including placed_<UUID>, not lab anchor IDs.
const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 128;

export function validateTerrainPrivateData(value: unknown): TerrainPrivateData {
  if (
    !record(value) ||
    !keys(value, ['formatVersion', 'generatorVersion', 'worldId', 'grid', 'supports']) ||
    value.formatVersion !== 1 ||
    value.generatorVersion !== TERRAIN_GENERATOR_VERSION ||
    !id(value.worldId) ||
    !Array.isArray(value.supports) ||
    value.supports.length > 100_000
  )
    throw new Error('Invalid private terrain data');
  validateTerrainGrid(value.grid);
  const owners = new Set<string>();
  for (const s of value.supports) {
    if (
      !record(s) ||
      !keys(s, [
        'ownerId',
        'assetId',
        'kind',
        'width',
        'depth',
        'clearance',
        'burial',
        'approach',
      ]) ||
      !id(s.ownerId) ||
      !id(s.assetId) ||
      s.kind !== 'rectangle-v1' ||
      ![s.width, s.depth, s.clearance, s.burial].every(positive) ||
      owners.has(s.ownerId as string)
    )
      throw new Error('Invalid terrain support rule');
    if (
      s.approach !== undefined &&
      (!record(s.approach) ||
        !keys(s.approach, ['length', 'width']) ||
        !positive(s.approach.length) ||
        !positive(s.approach.width) ||
        (s.approach.width as number) > (s.width as number))
    )
      throw new Error('Invalid terrain support approach');
    owners.add(s.ownerId as string);
  }
  return value as unknown as TerrainPrivateData;
}

export function validateTerrainCoverage(grid: TerrainGrid, bounds: Bounds) {
  if (
    grid.origin.x !== bounds.min.x ||
    grid.origin.z !== bounds.min.z ||
    grid.origin.x + (grid.columns - 1) * grid.spacing !== bounds.max.x ||
    grid.origin.z + (grid.rows - 1) * grid.spacing !== bounds.max.z ||
    grid.bottom < bounds.min.y ||
    grid.heights.some((h) => h >= bounds.max.y)
  )
    throw new Error('Private terrain must cover the world bounds');
}
