import {
  validateItemCatalog,
  validPose,
  WORLD_FORMAT_VERSION,
  type WorldDefinition,
  type Vec3,
} from './index.js';
import {
  validateBuildingPhysicsAsset,
  validateBuildingInstances,
  validateBuildingBounds,
} from './world-bundle.js';

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid world: ${message}`);
}
function vector(value: unknown, label: string): asserts value is Vec3 {
  invariant(value && typeof value === 'object', label);
  for (const axis of ['x', 'y', 'z'] as const) {
    const component = (value as Vec3)[axis];
    invariant(
      typeof component === 'number' && Number.isFinite(component) && Math.abs(component) <= 100_000,
      `${label}.${axis}`,
    );
  }
}
/** Validate content at both process boundaries before constructing any physics objects. */
export function validateWorld(value: unknown): WorldDefinition {
  invariant(value && typeof value === 'object', 'object required');
  const world = value as WorldDefinition;
  invariant(world.formatVersion === WORLD_FORMAT_VERSION, 'unsupported formatVersion');
  invariant(
    typeof world.worldId === 'string' && /^[a-z0-9-]{1,64}$/.test(world.worldId),
    'worldId',
  );
  invariant(world.bounds && typeof world.bounds === 'object', 'bounds');
  vector(world.bounds.min, 'bounds.min');
  vector(world.bounds.max, 'bounds.max');
  for (const axis of ['x', 'y', 'z'] as const)
    invariant(world.bounds.min[axis] < world.bounds.max[axis], 'ordered bounds');
  invariant(world.simulation?.tickRate === 60, 'supported tick rate is 60 Hz');
  vector(world.simulation.gravity, 'gravity');
  const character = world.simulation.character;
  invariant(character && typeof character === 'object', 'character');
  for (const key of ['height', 'radius', 'speed', 'sprintSpeed', 'mass'] as const) {
    invariant(
      Number.isFinite(character[key]) && character[key] > 0 && character[key] <= 1000,
      `character.${key}`,
    );
  }
  invariant(character.sprintSpeed >= character.speed, 'sprintSpeed must be at least speed');
  invariant(character.height >= 2 * character.radius, 'capsule height');
  invariant(Array.isArray(world.entities) && world.entities.length <= 1000, 'entities');
  const ids = new Set<string>();
  for (const entity of world.entities) {
    invariant(entity && typeof entity === 'object', 'entity');
    invariant(
      typeof entity.entityId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(entity.entityId),
      'entityId',
    );
    invariant(!ids.has(entity.entityId), `duplicate ID ${entity.entityId}`);
    ids.add(entity.entityId);
    invariant(entity.kind === 'obstacle', 'entity kind');
    vector(entity.position, `${entity.entityId}.position`);
    vector(entity.size, `${entity.entityId}.size`);
    invariant(
      Object.values(entity.size).every((n) => n > 0 && n <= 1000),
      'positive box size',
    );
    invariant(Number.isFinite(entity.mass) && entity.mass === 0, 'mass');
    invariant(
      Number.isFinite(entity.friction) && entity.friction >= 0 && entity.friction <= 10,
      'friction',
    );
    invariant(
      Number.isFinite(entity.restitution) && entity.restitution >= 0 && entity.restitution <= 1,
      'restitution',
    );
    invariant(typeof entity.color === 'string' && /^#[a-f\d]{6}$/i.test(entity.color), 'color');
  }
  validateItemCatalog(world.itemCatalog);
  invariant(Array.isArray(world.initialItems) && world.initialItems.length <= 1000, 'initialItems');
  for (const seed of world.initialItems) {
    invariant(
      seed &&
        typeof seed.seedId === 'string' &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(seed.seedId) &&
        !ids.has(seed.seedId),
      'initial item ID',
    );
    ids.add(seed.seedId);
    invariant(Object.hasOwn(world.itemCatalog.types, seed.typeId), 'unknown item type');
    invariant(validPose(seed), 'initial item pose');
  }
  invariant(
    world.buildingAssets &&
      typeof world.buildingAssets === 'object' &&
      !Array.isArray(world.buildingAssets),
    'buildingAssets',
  );
  for (const [assetId, asset] of Object.entries(world.buildingAssets)) {
    validateBuildingPhysicsAsset(asset);
    invariant(asset.assetId === assetId, 'asset key disagrees');
  }
  validateBuildingInstances(world.buildings);
  for (const building of world.buildings) {
    invariant(!ids.has(building.entityId), `duplicate ID ${building.entityId}`);
    ids.add(building.entityId);
    invariant(
      Object.hasOwn(world.buildingAssets, building.assetId),
      `missing asset ${building.assetId}`,
    );
    validateBuildingBounds(building, world.buildingAssets[building.assetId], world.bounds);
  }
  invariant(
    Array.isArray(world.spawnPoints) &&
      world.spawnPoints.length >= 8 &&
      world.spawnPoints.length <= 256,
    'at least eight spawn points',
  );
  for (const spawn of world.spawnPoints) {
    vector(spawn, 'spawn');
    invariant(
      spawn.x - character.radius > world.bounds.min.x &&
        spawn.x + character.radius < world.bounds.max.x &&
        spawn.z - character.radius > world.bounds.min.z &&
        spawn.z + character.radius < world.bounds.max.z,
      'spawn outside bounds',
    );
    const centerY = spawn.y + character.height / 2;
    for (const entity of world.entities) {
      const intersects =
        Math.abs(spawn.x - entity.position.x) < entity.size.x / 2 + character.radius &&
        Math.abs(spawn.z - entity.position.z) < entity.size.z / 2 + character.radius &&
        Math.abs(centerY - entity.position.y) < (entity.size.y + character.height) / 2 - 0.01;
      invariant(!intersects, `spawn intersects ${entity.entityId}`);
    }
  }
  if (world.landmarks !== undefined) {
    invariant(Array.isArray(world.landmarks) && world.landmarks.length <= 256, 'landmarks');
    const landmarkIds = new Set<string>();
    for (const landmark of world.landmarks) {
      invariant(
        landmark &&
          typeof landmark === 'object' &&
          typeof landmark.id === 'string' &&
          /^[a-z0-9-]{1,64}$/.test(landmark.id) &&
          !landmarkIds.has(landmark.id),
        'landmark id',
      );
      landmarkIds.add(landmark.id);
      invariant(
        typeof landmark.name === 'string' &&
          landmark.name.trim().length > 0 &&
          landmark.name.length <= 80,
        `landmark ${landmark.id} name`,
      );
      vector(landmark.position, `landmark ${landmark.id} position`);
    }
  }
  for (let i = 0; i < world.spawnPoints.length; i++)
    for (let j = i + 1; j < world.spawnPoints.length; j++) {
      const a = world.spawnPoints[i],
        b = world.spawnPoints[j];
      invariant(
        Math.hypot(a.x - b.x, a.z - b.z) >= character.radius * 2 + 0.1,
        'spawn points overlap',
      );
    }
  return world;
}
/** Content addressing is stable across object key order and file formatting. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
