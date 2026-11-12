import type { BuildingPhysicsAsset, StaticCollider, Vec3, WorldDefinition } from '@su/contracts';

export function physicsFixture(): WorldDefinition {
  return {
    formatVersion: 3,
    worldId: 'test',
    bounds: { min: { x: -20, y: -10, z: -20 }, max: { x: 20, y: 10, z: 20 } },
    simulation: {
      tickRate: 60,
      gravity: { x: 0, y: -9.81, z: 0 },
      character: { height: 1.8, radius: 0.35, speed: 4, mass: 70 },
    },
    spawnPoints: [
      { x: 0, y: 0, z: 0 },
      { x: -3, y: 0, z: 0 },
      { x: 0, y: 0, z: 3 },
    ],
    buildings: [],
    buildingAssets: {},
    entities: [
      {
        entityId: 'floor',
        kind: 'obstacle',
        position: { x: 0, y: -0.5, z: 0 },
        size: { x: 40, y: 1, z: 40 },
        mass: 0,
        friction: 0.6,
        restitution: 0,
        color: '#fff',
      },
      {
        entityId: 'wall',
        kind: 'obstacle',
        position: { x: 5, y: 1.5, z: 0 },
        size: { x: 1, y: 3, z: 8 },
        mass: 0,
        friction: 0.6,
        restitution: 0,
        color: '#fff',
      },
      {
        entityId: 'crate-01',
        kind: 'crate',
        position: { x: 0, y: 0.52, z: 6 },
        size: { x: 1, y: 1, z: 1 },
        mass: 10,
        friction: 0.6,
        restitution: 0.05,
        color: '#fff',
      },
    ],
  };
}

const identity = { x: 0, y: 0, z: 0, w: 1 };
const quarterTurn = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

function box(id: string, position: Vec3, size: Vec3, rotation = identity): StaticCollider {
  return { id, kind: 'box', position, size, rotation, friction: 0.6, restitution: 0 };
}

/** Closed triangles for three solid arch members, keeping the passage genuinely empty. */
function archMesh(): StaticCollider {
  const vertices: number[] = [];
  const indices: number[] = [];
  const faces = [
    0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7,
    6, 3, 6, 2,
  ];
  for (const { center, size } of [
    { center: [-2, 1.5, 0], size: [1, 3, 1] },
    { center: [2, 1.5, 0], size: [1, 3, 1] },
    { center: [0, 3.25, 0], size: [5, 0.5, 1] },
  ]) {
    const offset = vertices.length / 3;
    for (const [x, y, z] of [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ]) {
      vertices.push(
        center[0] + (x * size[0]) / 2,
        center[1] + (y * size[1]) / 2,
        center[2] + (z * size[2]) / 2,
      );
    }
    indices.push(...faces.map((index) => index + offset));
  }
  return {
    id: 'arch',
    kind: 'mesh',
    position: { x: 0, y: 0, z: 0 },
    rotation: identity,
    friction: 0.6,
    restitution: 0,
    vertices,
    indices,
  };
}

/** Two differently oriented instances exercise the same reusable physical asset. */
export function buildingFixture(kind: 'courtyard' | 'arch'): WorldDefinition {
  const definition = physicsFixture();
  definition.entities = definition.entities.filter((entity) => entity.entityId !== 'wall');
  definition.entities.find((entity) => entity.kind === 'crate')!.position = {
    x: -15,
    y: 0.52,
    z: -15,
  };
  const asset: BuildingPhysicsAsset =
    kind === 'courtyard'
      ? {
          assetId: 'courtyard',
          bounds: { min: { x: -3.5, y: 0, z: -3.5 }, max: { x: 3.5, y: 3, z: 3 } },
          colliders: [
            box('west', { x: -3, y: 1.5, z: 0 }, { x: 6, y: 3, z: 1 }, quarterTurn),
            box('east', { x: 3, y: 1.5, z: 0 }, { x: 6, y: 3, z: 1 }, quarterTurn),
            box('north', { x: 0, y: 1.5, z: -3 }, { x: 7, y: 3, z: 1 }),
          ],
        }
      : {
          assetId: 'arch',
          bounds: { min: { x: -2.5, y: 0, z: -0.5 }, max: { x: 2.5, y: 3.5, z: 0.5 } },
          colliders: [archMesh()],
        };
  definition.buildingAssets = { [asset.assetId]: asset };
  definition.buildings = [
    {
      entityId: 'building-a',
      assetId: asset.assetId,
      position: { x: 0, y: 0, z: 0 },
      rotation: identity,
    },
    {
      entityId: 'building-b',
      assetId: asset.assetId,
      position: { x: 10, y: 0, z: 0 },
      rotation: quarterTurn,
    },
  ];
  return definition;
}
