import {
  WORLD_FORMAT_VERSION,
  type Bounds,
  type BuildingInstance,
  type BuildingParts,
  type BuildingPhysicsAsset,
  type Quat,
  type Vec3,
  type WorldBase,
  type WorldCell,
  type WorldDefinition,
  type WorldManifest,
} from './index.js';
import { validateWorld } from './world.js';
import { canonicalJson } from './world.js';
import { validateClosedMeshTopology } from './mesh-volume.js';

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
function transformed(point: Vec3, position: Vec3, q: Quat): Vec3 {
  const tx = 2 * (q.y * point.z - q.z * point.y);
  const ty = 2 * (q.z * point.x - q.x * point.z);
  const tz = 2 * (q.x * point.y - q.y * point.x);
  return {
    x: position.x + point.x + q.w * tx + q.y * tz - q.z * ty,
    y: position.y + point.y + q.w * ty + q.z * tx - q.x * tz,
    z: position.z + point.z + q.w * tz + q.x * ty - q.y * tx,
  };
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
      containsPoint(bounds, transformed(point, instance.position, instance.rotation)),
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
    object(value) && value.formatVersion === 1 && stringMatches(value.cellId, idPattern),
    'cell',
  );
  validateBuildingInstances(value.buildings);
  return value as WorldCell;
}
export function validateBuildingPhysicsAsset(value: unknown): BuildingPhysicsAsset {
  requireValue(object(value) && stringMatches(value.assetId, assetPattern), 'physics assetId');
  validateBounds(value.bounds);
  requireValue(
    Array.isArray(value.colliders) && value.colliders.length > 0 && value.colliders.length <= 2048,
    'colliders',
  );
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
          containsPoint(value.bounds, transformed(point, shape.position, shape.rotation)),
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
          containsPoint(value.bounds, transformed(point, shape.position, shape.rotation)),
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
    Array.isArray(value.cells) && value.cells.length > 0 && value.cells.length <= 10_000,
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
    fileRef(asset.modelFile);
    fileRef(asset.partsFile);
    fileRef(asset.collisionFile);
  }
  return value as WorldManifest;
}
/** Hash this canonical value to identify an immutable release, including every dependency. */
export function worldManifestIdentity(manifest: WorldManifest) {
  const { mapVersion: _mapVersion, ...identity } = manifest;
  return identity;
}
/** Explicit domain projection: render metadata can never accidentally alter the physics hash. */
export function simulationProjection(world: WorldDefinition) {
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
      Object.entries(world.itemCatalog.types).map(([id, t]) => [
        id,
        {
          model: t.model,
          size: vector(t.size),
          mass: t.mass,
          friction: t.friction,
          restitution: t.restitution,
        },
      ]),
    ),
    initialItems: world.initialItems,
    entities: world.entities.map((e) => ({
      entityId: e.entityId,
      kind: e.kind,
      position: vector(e.position),
      size: vector(e.size),
      mass: e.mass,
      friction: e.friction,
      restitution: e.restitution,
    })),
    buildings: world.buildings.map((instance) => ({
      entityId: instance.entityId,
      assetId: instance.assetId,
      position: vector(instance.position),
      rotation: rotation(instance.rotation),
    })),
    buildingAssets: Object.fromEntries(
      Object.entries(world.buildingAssets).map(([id, a]) => [
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
/** Read callbacks verify SHA-256 bytes at the application boundary (HTTP or filesystem). */
export async function loadWorldBundle(
  manifest: WorldManifest,
  readVerifiedBytes: (path: string, expectedHash: string) => Promise<Uint8Array>,
): Promise<WorldDefinition> {
  validateWorldManifest(manifest);
  const readJson = async (path: string) =>
    JSON.parse(new TextDecoder().decode(await readVerifiedBytes(path, manifest.files[path])));
  const [base, cells, assets] = await Promise.all([
    readJson(manifest.worldFile) as Promise<WorldBase>,
    Promise.all(
      manifest.cells.map(async (entry) => {
        const cell = validateWorldCell(await readJson(entry.file));
        requireValue(cell.cellId === entry.cellId, 'cell identity mismatch');
        return cell;
      }),
    ),
    Promise.all(
      Object.entries(manifest.assets).map(
        async ([assetId, entry]) => [assetId, await readJson(entry.collisionFile)] as const,
      ),
    ),
  ]);
  const world = validateWorld({
    ...base,
    buildings: cells.flatMap((cell) => cell.buildings),
    buildingAssets: Object.fromEntries(assets),
  });
  requireValue(world.worldId === manifest.worldId, 'world identity mismatch');
  requireValue(
    canonicalJson(world.bounds) === canonicalJson(manifest.bounds),
    'world bounds mismatch',
  );
  // validateWorld checks every physics asset once before we use its fields.
  // Mesh topology validation must not repeat for the same parsed asset.
  for (const [assetId, entry] of Object.entries(manifest.assets)) {
    requireValue(
      canonicalJson(world.buildingAssets[assetId].bounds) === canonicalJson(entry.bounds),
      'asset bounds mismatch',
    );
  }
  for (let index = 0; index < cells.length; index++) {
    for (const instance of cells[index].buildings) {
      validateBuildingBounds(
        instance,
        world.buildingAssets[instance.assetId],
        manifest.cells[index].bounds,
      );
    }
  }
  return world;
}
