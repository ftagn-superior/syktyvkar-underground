import {
  foliageGeometry,
  foliageOcclusion,
  GLOW_KIND,
  type BuildingPhysicsAsset,
  type GlowKind,
  type StaticCollider,
  type StaticLightSource,
} from '@su/contracts';
import type { StaticMeshPart } from './glb.js';
import { meshPart } from './house.js';
import { mergeParts } from './merge.js';
import { bakeLocalAo } from './ambient-occlusion.js';
import { treeRenderRecipe } from './tree-instances.js';
import { addOrientedBox, addOutwardFace } from './facade.js';
import { glowRandom, markGlow } from './glow.js';

/**
 * Модель «из конструктора»: части из простых фигур, отдельно — тела столкновений.
 * Подходит для памятников и других штучных объектов.
 * Координаты локальные: X — восток, Y — вверх, Z — юг; `yaw` — поворот вокруг Y в градусах.
 */
type Triple = [number, number, number];
type Cone = {
  /** Центр основания. */
  center: Triple;
  radiusBottom: number;
  radiusTop: number;
  height: number;
  sides?: number;
};
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
    }
  /** Вертикальный усечённый конус: холм, куст, постамент. */
  | { cone: Cone }
  /** Compact faceted planting; it has no implicit collider. */
  | { foliage: { center: Triple; radius: number; height: number } }
  /**
   * Клин: коробка `size` с основанием в `center`, верх которой понижается
   * от полной высоты на −X до `low` на +X. Подходит для пандусов.
   */
  | { wedge: { center: Triple; size: Triple; low: number; yaw?: number } };
export type KitCollider =
  { id: string; center: Triple; size: Triple; yaw?: number } | { id: string; cone: Cone };
export interface KitRecipe {
  formatVersion: 1;
  /** Preserve the two authored crown envelopes while rendering a clustered broadleaf crown. */
  foliage?: 'broadleaf';
  parts: {
    id: string;
    role: 'wall' | 'roof' | 'detail';
    /** Становится ли часть прозрачной, закрывая персонажа. */
    fade: boolean;
    color: string;
    /** Ночное свечение части, например плафона фонаря (`lamp`) или вывески (`sign`). */
    glow?: GlowKind;
    shapes: KitShape[];
  }[];
  colliders: KitCollider[];
  /**
   * Объединить части в два меша — исчезающий и постоянный — с цветами вершин.
   * Резко сокращает вызовы отрисовки для сгенерированных квадратов с мелкими объектами.
   */
  merge?: boolean;
  /**
   * Источники ночного света в локальных осях модели: клиент рисует под ними пятно света.
   * `position` — [x, y, z] светящегося плафона, `radius` — дальность в метрах.
   */
  lights?: { position: Triple; radius: number; color: string }[];
}

const finite = (values: unknown, count: number) =>
  Array.isArray(values) &&
  values.length === count &&
  values.every((n) => Number.isFinite(n) && Math.abs(n) <= 10_000);
const axisOf = (yaw = 0): [number, number] => {
  const a = (yaw * Math.PI) / 180;
  return [Math.cos(a), -Math.sin(a)];
};
const checkSides = (sides: number) => {
  if (!Number.isInteger(sides) || sides < 3 || sides > 64) throw new Error('Invalid kit sides');
  return sides;
};

function addCylinder(
  part: StaticMeshPart,
  shape: Extract<KitShape, { cylinder: unknown }>['cylinder'],
) {
  const sides = checkSides(shape.sides ?? 12);
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

/** Выпуклое тело усечённого конуса; одна функция строит и вид, и столкновение. */
function addCone(part: StaticMeshPart, cone: Cone) {
  if (
    !finite(cone.center, 3) ||
    !(cone.radiusBottom > 0) ||
    !(cone.radiusTop >= 0) ||
    !(cone.height > 0)
  )
    throw new Error('Invalid kit cone');
  const sides = checkSides(cone.sides ?? 16);
  const [cx, cy, cz] = cone.center;
  const ring = (radius: number, y: number) =>
    Array.from({ length: sides }, (_, k) => {
      const angle = (k / sides) * Math.PI * 2;
      return [cx + Math.cos(angle) * radius, y, cz + Math.sin(angle) * radius];
    });
  const bottom = ring(cone.radiusBottom, cy),
    top = ring(Math.max(cone.radiusTop, 0.001), cy + cone.height);
  const center = [cx, cy + cone.height / 3, cz];
  for (let k = 0; k < sides; k++) {
    const j = (k + 1) % sides;
    addOutwardFace(part, [bottom[k], bottom[j], top[j], top[k]], center);
  }
  addOutwardFace(part, bottom, center);
  addOutwardFace(part, top, center);
}

function addWedge(part: StaticMeshPart, wedge: Extract<KitShape, { wedge: unknown }>['wedge']) {
  if (
    !finite(wedge.center, 3) ||
    !finite(wedge.size, 3) ||
    !(wedge.low > 0 && wedge.low < wedge.size[1])
  )
    throw new Error('Invalid kit wedge');
  const [cx, cy, cz] = wedge.center;
  const [length, high, width] = wedge.size;
  const u = axisOf(wedge.yaw),
    v = [-u[1], u[0]];
  const point = (a: number, b: number, y: number) => [
    cx + u[0] * a + v[0] * b,
    cy + y,
    cz + u[1] * a + v[1] * b,
  ];
  const [l, w] = [length / 2, width / 2];
  const base = [point(-l, -w, 0), point(l, -w, 0), point(l, w, 0), point(-l, w, 0)];
  const lid = [
    point(-l, -w, high),
    point(l, -w, wedge.low),
    point(l, w, wedge.low),
    point(-l, w, high),
  ];
  const center = [cx, cy + (high + wedge.low) / 4, cz];
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    addOutwardFace(part, [base[k], base[j], lid[j], lid[k]], center);
  }
  addOutwardFace(part, base, center);
  addOutwardFace(part, lid, center);
}

export function generateKit(
  assetId: string,
  recipe: KitRecipe,
): { parts: StaticMeshPart[]; physics: BuildingPhysicsAsset; lights?: StaticLightSource[] } {
  if (recipe.formatVersion !== 1) throw new Error('Unsupported kit recipe version');
  if (recipe.foliage !== undefined && recipe.foliage !== 'broadleaf')
    throw new Error('Unsupported kit foliage profile');
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
    if (recipe.foliage === 'broadleaf' && spec.id.startsWith('crown-')) {
      const cones = spec.shapes.map((shape) => ('cone' in shape ? shape.cone : undefined));
      if (cones.length !== 2 || cones.some((cone) => !cone))
        throw new Error('Broadleaf crown needs two authored cones');
      const [lower, upper] = cones as [Cone, Cone];
      for (const cone of [lower, upper])
        if (
          !finite(cone.center, 3) ||
          cone.center[0] !== 0 ||
          cone.center[2] !== 0 ||
          !Number.isFinite(cone.radiusBottom) ||
          !Number.isFinite(cone.radiusTop) ||
          !Number.isFinite(cone.height) ||
          !(cone.radiusBottom > 0) ||
          !(cone.radiusTop >= 0) ||
          !(cone.height > 0)
        )
          throw new Error('Invalid broadleaf crown envelope');
      if (!(upper.center[1] + upper.height > lower.center[1]))
        throw new Error('Invalid broadleaf crown height');
      const data = foliageGeometry(
        'broadleaf',
        Math.max(lower.radiusBottom, lower.radiusTop, upper.radiusBottom, upper.radiusTop),
        upper.center[1] + upper.height - lower.center[1],
        lower.center[1],
      );
      part.positions.push(...data.positions);
      part.normals.push(...data.normals);
      part.indices.push(...data.indices);
      part.colors = foliageOcclusion('broadleaf').flatMap((factor) => [factor, factor, factor]);
      return part;
    }
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
      } else if ('foliage' in shape) {
        const f = shape.foliage;
        if (
          !finite(f.center, 3) ||
          !Number.isFinite(f.radius) ||
          !Number.isFinite(f.height) ||
          !(f.radius > 0) ||
          !(f.height > 0)
        )
          throw new Error(`Invalid kit foliage in ${spec.id}`);
        const data = foliageGeometry(
          'shrub',
          f.radius,
          f.height,
          f.center[1],
          f.center[0],
          f.center[2],
        );
        const offset = part.positions.length / 3;
        part.colors ??= [];
        while (part.colors.length < part.positions.length) part.colors.push(1);
        part.positions.push(...data.positions);
        part.normals.push(...data.normals);
        part.indices.push(...data.indices.map((index) => index + offset));
        for (const factor of foliageOcclusion('shrub')) part.colors.push(factor, factor, factor);
      } else if ('cone' in shape) addCone(part, shape.cone);
      else if ('wedge' in shape) addWedge(part, shape.wedge);
      else throw new Error(`Unknown kit shape in ${spec.id}`);
      if (part.colors) while (part.colors.length < part.positions.length) part.colors.push(1);
    }
    if (spec.glow !== undefined) {
      if (!Object.hasOwn(GLOW_KIND, spec.glow)) throw new Error(`Invalid kit glow ${spec.id}`);
      markGlow(part, 0, spec.glow, glowRandom(`${assetId}:${spec.id}`)());
    }
    return part;
  });
  const colliders: StaticCollider[] = recipe.colliders.map((spec) => {
    const common = {
      id: spec.id,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      friction: 0.6,
      restitution: 0.05,
    };
    if ('cone' in spec) {
      // Холм — замкнутая треугольная форма: по пологому склону можно подняться.
      const shell = meshPart('collider', 'detail', '#000000');
      addCone(shell, spec.cone);
      return { ...common, kind: 'mesh', vertices: shell.positions, indices: shell.indices };
    }
    if (!finite(spec.center, 3) || !finite(spec.size, 3))
      throw new Error(`Invalid kit collider ${spec.id}`);
    const a = ((spec.yaw ?? 0) * Math.PI) / 360;
    return {
      ...common,
      kind: 'box',
      position: { x: spec.center[0], y: spec.center[1], z: spec.center[2] },
      rotation: { x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) },
      size: { x: spec.size[0], y: spec.size[1], z: spec.size[2] },
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
  // Trees share a versioned AO profile with the instanced runtime template.
  // Planting parts already carry their profile; bake only the remaining solid
  // parts of mixed assets (e.g. the monument) and preserve independent fade groups.
  if (!recipe.foliage && !treeRenderRecipe(assetId, recipe))
    bakeLocalAo(
      parts.filter((_, i) => !recipe.parts[i].shapes.some((shape) => 'foliage' in shape)),
    );
  const lights = recipe.lights?.map((light) => {
    if (
      !finite(light.position, 3) ||
      !(light.radius > 0 && light.radius <= 40) ||
      !/^#[a-f0-9]{6}$/i.test(light.color)
    )
      throw new Error(`Invalid kit light in ${assetId}`);
    const [x, y, z] = light.position;
    return { position: { x, y, z }, radius: light.radius, color: light.color };
  });
  return {
    parts: recipe.merge ? mergeParts(parts) : parts,
    physics: { assetId, bounds: { min, max }, colliders },
    ...(lights?.length ? { lights } : {}),
  };
}
