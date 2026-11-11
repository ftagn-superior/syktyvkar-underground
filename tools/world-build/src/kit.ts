import type { BuildingPhysicsAsset, StaticCollider } from '@su/contracts';
import type { StaticMeshPart } from './glb.js';
import { meshPart } from './house.js';
import { addOrientedBox, addOutwardFace } from './facade.js';

/**
 * Модель «из конструктора»: части из параллелепипедов и цилиндров, отдельно —
 * коробки столкновений. Подходит для памятников и других штучных объектов.
 * Координаты локальные: X — восток, Y — вверх, Z — юг; `yaw` — поворот вокруг Y в градусах.
 */
type Triple = [number, number, number];
export type KitShape =
  | { box: { center: Triple; size: Triple; yaw?: number } }
  | {
      cylinder: {
        center: Triple;
        radius: number;
        length: number;
        axis: 'x' | 'y' | 'z';
        sides?: number;
      };
    };
export interface KitRecipe {
  formatVersion: 1;
  parts: {
    id: string;
    role: 'wall' | 'roof' | 'detail';
    /** Становится ли часть прозрачной, закрывая персонажа. */
    fade: boolean;
    color: string;
    shapes: KitShape[];
  }[];
  colliders: { id: string; center: Triple; size: Triple; yaw?: number }[];
}

const finite = (values: unknown, count: number) =>
  Array.isArray(values) &&
  values.length === count &&
  values.every((n) => Number.isFinite(n) && Math.abs(n) <= 10_000);
const axisOf = (yaw = 0): [number, number] => {
  const a = (yaw * Math.PI) / 180;
  return [Math.cos(a), -Math.sin(a)];
};

function addCylinder(
  part: StaticMeshPart,
  shape: Extract<KitShape, { cylinder: unknown }>['cylinder'],
) {
  const sides = shape.sides ?? 12;
  if (!Number.isInteger(sides) || sides < 3 || sides > 64)
    throw new Error('Invalid cylinder sides');
  const [cx, cy, cz] = shape.center;
  // Локальный круг в плоскости (a, b); ось цилиндра — третья координата.
  const place = (a: number, b: number, c: number): number[] =>
    shape.axis === 'y'
      ? [cx + a, cy + c, cz + b]
      : shape.axis === 'x'
        ? [cx + c, cy + a, cz + b]
        : [cx + a, cy + b, cz + c];
  const ring = (c: number) =>
    Array.from({ length: sides }, (_, k) => {
      const angle = (k / sides) * Math.PI * 2;
      return place(Math.cos(angle) * shape.radius, Math.sin(angle) * shape.radius, c);
    });
  const half = shape.length / 2;
  const near = ring(-half),
    far = ring(half);
  const center = [cx, cy, cz];
  for (let k = 0; k < sides; k++) {
    const j = (k + 1) % sides;
    addOutwardFace(part, [near[k], near[j], far[j], far[k]], center);
  }
  addOutwardFace(part, near, center);
  addOutwardFace(part, far, center);
}

export function generateKit(
  assetId: string,
  recipe: KitRecipe,
): { parts: StaticMeshPart[]; physics: BuildingPhysicsAsset } {
  if (recipe.formatVersion !== 1) throw new Error('Unsupported kit recipe version');
  if (!Array.isArray(recipe.parts) || recipe.parts.length === 0) throw new Error('Kit needs parts');
  if (!Array.isArray(recipe.colliders) || recipe.colliders.length === 0)
    throw new Error('Kit needs at least one collider');
  const parts = recipe.parts.map((spec) => {
    if (!/^[a-z0-9-]{1,40}$/.test(spec.id)) throw new Error(`Invalid kit part ${spec.id}`);
    if (!['wall', 'roof', 'detail'].includes(spec.role))
      throw new Error(`Invalid kit role ${spec.id}`);
    if (!/^#[a-f0-9]{6}$/i.test(spec.color)) throw new Error(`Invalid kit color ${spec.id}`);
    const part = meshPart(spec.id, spec.role, spec.color);
    part.occlusionGroup = spec.fade ? 'shell' : null;
    for (const shape of spec.shapes) {
      if ('box' in shape) {
        if (!finite(shape.box.center, 3) || !finite(shape.box.size, 3))
          throw new Error(`Invalid kit box in ${spec.id}`);
        addOrientedBox(part, shape.box.center, shape.box.size, axisOf(shape.box.yaw));
      } else if ('cylinder' in shape) {
        const c = shape.cylinder;
        if (
          !finite(c.center, 3) ||
          !(c.radius > 0) ||
          !(c.length > 0) ||
          !['x', 'y', 'z'].includes(c.axis)
        )
          throw new Error(`Invalid kit cylinder in ${spec.id}`);
        addCylinder(part, c);
      } else throw new Error(`Unknown kit shape in ${spec.id}`);
    }
    return part;
  });
  const colliders: StaticCollider[] = recipe.colliders.map((box) => {
    if (!finite(box.center, 3) || !finite(box.size, 3))
      throw new Error(`Invalid kit collider ${box.id}`);
    const a = ((box.yaw ?? 0) * Math.PI) / 360;
    return {
      id: box.id,
      kind: 'box',
      position: { x: box.center[0], y: box.center[1], z: box.center[2] },
      rotation: { x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) },
      size: { x: box.size[0], y: box.size[1], z: box.size[2] },
      friction: 0.6,
      restitution: 0.05,
    };
  });
  const min = { x: Infinity, y: Infinity, z: Infinity },
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const part of parts)
    for (let i = 0; i < part.positions.length; i += 3)
      for (const [j, axis] of (['x', 'y', 'z'] as const).entries()) {
        min[axis] = Math.min(min[axis], part.positions[i + j]);
        max[axis] = Math.max(max[axis], part.positions[i + j]);
      }
  return { parts, physics: { assetId, bounds: { min, max }, colliders } };
}
