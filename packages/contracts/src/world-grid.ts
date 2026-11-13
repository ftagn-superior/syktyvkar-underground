import type { BuildingInstance, EntityDefinition, WorldCell, WorldGrid } from './world-types.js';
import type { Bounds, Vec3, Quat } from './simulation.js';
import { canonicalJson } from './world.js';

function requireGrid(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid world grid: ${message}`);
}

export function createWorldGrid(bounds: Bounds, cellSize: number): WorldGrid {
  requireGrid(Number.isFinite(cellSize) && cellSize >= 1 && cellSize <= 1000, 'cell size 1..1000');
  const columns = Math.ceil((bounds.max.x - bounds.min.x) / cellSize);
  const rows = Math.ceil((bounds.max.z - bounds.min.z) / cellSize);
  requireGrid(
    Number.isSafeInteger(columns) &&
      Number.isSafeInteger(rows) &&
      columns > 0 &&
      rows > 0 &&
      columns * rows <= 10_000,
    'cell count 1..10000',
  );
  return { origin: { x: bounds.min.x, z: bounds.min.z }, cellSize, columns, rows };
}

export function worldCellBounds(bounds: Bounds, grid: WorldGrid, cellId: string): Bounds {
  const match = /^(0|[1-9]\d*)_(0|[1-9]\d*)$/.exec(cellId);
  requireGrid(match, 'canonical cell ID');
  const x = Number(match[1]),
    z = Number(match[2]);
  requireGrid(x < grid.columns && z < grid.rows, 'cell outside grid');
  return {
    min: {
      x: grid.origin.x + x * grid.cellSize,
      y: bounds.min.y,
      z: grid.origin.z + z * grid.cellSize,
    },
    max: {
      x: Math.min(bounds.max.x, grid.origin.x + (x + 1) * grid.cellSize),
      y: bounds.max.y,
      z: Math.min(bounds.max.z, grid.origin.z + (z + 1) * grid.cellSize),
    },
  };
}

/** Interior cells are half-open; the exact outer maximum belongs to the last cell. */
export function worldCellAt(
  bounds: Bounds,
  grid: WorldGrid,
  position: { x: number; z: number },
): string | undefined {
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.z) ||
    position.x < bounds.min.x ||
    position.x > bounds.max.x ||
    position.z < bounds.min.z ||
    position.z > bounds.max.z
  )
    return undefined;
  const x = Math.min(grid.columns - 1, Math.floor((position.x - grid.origin.x) / grid.cellSize));
  const z = Math.min(grid.rows - 1, Math.floor((position.z - grid.origin.z) / grid.cellSize));
  return `${x}_${z}`;
}

/** Positive X/Z overlap excludes mere contact, so adjacent ground tiles are not duplicated. */
export function cellsIntersectingBounds(bounds: Bounds, grid: WorldGrid, target: Bounds): string[] {
  if (
    target.min.x >= bounds.max.x ||
    target.max.x <= bounds.min.x ||
    target.min.z >= bounds.max.z ||
    target.max.z <= bounds.min.z ||
    target.min.y >= bounds.max.y ||
    target.max.y <= bounds.min.y
  )
    return [];
  const minX = Math.max(0, Math.floor((target.min.x - grid.origin.x) / grid.cellSize));
  const minZ = Math.max(0, Math.floor((target.min.z - grid.origin.z) / grid.cellSize));
  const maxX = Math.min(
    grid.columns - 1,
    Math.ceil((target.max.x - grid.origin.x) / grid.cellSize) - 1,
  );
  const maxZ = Math.min(
    grid.rows - 1,
    Math.ceil((target.max.z - grid.origin.z) / grid.cellSize) - 1,
  );
  const result = [];
  for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) result.push(`${x}_${z}`);
  return result;
}

export function primitiveBounds(entity: EntityDefinition): Bounds {
  const { position: p, size: s } = entity;
  return {
    min: { x: p.x - s.x / 2, y: p.y - s.y / 2, z: p.z - s.z / 2 },
    max: { x: p.x + s.x / 2, y: p.y + s.y / 2, z: p.z + s.z / 2 },
  };
}

/** Matches the normalized quaternion used by the renderer and native physics adapter. */
export function transformWorldPoint(point: Vec3, position: Vec3, rotation: Quat): Vec3 {
  const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
  const q = {
    x: rotation.x / length,
    y: rotation.y / length,
    z: rotation.z / length,
    w: rotation.w / length,
  };
  const tx = 2 * (q.y * point.z - q.z * point.y);
  const ty = 2 * (q.z * point.x - q.x * point.z);
  const tz = 2 * (q.x * point.y - q.y * point.x);
  return {
    x: position.x + point.x + q.w * tx + q.y * tz - q.z * ty,
    y: position.y + point.y + q.w * ty + q.z * tx - q.x * tz,
    z: position.z + point.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

/** World AABB includes all eight corners and the complete quaternion rotation. */
export function buildingBounds(instance: BuildingInstance, local: Bounds): Bounds {
  const result = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  for (const x of [local.min.x, local.max.x])
    for (const y of [local.min.y, local.max.y])
      for (const z of [local.min.z, local.max.z]) {
        const point = transformWorldPoint({ x, y, z }, instance.position, instance.rotation);
        for (const axis of ['x', 'y', 'z'] as const) {
          result.min[axis] = Math.min(result.min[axis], point[axis]);
          result.max[axis] = Math.max(result.max[axis], point[axis]);
        }
      }
  return result;
}

/** Same-ID definitions agree across all cells, including across primitive/building kinds. */
export function mergeWorldCells(cells: WorldCell[]) {
  const definitions = new Map<string, string>();
  const statics = new Map<string, WorldCell['statics'][number]>();
  const buildings = new Map<string, BuildingInstance>();
  const retain = <T extends { entityId: string }>(
    item: T,
    target: Map<string, T>,
    kind: string,
  ) => {
    const signature = kind + ':' + canonicalJson(item);
    const previous = definitions.get(item.entityId);
    if (previous !== undefined && previous !== signature)
      throw new Error(`Conflicting entity ID: ${item.entityId}`);
    definitions.set(item.entityId, signature);
    target.set(item.entityId, item);
  };
  for (const cell of cells) {
    for (const item of cell.statics) retain(item, statics, 'primitive');
    for (const item of cell.buildings) retain(item, buildings, 'building');
  }
  const byId = <T extends { entityId: string }>(items: Iterable<T>) =>
    [...items].sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  return { statics: byId(statics.values()), buildings: byId(buildings.values()) };
}

/** Current cell first, then its clipped eight neighbors. Shared by both ends of preparation. */
export function worldNeighborhood(
  bounds: Bounds,
  grid: WorldGrid,
  position: { x: number; z: number },
): string[] {
  const center = worldCellAt(bounds, grid, position);
  if (!center) throw new Error('Position is outside the world');
  const [column, row] = center.split('_').map(Number);
  const ids = [center];
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++) {
      const x = column + dx,
        z = row + dz;
      if ((dx || dz) && x >= 0 && z >= 0 && x < grid.columns && z < grid.rows)
        ids.push(`${x}_${z}`);
    }
  return ids;
}

/** Minimum X/Z distance to a closed cell rectangle, including boundary contact. */
export function distanceToBoundsXZ(position: { x: number; z: number }, bounds: Bounds): number {
  return Math.hypot(
    Math.max(bounds.min.x - position.x, 0, position.x - bounds.max.x),
    Math.max(bounds.min.z - position.z, 0, position.z - bounds.max.z),
  );
}

/** Circular resource selection; cell centers are deliberately not used. */
export function cellsIntersectingCircle(
  bounds: Bounds,
  grid: WorldGrid,
  position: { x: number; z: number },
  radius: number,
): string[] {
  requireGrid(Number.isFinite(radius) && radius >= 0, 'finite nonnegative radius');
  requireGrid(Number.isFinite(position.x) && Number.isFinite(position.z), 'finite circle center');
  // A closed circle can touch the cell on either side of a seam, including at radius zero.
  // Restrict exact distance checks to its enclosing grid rectangle, not the whole city.
  const minX = Math.max(0, Math.ceil((position.x - radius - grid.origin.x) / grid.cellSize) - 1);
  const minZ = Math.max(0, Math.ceil((position.z - radius - grid.origin.z) / grid.cellSize) - 1);
  const maxX = Math.min(
    grid.columns - 1,
    Math.floor((position.x + radius - grid.origin.x) / grid.cellSize),
  );
  const maxZ = Math.min(
    grid.rows - 1,
    Math.floor((position.z + radius - grid.origin.z) / grid.cellSize),
  );
  const result: string[] = [];
  for (let z = minZ; z <= maxZ; z++)
    for (let x = minX; x <= maxX; x++) {
      const id = `${x}_${z}`;
      if (distanceToBoundsXZ(position, worldCellBounds(bounds, grid, id)) <= radius)
        result.push(id);
    }
  return result;
}
