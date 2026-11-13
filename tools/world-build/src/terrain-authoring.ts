import {
  sampleTerrain,
  itemSupportDistance,
  validateTerrainGrid,
  worldCellBounds,
  type WorldSource,
  type WorldGrid,
  type BuildingInstance,
  type ItemCatalog,
  type TerrainGrid,
} from '@su/contracts';
import {
  TERRAIN_GENERATOR_VERSION,
  validateTerrainPrivateData,
} from '@su/terrain-build/private-data';
import {
  generateTerrainTile,
  prepareTerrainBuildContext,
  terrainPatch,
  terrainSolid,
  patchRange,
  rectangle,
  type GeneratedTerrainAsset,
  type TerrainSurface,
} from './terrain.js';

type Anchor = {
  entityId: string;
  assetId: string;
  x: number;
  z: number;
  yaw?: number;
  offset?: number;
  foundation?: {
    width: number;
    depth: number;
    clearance: number;
    burial: number;
    approach?: { length: number; width: number };
  };
};
export interface TerrainAnchors {
  formatVersion: 1;
  objects: Anchor[];
  spawns: { x: number; z: number }[];
  items: { seedId: string; typeId: string; x: number; z: number }[];
  boundary?: { width: number; height: number; color: string };
}
const identity = { x: 0, y: 0, z: 0, w: 1 };
const idPattern = /^[a-z][a-z0-9-]{0,95}$/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fail = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

export function buildTerrainAuthoring(
  source: WorldSource,
  grid: WorldGrid,
  items: ItemCatalog,
  heightfield: unknown,
  surfaceData: unknown,
  anchorData: unknown,
  variant: 'hill' | 'flat',
) {
  let terrain = validateTerrainGrid(heightfield);
  if (variant === 'flat')
    terrain = validateTerrainGrid({ ...terrain, heights: terrain.heights.map(() => 0) });
  const maxX = terrain.origin.x + (terrain.columns - 1) * terrain.spacing,
    maxZ = terrain.origin.z + (terrain.rows - 1) * terrain.spacing;
  fail(
    terrain.origin.x === source.bounds.min.x &&
      terrain.origin.z === source.bounds.min.z &&
      maxX === source.bounds.max.x &&
      maxZ === source.bounds.max.z &&
      terrain.bottom >= source.bounds.min.y &&
      terrain.heights.every((h) => h < source.bounds.max.y),
    'Terrain must cover the world bounds',
  );
  fail(
    source.spawnPoints.length === 0 && source.initialItems.length === 0,
    'Terrain anchors cannot compete with absolute spawns or initial items',
  );
  const surfaces = surfaceData as { formatVersion: number; layers: TerrainSurface[] };
  fail(surfaces?.formatVersion === 1 && Array.isArray(surfaces.layers), 'Invalid terrain surfaces');
  const ringValid = (ring: unknown) =>
    Array.isArray(ring) &&
    ring.length >= 3 &&
    ring.every(
      (p) =>
        Array.isArray(p) && p.length === 2 && p.every(finite) && sampleTerrain(terrain, p[0], p[1]),
    );
  const ids = new Set<string>();
  for (const s of surfaces.layers) {
    fail(
      s &&
        idPattern.test(s.id) &&
        !ids.has(s.id) &&
        ringValid(s.outline) &&
        (s.holes === undefined || (Array.isArray(s.holes) && s.holes.every(ringValid))) &&
        /^#[a-f0-9]{6}$/i.test(s.color) &&
        finite(s.offset) &&
        s.offset > 0 &&
        s.offset <= 0.04,
      'Invalid terrain surface layer',
    );
    ids.add(s.id);
  }
  const terrainContext = prepareTerrainBuildContext(terrain, surfaces.layers);
  const anchors = anchorData as TerrainAnchors;
  fail(
    anchors?.formatVersion === 1 &&
      Array.isArray(anchors.objects) &&
      Array.isArray(anchors.spawns) &&
      Array.isArray(anchors.items),
    'Invalid terrain anchors',
  );
  const assets = new Map<string, GeneratedTerrainAsset>(),
    buildings: BuildingInstance[] = [],
    fixed: string[] = [];
  const add = (entityId: string, assetId: string, generated: GeneratedTerrainAsset) => {
    fail(!assets.has(assetId), `Duplicate terrain asset ${assetId}`);
    assets.set(assetId, generated);
    buildings.push({ entityId, assetId, position: { x: 0, y: 0, z: 0 }, rotation: identity });
    fixed.push(entityId);
  };
  for (let row = 0; row < grid.rows; row++)
    for (let column = 0; column < grid.columns; column++) {
      const id = `${column}_${row}`,
        bounds = worldCellBounds(source.bounds, grid, id);
      const ring = rectangle(
        (bounds.min.x + bounds.max.x) / 2,
        (bounds.min.z + bounds.max.z) / 2,
        bounds.max.x - bounds.min.x,
        bounds.max.z - bounds.min.z,
      );
      add(
        `terrain-${id.replace('_', '-')}`,
        `terrain-tile-${id.replace('_', '-')}`,
        generateTerrainTile(
          `terrain-tile-${id.replace('_', '-')}`,
          terrain,
          ring,
          surfaces.layers,
          terrainContext,
        ),
      );
    }
  // Like physics-lab's boundary walls, visible retaining rails keep a sprinting
  // capsule inside the finite publication grid. Their bases follow the terrain.
  if (anchors.boundary) {
    const boundary = anchors.boundary;
    fail(
      finite(boundary.width) &&
        boundary.width > 0 &&
        finite(boundary.height) &&
        boundary.height > 0 &&
        boundary.width <
          Math.min(
            source.bounds.max.x - source.bounds.min.x,
            source.bounds.max.z - source.bounds.min.z,
          ) /
            2 &&
        /^#[a-f0-9]{6}$/i.test(boundary.color),
      'Invalid terrain boundary',
    );
    const min = source.bounds.min,
      max = source.bounds.max,
      width = boundary.width;
    for (const [name, ring] of [
      ['west', rectangle(min.x + width / 2, (min.z + max.z) / 2, width, max.z - min.z)],
      ['east', rectangle(max.x - width / 2, (min.z + max.z) / 2, width, max.z - min.z)],
      ['north', rectangle((min.x + max.x) / 2, min.z + width / 2, max.x - min.x, width)],
      ['south', rectangle((min.x + max.x) / 2, max.z - width / 2, max.x - min.x, width)],
    ] as const) {
      const id = `terrain-boundary-${name}`;
      add(
        id,
        id,
        terrainSolid(
          id,
          terrainPatch(terrain, ring),
          (p) => p.y + boundary.height,
          (p) => p.y - 0.02,
          boundary.color,
        ),
      );
    }
  }
  ids.clear();
  const height = (x: number, z: number) => {
    fail(finite(x) && finite(z), 'Invalid terrain anchor position');
    const surface = sampleTerrain(terrain, x, z);
    if (!surface) throw new Error('Terrain anchor outside surface');
    return surface.height;
  };
  for (const a of anchors.objects) {
    fail(
      a &&
        idPattern.test(a.entityId) &&
        idPattern.test(a.assetId) &&
        !ids.has(a.entityId) &&
        !Object.hasOwn(a, 'position') &&
        !Object.hasOwn(a, 'y') &&
        (a.yaw === undefined || finite(a.yaw)) &&
        (a.offset === undefined || finite(a.offset)),
      'Invalid or competing terrain object anchor',
    );
    ids.add(a.entityId);
    let y = height(a.x, a.z) + (a.offset ?? 0);
    const yaw = a.yaw ?? 0;
    if (a.foundation) {
      const f = a.foundation;
      fail(
        [f.width, f.depth, f.clearance, f.burial].every((v) => finite(v) && v > 0) &&
          a.offset === undefined,
        'Invalid terrain foundation',
      );
      const ring = rectangle(a.x, a.z, f.width, f.depth, yaw);
      ring.forEach((p) => height(...p));
      const patch = terrainPatch(terrain, ring);
      y = patchRange(patch).max + f.clearance;
      const assetId = `${a.entityId}-foundation`;
      add(
        assetId,
        assetId,
        terrainSolid(
          assetId,
          patch,
          () => y,
          (p) => p.y - f.burial,
          '#8b8580',
        ),
      );
      fixed.push(a.entityId);
      if (f.approach) {
        const { length, width } = f.approach;
        fail(
          [length, width].every((v) => finite(v) && v > 0) && width <= f.width,
          'Invalid foundation approach',
        );
        // Explicit approach at the local north entrance, transforming with the rigid house.
        const c = Math.cos(yaw),
          s = Math.sin(yaw),
          centerZ = -f.depth / 2 - length / 2;
        const approachRing = rectangle(a.x + s * centerZ, a.z + c * centerZ, width, length, yaw);
        approachRing.forEach((p) => height(...p));
        const approach = terrainPatch(terrain, approachRing),
          floor = y;
        const top = (p: { x: number; y: number; z: number }) => {
          const localZ = s * (p.x - a.x) + c * (p.z - a.z);
          const t = Math.max(0, Math.min(1, (localZ + f.depth / 2 + length) / length));
          return p.y + t * (floor - p.y);
        };
        fail(
          approach.every((t) => t.every((p) => top(p) >= p.y - 1e-8)),
          'Approach crosses above the floor',
        );
        const id = `${a.entityId}-approach`;
        add(
          id,
          id,
          terrainSolid(id, approach, top, (p) => p.y - f.burial, '#b5afa1'),
        );
      }
    }
    buildings.push({
      entityId: a.entityId,
      assetId: a.assetId,
      position: { x: a.x, y, z: a.z },
      rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    });
  }
  const spawnPoints = anchors.spawns.map((p) => {
    fail(p && !Object.hasOwn(p, 'y'), 'Competing terrain spawn height');
    return { x: p.x, y: height(p.x, p.z), z: p.z };
  });
  ids.clear();
  const initialItems = anchors.items.map((p) => {
    fail(
      p &&
        idPattern.test(p.seedId) &&
        !ids.has(p.seedId) &&
        !Object.hasOwn(p, 'position') &&
        !Object.hasOwn(p, 'y'),
      'Invalid terrain initial item',
    );
    ids.add(p.seedId);
    const type = items.types[p.typeId];
    fail(type, `Unknown terrain item ${p.typeId}`);
    const surface = sampleTerrain(terrain, p.x, p.z);
    height(p.x, p.z);
    const distance = itemSupportDistance(type, identity, surface!.normal);
    return {
      seedId: p.seedId,
      typeId: p.typeId,
      position: { x: p.x, y: surface!.height + distance / surface!.normal.y + 0.03, z: p.z },
      rotation: identity,
    };
  });
  const privateData = validateTerrainPrivateData({
    formatVersion: 1,
    generatorVersion: TERRAIN_GENERATOR_VERSION,
    worldId: source.worldId,
    grid: terrain,
    supports: anchors.objects
      .filter((a) => a.foundation)
      .map((a) => ({
        ownerId: a.entityId,
        assetId: a.assetId,
        kind: 'rectangle-v1',
        ...a.foundation,
      })),
  });
  return { terrain, assets, buildings, fixed, spawnPoints, initialItems, privateData };
}

export type { TerrainGrid };
