import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { initialItemState, type StaticCollider, type Vec3 } from '@su/contracts';
import { BuildingColliders } from './building-colliders.js';
import { createPhysicsWorld } from './physics-world.js';
import { loadServerWasm } from './server.js';
import { physicsFixture } from './test-fixture.js';

const identity = { x: 0, y: 0, z: 0, w: 1 };
function meshBox(min: Vec3, max: Vec3): Extract<StaticCollider, { kind: 'mesh' }> {
  return {
    id: 'solid',
    kind: 'mesh',
    position: { x: 0, y: 0, z: 0 },
    rotation: identity,
    friction: 0.6,
    restitution: 0,
    vertices: [
      min.x,
      min.y,
      min.z,
      max.x,
      min.y,
      min.z,
      max.x,
      max.y,
      min.z,
      min.x,
      max.y,
      min.z,
      min.x,
      min.y,
      max.z,
      max.x,
      min.y,
      max.z,
      max.x,
      max.y,
      max.z,
      min.x,
      max.y,
      max.z,
    ],
    indices: [
      0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3,
      7, 6, 3, 6, 2,
    ],
  };
}
async function meshWorld(colliders: StaticCollider[]) {
  const definition = physicsFixture();
  definition.entities = [];
  definition.initialItems = [];
  definition.buildingAssets = {
    solid: {
      assetId: 'solid',
      bounds: { min: { x: -10, y: -5, z: -10 }, max: { x: 10, y: 5, z: 10 } },
      colliders,
    },
  };
  definition.buildings = [
    { entityId: 'solid', assetId: 'solid', position: { x: 0, y: 0, z: 0 }, rotation: identity },
  ];
  return createPhysicsWorld(definition, await loadServerWasm(), false);
}
const itemAt = (position: Vec3, typeId = 'wooden-crate', rotation = identity) =>
  initialItemState({ seedId: 'saved', typeId, position, rotation });

describe('saved dynamic contact with closed mesh volumes', () => {
  it('accepts shallow saved contact unchanged while retaining strict placement and deep rejection', async () => {
    const world = await meshWorld([meshBox({ x: -10, y: -2, z: -10 }, { x: 10, y: 0, z: 10 })]);
    try {
      const item = itemAt({ x: 0, y: 0.5 - 0.00003, z: 0 });
      const before = structuredClone(item);
      expect(world.checkPlacement(item.typeId, item)).toBe('BLOCKED');
      expect(world.checkSavedItem(item)).toBeUndefined();
      expect(item).toEqual(before);
      expect(world.checkSavedItem(itemAt({ x: 0, y: 0.5 - 0.02, z: 0 }))).toBe('BLOCKED');
      const unsafeRecovery = {
        ...item,
        safePose: { ...item.safePose, position: { x: 0, y: 0.48, z: 0 } },
      };
      expect(world.checkSavedItem(unsafeRecovery)).toBe('BLOCKED');
    } finally {
      world.dispose();
    }
  });

  it('accepts a settled rotated monument on a sloped closed mesh without advancing physics', async () => {
    const floor = meshBox({ x: -10, y: -2, z: -10 }, { x: 10, y: 0, z: 10 });
    const q = Quaternion.FromEulerAngles(0.0034, 0, -0.024);
    for (let i = 0; i < floor.vertices.length; i += 3) {
      const p = Vector3.FromArray(floor.vertices, i).applyRotationQuaternion(q);
      floor.vertices.splice(i, 3, p.x, p.y, p.z);
    }
    const world = await meshWorld([floor]);
    try {
      const rotation = { x: q.x, y: q.y, z: q.z, w: q.w };
      const item = itemAt({ x: 0, y: 2, z: 0 }, 'confidence-monument', rotation);
      const hits = world.queryItemSupports(item.typeId, item, { startY: 2.1, endY: 1.9 });
      expect(hits).toHaveLength(1);
      const normal = Vector3.Up().applyRotationQuaternion(q);
      item.position.y = (2 - 0.00003) / normal.y;
      expect(Math.abs(item.position.y - hits[0].contactY)).toBeLessThan(0.001);
      item.safePose = { position: { x: 0, y: 2.1, z: 0 }, rotation };
      const before = structuredClone(item);
      expect(world.checkPlacement(item.typeId, item)).toBe('BLOCKED');
      expect(world.checkSavedItem(item)).toBeUndefined();
      expect(item).toEqual(before);
    } finally {
      world.dispose();
    }
  });

  it('retains whole-volume rejection for boxes and spheres, including centers near a surface', async () => {
    const world = await meshWorld([meshBox({ x: -4, y: -4, z: -4 }, { x: 4, y: 4, z: 4 })]);
    try {
      for (const typeId of ['wooden-crate', 'watermelon-ball']) {
        expect(world.checkSavedItem(itemAt({ x: 0, y: 0, z: 0 }, typeId))).toBe('BLOCKED');
        expect(world.checkSavedItem(itemAt({ x: 4 - 0.00003, y: 0, z: 0 }, typeId))).toBe(
          'BLOCKED',
        );
      }
    } finally {
      world.dispose();
    }
  });

  it('still rejects actual shape crossings through a thin closed partition', async () => {
    const world = await meshWorld([
      meshBox({ x: -0.0025, y: -3, z: -3 }, { x: 0.0025, y: 3, z: 3 }),
    ]);
    try {
      const rotation = { x: 0, y: Math.sin(Math.PI / 12), z: 0, w: Math.cos(Math.PI / 12) };
      // One corner is within the 5mm slab, while the rotated box crosses deeply.
      expect(world.checkSavedItem(itemAt({ x: 0.181, y: 0, z: 0 }, 'wooden-crate', rotation))).toBe(
        'BLOCKED',
      );
      expect(world.checkSavedItem(itemAt({ x: 0.2, y: 0, z: 0 }, 'watermelon-ball'))).toBe(
        'BLOCKED',
      );
    } finally {
      world.dispose();
    }
  });

  it('requires an exterior witness outside overlapping shells and separate bodies', async () => {
    const first = meshBox({ x: -2, y: -2, z: -2 }, { x: 0.001, y: 2, z: 2 });
    const second = meshBox({ x: -0.001, y: -2, z: -2 }, { x: 2, y: 2, z: 2 });
    const world = await meshWorld([]);
    const bodies = new BuildingColliders(world.scene);
    try {
      const point = { x: 0, y: 0, z: 0 };
      for (const separate of [false, true]) {
        const merged = {
          ...first,
          vertices: [...first.vertices, ...second.vertices],
          indices: [...first.indices, ...second.indices.map((index) => index + 8)],
        };
        const assets = separate ? [first, second] : [merged];
        assets.forEach((collider, index) => {
          const id = 'overlap-' + index;
          bodies.add(
            { entityId: id, assetId: id, position: { x: 0, y: 0, z: 0 }, rotation: identity },
            {
              assetId: id,
              bounds: { min: { x: -2, y: -2, z: -2 }, max: { x: 2, y: 2, z: 2 } },
              colliders: [collider],
            },
          );
        });
        expect(bodies.contains(point, 0.01)).toBe(true);
        expect(bodies.contains({ x: 2 - 0.00003, y: 0, z: 0 }, 0.01)).toBe(false);
        assets.forEach((_, index) => bodies.remove('overlap-' + index));
      }
    } finally {
      bodies.dispose();
      world.dispose();
    }
  });

  it('bounds surface clearance after both collider and building transforms', async () => {
    const world = await meshWorld([]);
    const bodies = new BuildingColliders(world.scene);
    try {
      const collider = meshBox({ x: -4, y: -4, z: -4 }, { x: 4, y: 4, z: 4 });
      const shapeRotation = Quaternion.FromEulerAngles(0, 0, Math.PI / 6);
      const bodyRotation = Quaternion.FromEulerAngles(0, Math.PI / 4, 0);
      collider.rotation = {
        x: shapeRotation.x,
        y: shapeRotation.y,
        z: shapeRotation.z,
        w: shapeRotation.w,
      };
      collider.position = { x: 1, y: 2, z: -3 };
      const position = { x: 64, y: 7, z: -400 };
      bodies.add(
        {
          entityId: 'transformed',
          assetId: 'transformed',
          position,
          rotation: { x: bodyRotation.x, y: bodyRotation.y, z: bodyRotation.z, w: bodyRotation.w },
        },
        {
          assetId: 'transformed',
          bounds: { min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } },
          colliders: [collider],
        },
      );
      const transform = (x: number) =>
        new Vector3(x, 0, 0)
          .applyRotationQuaternion(shapeRotation)
          .add(new Vector3(1, 2, -3))
          .applyRotationQuaternion(bodyRotation)
          .add(new Vector3(position.x, position.y, position.z));
      const shallow = transform(4 - 0.00003);
      expect(bodies.contains(shallow)).toBe(true);
      expect(bodies.contains(shallow, 0.01)).toBe(false);
      expect(bodies.contains(transform(4 - 0.02), 0.01)).toBe(true);
    } finally {
      bodies.dispose();
      world.dispose();
    }
  });
});
