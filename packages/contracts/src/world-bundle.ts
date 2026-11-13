import {
  WORLD_FORMAT_VERSION,
  type BuildingInstance,
  type BuildingParts,
  type BuildingPhysicsAsset,
  type WorldHeader,
  type EntityDefinition,
  type LocalStaticSet,
  type WorldCell,
  type WorldDefinition,
  type WorldManifest,
} from './world-types.js';
import type { Bounds, Vec3, Quat } from './simulation.js';
import { validateWorld, validateWorldHeader, validateEntities } from './world.js';
import {
  createWorldGrid,
  worldCellBounds,
  buildingBounds,
  primitiveBounds,
  cellsIntersectingBounds,
  mergeWorldCells,
  transformWorldPoint,
} from './world-grid.js';
import { canonicalJson } from './world.js';
import { validateClosedMeshTopology } from './mesh-volume.js';
import { itemPhysicsDefinition } from './item-shapes.js';

const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const assetPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const hashPattern = /^[a-f0-9]{64}$/;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid world bundle: ${message}`);
}
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function stringMatches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}
function vec(value: unknown): asserts value is Vec3 {
  requireValue(object(value), 'vector');
  for (const axis of ['x', 'y', 'z'])
    requireValue(
      Number.isFinite(value[axis]) && Math.abs(value[axis]) <= 100_000,
      `vector.${axis}`,
    );
}
function quat(value: unknown): asserts value is Quat {
  vec(value);
  const q = value as Quat;
  requireValue(
    Number.isFinite(q.w) && Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 0.0001,
    'unit quaternion',
  );
}
export function validateBounds(value: unknown): asserts value is Bounds {
  requireValue(object(value), 'bounds');
  vec(value.min);
  vec(value.max);
  for (const axis of ['x', 'y', 'z'] as const)
    requireValue(value.min[axis] < value.max[axis], 'ordered bounds');
}
function boundsCorners(bounds: Bounds): Vec3[] {
  return [bounds.min.x, bounds.max.x].flatMap((x) =>
    [bounds.min.y, bounds.max.y].flatMap((y) =>
      [bounds.min.z, bounds.max.z].map((z) => ({ x, y, z })),
    ),
  );
}
function containsPoint(bounds: Bounds, point: Vec3): boolean {
  return (['x', 'y', 'z'] as const).every(
    (axis) => point[axis] >= bounds.min[axis] - 0.0001 && point[axis] <= bounds.max[axis] + 0.0001,
  );
}
export function validateBuildingBounds(
  instance: BuildingInstance,
  asset: BuildingPhysicsAsset,
  bounds: Bounds,
): void {
  requireValue(
    boundsCorners(asset.bounds).every((point) =>
      containsPoint(bounds, transformWorldPoint(point, instance.position, instance.rotation)),
    ),
    `building ${instance.entityId} outside containing bounds`,
  );
}
function resourcePath(value: unknown): asserts value is string {
  requireValue(
    typeof value === 'string' &&
      value.length <= 240 &&
      value
        .split('/')
        .every(
          (segment) => /^[a-zA-Z0-9_.-]+$/.test(segment) && segment !== '.' && segment !== '..',
        ),
    'relative resource path',
  );
}
export function validateBuildingInstances(value: unknown): asserts value is BuildingInstance[] {
  requireValue(Array.isArray(value) && value.length <= 10_000, 'buildings');
  const ids = new Set<string>();
  for (const instance of value) {
    requireValue(
      object(instance) && stringMatches(instance.entityId, idPattern),
      'building entityId',
    );
    requireValue(!ids.has(instance.entityId), `duplicate ID ${instance.entityId}`);
    ids.add(instance.entityId);
    requireValue(stringMatches(instance.assetId, assetPattern), 'building assetId');
    vec(instance.position);
    quat(instance.rotation);
    requireValue(instance.scale === undefined, 'building scale is baked into its asset');
    if (instance.sourceRef !== undefined) {
      requireValue(object(instance.sourceRef), 'sourceRef');
      for (const field of ['provider', 'type', 'id'])
        requireValue(
          typeof instance.sourceRef[field] === 'string' &&
            instance.sourceRef[field].length > 0 &&
            instance.sourceRef[field].length <= 200,
          `sourceRef.${field}`,
        );
    }
  }
}
export function validateWorldCell(value: unknown): WorldCell {
  requireValue(
    object(value) && value.formatVersion === 2 && stringMatches(value.cellId, idPattern),
    'cell',
  );
  validateBuildingInstances(value.buildings);
  validateEntities(value.statics);
  requireValue(
    value.statics.every((item: EntityDefinition) => item.kind === 'obstacle'),
    'cell statics only',
  );
  const ids = new Set(value.statics.map((item: EntityDefinition) => item.entityId));
  for (const building of value.buildings) {
    requireValue(!ids.has(building.entityId), `duplicate ID ${building.entityId}`);
    ids.add(building.entityId);
  }
  return value as WorldCell;
}
export function validateBuildingPhysicsAsset(value: unknown): BuildingPhysicsAsset {
  requireValue(object(value) && stringMatches(value.assetId, assetPattern), 'physics assetId');
  validateBounds(value.bounds);
  requireValue(Array.isArray(value.colliders) && value.colliders.length <= 2048, 'colliders');
  const ids = new Set<string>();
  for (const shape of value.colliders) {
    requireValue(
      object(shape) && stringMatches(shape.id, idPattern) && !ids.has(shape.id),
      'collider ID',
    );
    ids.add(shape.id);
    vec(shape.position);
    quat(shape.rotation);
    requireValue(
      Number.isFinite(shape.friction) && shape.friction >= 0 && shape.friction <= 10,
      'collider friction',
    );
    requireValue(
      Number.isFinite(shape.restitution) && shape.restitution >= 0 && shape.restitution <= 1,
      'collider restitution',
    );
    if (shape.kind === 'box') {
      vec(shape.size);
      requireValue(
        shape.size.x > 0 && shape.size.y > 0 && shape.size.z > 0,
        'positive collider size',
      );
      const half = { x: shape.size.x / 2, y: shape.size.y / 2, z: shape.size.z / 2 };
      const localBounds = { min: { x: -half.x, y: -half.y, z: -half.z }, max: half };
      requireValue(
        boundsCorners(localBounds).every((point) =>
          containsPoint(value.bounds, transformWorldPoint(point, shape.position, shape.rotation)),
        ),
        'collider outside asset bounds',
      );
    } else if (shape.kind === 'mesh') {
      requireValue(
        Array.isArray(shape.vertices) &&
          shape.vertices.length >= 9 &&
          shape.vertices.length % 3 === 0 &&
          shape.vertices.length <= 600_000,
        'mesh vertices',
      );
      requireValue(
        shape.vertices.every(
          (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100_000,
        ),
        'finite mesh vertices',
      );
      requireValue(
        Array.isArray(shape.indices) &&
          shape.indices.length >= 3 &&
          shape.indices.length % 3 === 0 &&
          shape.indices.length <= 600_000,
        'mesh triangles',
      );
      requireValue(
        shape.indices.every(
          (n: unknown) =>
            Number.isInteger(n) && Number(n) >= 0 && Number(n) < shape.vertices.length / 3,
        ),
        'mesh index range',
      );
      requireValue(
        validateClosedMeshTopology(shape.vertices, shape.indices),
        'mesh collider must contain closed outward-oriented solid shells',
      );
      for (let i = 0; i < shape.vertices.length; i += 3) {
        const point = { x: shape.vertices[i], y: shape.vertices[i + 1], z: shape.vertices[i + 2] };
        requireValue(
          containsPoint(value.bounds, transformWorldPoint(point, shape.position, shape.rotation)),
          'collider outside asset bounds',
        );
      }
    } else throw new Error('Invalid world bundle: unsupported collider kind');
  }
  return value as BuildingPhysicsAsset;
}
export function validateBuildingParts(value: unknown): BuildingParts {
  requireValue(
    object(value) && value.formatVersion === 1 && stringMatches(value.assetId, assetPattern),
    'parts asset',
  );
  requireValue(
    Array.isArray(value.parts) && value.parts.length > 0 && value.parts.length <= 4096,
    'parts',
  );
  const ids = new Set<string>();
  for (const part of value.parts) {
    requireValue(
      object(part) && stringMatches(part.partId, idPattern) && !ids.has(part.partId),
      'part ID',
    );
    ids.add(part.partId);
    requireValue(['wall', 'roof', 'detail'].includes(part.role), 'part role');
    requireValue(
      part.occlusionGroup === null || stringMatches(part.occlusionGroup, idPattern),
      'occlusion group',
    );
    requireValue(Number.isSafeInteger(part.nodeIndex) && part.nodeIndex >= 0, 'part nodeIndex');
  }
  if (value.tree !== undefined) {
    const tree = value.tree;
    const tuple = (v: unknown): v is number[] =>
      Array.isArray(v) &&
      v.length === 4 &&
      v.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1000);
    requireValue(object(tree) && tree.formatVersion === 2, 'tree render version');
    requireValue(tree.foliage === 'spruce' || tree.foliage === 'broadleaf', 'tree render foliage');
    requireValue(tree.ambientOcclusion === undefined, 'tree render ambient occlusion');
    requireValue(
      value.parts.length === 1 && value.parts[0].occlusionGroup === 'shell',
      'tree render semantic group',
    );
    requireValue(
      Array.isArray(tree.crowns) &&
        tree.crowns.length === 2 &&
        tree.crowns.every((c: unknown) => tuple(c) && c[0] > 0 && c[1] >= 0.001 && c[3] > 0),
      'tree render crowns',
    );
    requireValue(
      tuple(tree.trunk) && tree.trunk.slice(0, 3).every((n: number) => n > 0),
      'tree render trunk',
    );
    requireValue(
      typeof tree.trunkBase === 'number' &&
        Number.isFinite(tree.trunkBase) &&
        Math.abs(tree.trunkBase) <= 1000,
      'tree render trunk base',
    );
    requireValue(
      [tree.crownColor, tree.trunkColor].every(
        (c) => typeof c === 'string' && /^#[a-f0-9]{6}$/i.test(c),
      ),
      'tree render colors',
    );
  }
  return value as BuildingParts;
}
export function validateWorldManifest(value: unknown): WorldManifest {
  requireValue(
    object(value) &&
      value.formatVersion === WORLD_FORMAT_VERSION &&
      stringMatches(value.worldId, assetPattern),
    'manifest version/worldId',
  );
  requireValue(
    stringMatches(value.mapVersion, hashPattern) &&
      stringMatches(value.simulationConfigHash, hashPattern),
    'manifest hash',
  );
  validateBounds(value.bounds);
  requireValue(object(value.grid), 'grid required');
  const expectedGrid = createWorldGrid(value.bounds, value.grid.cellSize);
  requireValue(
    canonicalJson(value.grid) === canonicalJson(expectedGrid),
    'grid disagrees with bounds',
  );
  requireValue(
    object(value.files) &&
      Object.keys(value.files).length > 0 &&
      Object.keys(value.files).length <= 100_000,
    'manifest files',
  );
  for (const [file, hash] of Object.entries(value.files)) {
    resourcePath(file);
    requireValue(stringMatches(hash, hashPattern), 'file hash');
  }
  const fileRef = (path: unknown) => {
    resourcePath(path);
    requireValue(Object.hasOwn(value.files, path), `unlisted file ${path}`);
  };
  fileRef(value.worldFile);
  requireValue(
    Array.isArray(value.cells) &&
      value.cells.length > 0 &&
      value.cells.length <= 10_000 &&
      value.cells.length === expectedGrid.columns * expectedGrid.rows,
    'manifest cells',
  );
  const cells = new Set<string>();
  for (const cell of value.cells) {
    requireValue(
      object(cell) && stringMatches(cell.cellId, idPattern) && !cells.has(cell.cellId),
      'manifest cell ID',
    );
    cells.add(cell.cellId);
    fileRef(cell.file);
    validateBounds(cell.bounds);
    requireValue(
      canonicalJson(cell.bounds) ===
        canonicalJson(worldCellBounds(value.bounds, expectedGrid, cell.cellId)),
      'cell bounds disagree with grid',
    );
    requireValue(
      Array.isArray(cell.assetIds) &&
        cell.assetIds.length <= 10_000 &&
        cell.assetIds.every((id: unknown) => stringMatches(id, assetPattern)) &&
        canonicalJson(cell.assetIds) === canonicalJson([...new Set(cell.assetIds)].sort()),
      'cell asset dependencies',
    );
    if (cell.graphicsPacks !== undefined) {
      requireValue(
        Array.isArray(cell.graphicsPacks) &&
          cell.graphicsPacks.length <= 20_000 &&
          new Set(cell.graphicsPacks).size === cell.graphicsPacks.length,
        'cell graphics packs',
      );
      for (const path of cell.graphicsPacks) fileRef(path);
    }
  }
  requireValue(
    object(value.assets) && Object.keys(value.assets).length <= 10_000,
    'manifest assets',
  );
  for (const [id, asset] of Object.entries(value.assets)) {
    requireValue(
      object(asset) &&
        asset.assetId === id &&
        stringMatches(id, assetPattern) &&
        stringMatches(asset.version, hashPattern),
      'manifest asset',
    );
    validateBounds(asset.bounds);
    if (asset.modelFile !== undefined) fileRef(asset.modelFile);
    fileRef(asset.partsFile);
    fileRef(asset.collisionFile);
  }
  for (const cell of value.cells)
    for (const id of cell.assetIds)
      requireValue(Object.hasOwn(value.assets, id), `missing asset ${id}`);
  return value as WorldManifest;
}
/** Hash this canonical value to identify an immutable release, including every dependency. */
export function worldManifestIdentity(manifest: WorldManifest) {
  const { mapVersion: _mapVersion, ...identity } = manifest;
  return identity;
}
/** Explicit domain projection: render metadata can never accidentally alter the physics hash. */
export function simulationProjection(world: WorldDefinition) {
  const usedAssets = new Set(world.buildings.map((instance) => instance.assetId));
  const vector = ({ x, y, z }: Vec3) => ({ x, y, z });
  const rotation = ({ x, y, z, w }: Quat) => ({ x, y, z, w });
  const character = world.simulation.character;
  return {
    simulation: {
      tickRate: world.simulation.tickRate,
      gravity: vector(world.simulation.gravity),
      character: {
        height: character.height,
        radius: character.radius,
        speed: character.speed,
        sprintSpeed: character.sprintSpeed,
        mass: character.mass,
      },
    },
    bounds: { min: vector(world.bounds.min), max: vector(world.bounds.max) },
    spawnPoints: world.spawnPoints.map(vector),
    itemCatalog: Object.fromEntries(
      Object.entries(world.itemCatalog.types).map(([id, t]) => [id, itemPhysicsDefinition(t)]),
    ),
    initialItems: world.initialItems,
    entities: [...world.entities]
      .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0))
      .map((e) => ({
        entityId: e.entityId,
        kind: e.kind,
        position: vector(e.position),
        size: vector(e.size),
        mass: e.mass,
        friction: e.friction,
        restitution: e.restitution,
      })),
    buildings: [...world.buildings]
      .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0))
      .map((instance) => ({
        entityId: instance.entityId,
        assetId: instance.assetId,
        position: vector(instance.position),
        rotation: rotation(instance.rotation),
      })),
    buildingAssets: Object.fromEntries(
      Object.entries(world.buildingAssets)
        .filter(([id]) => usedAssets.has(id))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, a]) => [
          id,
          {
            assetId: a.assetId,
            colliders: a.colliders.map((collider) => {
              const common = {
                id: collider.id,
                kind: collider.kind,
                position: vector(collider.position),
                rotation: rotation(collider.rotation),
                friction: collider.friction,
                restitution: collider.restitution,
              };
              return collider.kind === 'box'
                ? { ...common, size: vector(collider.size) }
                : { ...common, vertices: collider.vertices, indices: collider.indices };
            }),
          },
        ]),
    ),
  };
}

export const WORLD_RESOURCE_LIMITS = Object.freeze({
  cellBytes: 512 * 1024,
  headerBytes: 256 * 1024,
  modelBytes: 4 * 1024 * 1024,
  collisionBytes: 8 * 1024 * 1024,
  partsBytes: 512 * 1024,
});
const trustedManifests = new WeakSet<WorldManifest>();
/**
 * Полная проверка манифеста на тысячах файлов занимает миллисекунды, а загрузчики ячеек
 * повторяют её при каждом вызове. Владелец, который уже проверил манифест и больше его
 * не изменяет (клиент в пределах одной версии мира), может объявить объект проверенным.
 * Без этого вызова поведение прежнее: проверка при каждой загрузке.
 */
export function trustWorldManifest(manifest: WorldManifest): WorldManifest {
  validateWorldManifest(manifest);
  trustedManifests.add(manifest);
  return manifest;
}
function validateManifestOnce(manifest: WorldManifest): void {
  if (!trustedManifests.has(manifest)) validateWorldManifest(manifest);
}
export type ReadVerifiedBytes = (path: string, expectedHash: string) => Promise<Uint8Array>;

async function readJson(
  manifest: WorldManifest,
  read: ReadVerifiedBytes,
  path: string,
  maxBytes: number,
) {
  requireValue(Object.hasOwn(manifest.files, path), `unlisted file ${path}`);
  const bytes = await read(path, manifest.files[path]);
  requireValue(bytes.byteLength <= maxBytes, `resource byte limit: ${path}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function loadWorldHeader(
  manifest: WorldManifest,
  read: ReadVerifiedBytes,
): Promise<WorldHeader> {
  validateManifestOnce(manifest);
  const header = validateWorldHeader(
    await readJson(manifest, read, manifest.worldFile, WORLD_RESOURCE_LIMITS.headerBytes),
  );
  requireValue(header.worldId === manifest.worldId, 'world identity mismatch');
  requireValue(
    canonicalJson(header.bounds) === canonicalJson(manifest.bounds),
    'world bounds mismatch',
  );
  return header;
}

function validateCellPlacement(manifest: WorldManifest, cell: WorldCell) {
  const entry = manifest.cells.find((item) => item.cellId === cell.cellId);
  requireValue(entry, 'cell identity mismatch');
  const assetIds = [...new Set(cell.buildings.map((building) => building.assetId))].sort();
  requireValue(
    canonicalJson(assetIds) === canonicalJson(entry.assetIds),
    'cell asset dependency mismatch',
  );
  for (const item of cell.statics) {
    requireValue(
      cellsIntersectingBounds(manifest.bounds, manifest.grid, primitiveBounds(item)).includes(
        cell.cellId,
      ),
      `static ${item.entityId} outside cell`,
    );
  }
  for (const item of cell.buildings) {
    const asset = manifest.assets[item.assetId];
    requireValue(asset, `missing asset ${item.assetId}`);
    validateBuildingBounds(
      item,
      { assetId: item.assetId, bounds: asset.bounds, colliders: [] },
      manifest.bounds,
    );
    requireValue(
      cellsIntersectingBounds(
        manifest.bounds,
        manifest.grid,
        buildingBounds(item, asset.bounds),
      ).includes(cell.cellId),
      `building ${item.entityId} outside cell`,
    );
  }
}

export async function loadWorldCell(
  manifest: WorldManifest,
  cellId: string,
  read: ReadVerifiedBytes,
): Promise<WorldCell> {
  validateManifestOnce(manifest);
  const entry = manifest.cells.find((item) => item.cellId === cellId);
  requireValue(entry, `unknown cell ${cellId}`);
  const cell = validateWorldCell(
    await readJson(manifest, read, entry.file, WORLD_RESOURCE_LIMITS.cellBytes),
  );
  requireValue(cell.cellId === entry.cellId, 'cell identity mismatch');
  validateCellPlacement(manifest, cell);
  return cell;
}

/** Reads only one cell and its collider dependencies; never fetches visual models or remote assets. */
export async function loadCellPhysics(
  manifest: WorldManifest,
  cellId: string,
  read: ReadVerifiedBytes,
  loadedCell?: WorldCell,
): Promise<LocalStaticSet> {
  validateManifestOnce(manifest);
  const cell = loadedCell
    ? validateWorldCell(loadedCell)
    : await loadWorldCell(manifest, cellId, read);
  validateCellPlacement(manifest, cell);
  if (cell.cellId !== cellId) throw new Error('Cell identity mismatch');
  const entry = manifest.cells.find((item) => item.cellId === cellId)!;
  const assets: (readonly [string, BuildingPhysicsAsset])[] = new Array(entry.assetIds.length);
  let next = 0;
  // A dense cell must not enqueue its entire model catalogue into VerifiedResources.
  await Promise.all(
    Array.from({ length: Math.min(8, entry.assetIds.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= entry.assetIds.length) return;
        const id = entry.assetIds[index],
          descriptor = manifest.assets[id];
        const asset = validateBuildingPhysicsAsset(
          await readJson(
            manifest,
            read,
            descriptor.collisionFile,
            WORLD_RESOURCE_LIMITS.collisionBytes,
          ),
        );
        requireValue(asset.assetId === id, 'asset key disagrees');
        requireValue(
          canonicalJson(asset.bounds) === canonicalJson(descriptor.bounds),
          'asset bounds mismatch',
        );
        assets[index] = [id, asset];
      }
    }),
  );
  return { cell, buildingAssets: Object.fromEntries(assets) };
}

/** Read callbacks verify SHA-256 bytes at the application boundary (HTTP or filesystem). */
export async function loadWorldBundle(
  manifest: WorldManifest,
  read: ReadVerifiedBytes,
): Promise<WorldDefinition> {
  const header = await loadWorldHeader(manifest, read);
  const [cells, assets] = await Promise.all([
    Promise.all(
      manifest.cells.map(async (entry) => {
        const cell = validateWorldCell(
          await readJson(manifest, read, entry.file, WORLD_RESOURCE_LIMITS.cellBytes),
        );
        requireValue(cell.cellId === entry.cellId, 'cell identity mismatch');
        validateCellPlacement(manifest, cell);
        return cell;
      }),
    ),
    Promise.all(
      Object.entries(manifest.assets).map(
        async ([id, entry]) =>
          [
            id,
            await readJson(
              manifest,
              read,
              entry.collisionFile,
              WORLD_RESOURCE_LIMITS.collisionBytes,
            ),
          ] as const,
      ),
    ),
  ]);
  const merged = mergeWorldCells(cells);
  const world = validateWorld({
    ...header,
    entities: merged.statics,
    buildings: merged.buildings,
    buildingAssets: Object.fromEntries(assets),
  });
  for (const [id, entry] of Object.entries(manifest.assets))
    requireValue(
      canonicalJson(world.buildingAssets[id].bounds) === canonicalJson(entry.bounds),
      'asset bounds mismatch',
    );

  // A partial duplicate at a seam would leave another client without a required collider.
  const memberships = new Map<string, string[]>();
  for (const cell of cells)
    for (const item of [...cell.statics, ...cell.buildings]) {
      let ids = memberships.get(item.entityId);
      if (!ids) memberships.set(item.entityId, (ids = []));
      ids.push(cell.cellId);
    }
  const covered = [
    ...merged.statics.map((item) => ({ entityId: item.entityId, bounds: primitiveBounds(item) })),
    ...merged.buildings.map((item) => ({
      entityId: item.entityId,
      bounds: buildingBounds(item, manifest.assets[item.assetId].bounds),
    })),
  ];
  for (const { entityId, bounds } of covered) {
    const expected = cellsIntersectingBounds(manifest.bounds, manifest.grid, bounds).sort();
    requireValue(
      canonicalJson([...memberships.get(entityId)!].sort()) === canonicalJson(expected),
      `incomplete cell coverage: ${entityId}`,
    );
  }
  return world;
}
