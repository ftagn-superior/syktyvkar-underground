import type { HavokPhysicsWithBindings, HP_BodyId } from '@babylonjs/havok';
import type { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin.js';
import type { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { PhysicsShape } from '@babylonjs/core/Physics/v2/physicsShape.js';
import { validPose, type ItemPose, type ItemType, type Vec3 } from '@su/contracts';
import { createItemShape } from './item-shapes.js';

export interface ItemSupportHit {
  entityId: string;
  /** Item origin Y at first contact during this downward sweep. */
  contactY: number;
  point: Vec3;
  normal: Vec3;
}
export interface ItemSupportSweep {
  startY: number;
  endY: number;
  ignoreId?: string;
}

/**
 * The public Babylon query keeps only one hit. Migration needs every owner under
 * the actual item shape, including contacts away from its centre. Keep this
 * native adapter inside simulation; it only supports our non-floating-origin world.
 */
export function queryItemSupports(
  scene: Scene,
  plugin: HavokPlugin,
  bodies: PhysicsBody[],
  type: ItemType,
  pose: ItemPose,
  sweep: ItemSupportSweep,
): ItemSupportHit[] {
  const shape = createItemShape(type, scene);
  try {
    return queryShapeSupports(plugin, bodies, shape, pose, sweep);
  } finally {
    shape.dispose();
  }
}

/** Uses an already owned shape; does not allocate, mutate or dispose it. */
export function queryShapeSupports(
  plugin: HavokPlugin,
  bodies: PhysicsBody[],
  shape: PhysicsShape,
  pose: ItemPose,
  sweep: ItemSupportSweep,
): ItemSupportHit[] {
  if (
    !validPose(pose) ||
    !Number.isFinite(sweep.startY) ||
    !Number.isFinite(sweep.endY) ||
    sweep.startY <= sweep.endY
  )
    throw new Error('Invalid item support sweep');
  const native = plugin._hknp as HavokPhysicsWithBindings;
  const owners = new Map<bigint, string>();
  let ignore: HP_BodyId = [0n];
  for (const body of bodies) {
    const handle = body._pluginData.hpBodyId as HP_BodyId;
    owners.set(handle[0], body.transformNode.name);
    if (body.transformNode.name === sweep.ignoreId) ignore = handle;
  }
  const q = pose.rotation;
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  const vector = (v: [number, number, number]): Vec3 => ({ x: v[0], y: v[1], z: v[2] });
  const check = (result: unknown) => {
    if (result !== native.Result.RESULT_OK) throw new Error('Havok item support query failed');
  };
  // Saturation is never accepted as a proof of a unique support. Larger
  // collectors handle tiled triangle meshes; the hard bound fails closed.
  for (let capacity = 32; capacity <= 65536; capacity *= 2) {
    const [created, collector] = native.HP_QueryCollector_Create(capacity);
    check(created);
    try {
      check(
        native.HP_World_ShapeCastWithCollector(plugin.world, collector, [
          shape._pluginData,
          [q.x / norm, q.y / norm, q.z / norm, q.w / norm],
          [pose.position.x, sweep.startY, pose.position.z],
          [pose.position.x, sweep.endY, pose.position.z],
          false,
          ignore,
        ]),
      );
      const [counted, count] = native.HP_QueryCollector_GetNumHits(collector);
      check(counted);
      if (count >= capacity) continue;
      const hits: ItemSupportHit[] = [];
      for (let i = 0; i < count; i++) {
        const [read, [fraction, , contact]] = native.HP_QueryCollector_GetShapeCastResult(
          collector,
          i,
        );
        check(read);
        const entityId = owners.get(contact[0][0]);
        if (!entityId) throw new Error('Unknown body in item support query');
        hits.push({
          entityId,
          contactY: sweep.startY + fraction * (sweep.endY - sweep.startY),
          point: vector(contact[3]),
          normal: vector(contact[4]),
        });
      }
      return hits.sort((a, b) => b.contactY - a.contactY || a.entityId.localeCompare(b.entityId));
    } finally {
      native.HP_QueryCollector_Release(collector);
    }
  }
  throw new Error('Item support query exceeded hit capacity');
}
