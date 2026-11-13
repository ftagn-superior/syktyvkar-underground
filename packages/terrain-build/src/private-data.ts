import { validateTerrainGrid, type TerrainGrid, type Bounds } from '@su/contracts';
import type { Point2 } from './triangulate.js';

/** Increment when support geometry conventions change (including colors and approach direction). */
export const TERRAIN_GENERATOR_VERSION = 'terrain-build/1' as const;
export const TERRAIN_GENERATOR_VERSION_V2 = 'terrain-build/2' as const;
export interface RectangleSupportRuleV1 {
  ownerId: string;
  assetId: string;
  kind: 'rectangle-v1';
  width: number;
  depth: number;
  clearance: number;
  burial: number;
  approach?: { length: number; width: number };
}
export interface TerrainSupportComponent {
  outline: Point2[];
  holes?: Point2[][];
}
export interface TerrainSupportApproach {
  id: string;
  /** Local near edge at the explicit entrance; its length is the approach width. */
  edge: [Point2, Point2];
  /** Local unit vector perpendicular to the edge, pointing away from the entrance. */
  outward: Point2;
  length: number;
  /** Local walking height at the entrance, independent of the floor's underside. */
  targetY: number;
  color: string;
}
export interface FoundationSupportRuleV2 {
  kind: 'foundation-v2';
  assetId: string;
  /** Absent for a model default; present for an override of this owner and model. */
  ownerId?: string;
  /** A normalized union: simple components with disjoint interiors and preserved holes. */
  components: TerrainSupportComponent[];
  /** Local Y of the underside of the existing floor. */
  jointY: number;
  clearance: number;
  burial: number;
  color: string;
  approaches?: TerrainSupportApproach[];
}
export type TerrainSupportRule = RectangleSupportRuleV1 | FoundationSupportRuleV2;
/** Private build input, independent of CLI anchors, spawn policy and live object poses. */
export interface TerrainPrivateDataV1 {
  formatVersion: 1;
  generatorVersion: typeof TERRAIN_GENERATOR_VERSION;
  worldId: string;
  grid: TerrainGrid;
  supports: RectangleSupportRuleV1[];
}
export interface TerrainPrivateDataV2 {
  formatVersion: 2;
  generatorVersion: typeof TERRAIN_GENERATOR_VERSION_V2;
  worldId: string;
  grid: TerrainGrid;
  supports: FoundationSupportRuleV2[];
}
export type TerrainPrivateData = TerrainPrivateDataV1 | TerrainPrivateDataV2;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: object, allowed: string[]) =>
  Object.keys(value).every((k) => allowed.includes(k));
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
// Owner IDs are the world's existing IDs, including placed_<UUID>, not lab anchor IDs.
const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 128;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const color = (v: unknown) => typeof v === 'string' && /^#[a-f0-9]{6}$/i.test(v);
const point = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => finite(n) && Math.abs(n) <= 100_000);
const ring = (v: unknown) =>
  Array.isArray(v) && v.length >= 3 && v.length <= 4096 && v.every(point);

export function validateFoundationSupportRule(value: unknown): FoundationSupportRuleV2 {
  if (
    !record(value) ||
    !keys(value, [
      'kind',
      'assetId',
      'ownerId',
      'components',
      'jointY',
      'clearance',
      'burial',
      'color',
      'approaches',
    ]) ||
    value.kind !== 'foundation-v2' ||
    !id(value.assetId) ||
    (value.ownerId !== undefined && !id(value.ownerId)) ||
    !finite(value.jointY) ||
    !positive(value.clearance) ||
    !positive(value.burial) ||
    !color(value.color) ||
    !Array.isArray(value.components) ||
    value.components.length === 0 ||
    value.components.length > 256
  )
    throw new Error('Invalid foundation support rule');
  let vertices = 0;
  for (const component of value.components) {
    if (
      !record(component) ||
      !keys(component, ['outline', 'holes']) ||
      !ring(component.outline) ||
      (component.holes !== undefined &&
        (!Array.isArray(component.holes) ||
          component.holes.length > 256 ||
          !component.holes.every(ring)))
    )
      throw new Error('Invalid foundation support component');
    vertices +=
      (component.outline as Point2[]).length +
      ((component.holes ?? []) as Point2[][]).reduce((n, r) => n + r.length, 0);
  }
  if (vertices > 16_384) throw new Error('Foundation support vertex limit');
  if (value.approaches !== undefined) {
    if (!Array.isArray(value.approaches) || value.approaches.length > 128)
      throw new Error('Invalid foundation support approaches');
    const ids = new Set<string>();
    for (const a of value.approaches) {
      if (
        !record(a) ||
        !keys(a, ['id', 'edge', 'outward', 'length', 'targetY', 'color']) ||
        !id(a.id) ||
        ids.has(a.id as string) ||
        !Array.isArray(a.edge) ||
        a.edge.length !== 2 ||
        !a.edge.every(point) ||
        !point(a.outward) ||
        !positive(a.length) ||
        !finite(a.targetY) ||
        !color(a.color)
      )
        throw new Error('Invalid foundation support approach');
      const edge = a.edge as unknown as [Point2, Point2],
        dx = edge[1][0] - edge[0][0],
        dz = edge[1][1] - edge[0][1],
        width = Math.hypot(dx, dz),
        outward = a.outward;
      if (
        width <= 1e-6 ||
        Math.abs(Math.hypot(...outward) - 1) > 1e-6 ||
        Math.abs(dx * outward[0] + dz * outward[1]) / width > 1e-6
      )
        throw new Error('Foundation approach requires a perpendicular unit direction');
      ids.add(a.id as string);
    }
  }
  return value as unknown as FoundationSupportRuleV2;
}

export function validateTerrainPrivateData(value: unknown): TerrainPrivateData {
  if (
    !record(value) ||
    !keys(value, ['formatVersion', 'generatorVersion', 'worldId', 'grid', 'supports']) ||
    !(
      (value.formatVersion === 1 && value.generatorVersion === TERRAIN_GENERATOR_VERSION) ||
      (value.formatVersion === 2 && value.generatorVersion === TERRAIN_GENERATOR_VERSION_V2)
    ) ||
    !id(value.worldId) ||
    !Array.isArray(value.supports) ||
    value.supports.length > 100_000
  )
    throw new Error('Invalid private terrain data');
  validateTerrainGrid(value.grid);
  const owners = new Set<string>();
  for (const s of value.supports) {
    if (value.formatVersion === 2) {
      const rule = validateFoundationSupportRule(s),
        selector = JSON.stringify([rule.assetId, rule.ownerId ?? null]);
      if (owners.has(selector)) throw new Error('Duplicate foundation support selector');
      owners.add(selector);
      continue;
    }
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
