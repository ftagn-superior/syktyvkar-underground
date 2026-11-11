import type { Bounds, BuildingPhysicsAsset, StaticCollider, Vec3 } from '@su/contracts';
import type { StaticMeshPart } from './glb.js';
import { addBox, addFace, meshPart } from './house.js';
import { triangulate, type Point2 } from './triangulate.js';
import { buildFacade, type FacadeDetails } from './facade.js';

/**
 * Генераторы городских моделей по контурам: здание-призма, поверхность земли и дерево.
 * Все рецепты задаются в локальных метрах модели: X — восток, Z — юг, Y — вверх.
 */

const colorPattern = /^#[a-f0-9]{6}$/i;
const fixed = {
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  friction: 0.6,
  restitution: 0.05,
};

function requireColor(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !colorPattern.test(value)) throw new Error(`Invalid ${label}`);
}
function requirePoints(value: unknown, label: string): asserts value is Point2[] {
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    !value.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every((n) => Number.isFinite(n) && Math.abs(n) <= 100_000),
    )
  )
    throw new Error(`Invalid ${label}`);
}
function boundsOf(parts: StaticMeshPart[]): Bounds {
  const min = { x: Infinity, y: Infinity, z: Infinity },
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const part of parts)
    for (let i = 0; i < part.positions.length; i += 3)
      for (const [j, axis] of (['x', 'y', 'z'] as const).entries()) {
        min[axis] = Math.min(min[axis], part.positions[i + j]);
        max[axis] = Math.max(max[axis], part.positions[i + j]);
      }
  return { min, max };
}
/** Треугольник с заданным направлением нормали по Y: +1 — вверх, −1 — вниз. */
function addHorizontal(part: StaticMeshPart, a: number[], b: number[], c: number[], up: 1 | -1) {
  const normalY = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  addFace(part, normalY * up >= 0 ? [a, b, c] : [a, c, b]);
}
/** Грань, нормаль которой направлена от точки center. */
function addOutward(part: StaticMeshPart, points: number[][], center: number[]) {
  const [a, b, c] = points;
  const u = b.map((n, i) => n - a[i]),
    v = c.map((n, i) => n - a[i]);
  const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const away = a.map((n, i) => n - center[i]);
  addFace(
    part,
    normal.reduce((s, n, i) => s + n * away[i], 0) >= 0 ? points : [...points].reverse(),
  );
}

export interface FootprintRecipe {
  formatVersion: 1;
  /** Контур стен [x, z] без повтора первой точки. */
  outline: Point2[];
  height: number;
  floors: number;
  /** Ряды окон на фасадах; для гаражей и навесов отключаются. */
  windows: boolean;
  wallColor: string;
  roofColor: string;
  windowColor: string;
  /** Необязательные детали фасада и крыши; см. facade.ts. */
  details?: FacadeDetails;
}

/** Здание с плоской крышей: вертикальная призма по контуру и замкнутый коллайдер той же формы. */
export function generateFootprint(
  assetId: string,
  recipe: FootprintRecipe,
): { parts: StaticMeshPart[]; physics: BuildingPhysicsAsset } {
  if (recipe.formatVersion !== 1) throw new Error('Unsupported footprint recipe version');
  requirePoints(recipe.outline, 'footprint outline');
  if (!Number.isFinite(recipe.height) || recipe.height < 2 || recipe.height > 200)
    throw new Error('Invalid footprint height');
  if (!Number.isInteger(recipe.floors) || recipe.floors < 1 || recipe.floors > 60)
    throw new Error('Invalid footprint floors');
  for (const key of ['wallColor', 'roofColor', 'windowColor'] as const)
    requireColor(recipe[key], `footprint ${key}`);
  const shape = triangulate(recipe.outline);
  // Коллайдер обязан быть замкнутым: потеря площади означает самопересекающийся контур.
  if (shape.triangles.length === 0 || Math.abs(shape.coverage - 1) > 0.001)
    throw new Error(`Footprint outline cannot be triangulated: ${assetId}`);
  const ring = shape.points,
    n = ring.length,
    h = recipe.height;
  const walls = meshPart('walls', 'wall', recipe.wallColor);
  const roof = meshPart('roof', 'roof', recipe.roofColor);
  const windows = meshPart('windows', 'detail', recipe.windowColor);
  const facade = buildFacade(ring, h, recipe.floors, recipe.details);
  const top = h + facade.parapet;
  // triangulate возвращает контур с положительной площадью в осях (x, z);
  // для такого обхода внешняя нормаль ребра p → q равна up × (q − p).
  for (let i = 0; i < n; i++) {
    const [px, pz] = ring[i],
      [qx, qz] = ring[(i + 1) % n];
    addFace(walls, [
      [px, 0, pz],
      [px, top, pz],
      [qx, top, qz],
      [qx, 0, qz],
    ]);
    // Внутренняя сторона парапета видна сверху, когда камера смотрит через крышу.
    if (top > h)
      addFace(walls, [
        [qx, h, qz],
        [qx, top, qz],
        [px, top, pz],
        [px, h, pz],
      ]);
    const length = Math.hypot(qx - px, qz - pz);
    if (!recipe.windows || length < 3) continue;
    const dx = (qx - px) / length,
      dz = (qz - pz) / length;
    const ox = dz * 0.03,
      oz = -dx * 0.03;
    const storey = h / recipe.floors;
    const count = Math.floor((length - 1) / 2.8);
    const width = Math.min(1.3, storey * 0.5),
      height = Math.min(1.4, storey * 0.48);
    for (let floor = 0; floor < recipe.floors; floor++) {
      if (facade.skipWindow(i, floor)) continue;
      const bottom = floor * storey + storey * 0.32;
      for (let k = 0; k < count; k++) {
        const center = (length / count) * (k + 0.5);
        const s0 = center - width / 2,
          s1 = center + width / 2;
        const at = (s: number, y: number) => [px + dx * s + ox, y, pz + dz * s + oz];
        addFace(windows, [
          at(s0, bottom),
          at(s0, bottom + height),
          at(s1, bottom + height),
          at(s1, bottom),
        ]);
      }
    }
  }
  const vertices: number[] = [];
  for (const [x, z] of ring) vertices.push(x, 0, z);
  for (const [x, z] of ring) vertices.push(x, h, z);
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, n + i, n + j, i, n + j, j);
  }
  for (let t = 0; t < shape.triangles.length; t += 3) {
    const [a, b, c] = shape.triangles.slice(t, t + 3);
    addHorizontal(
      roof,
      [ring[a][0], h, ring[a][1]],
      [ring[b][0], h, ring[b][1]],
      [ring[c][0], h, ring[c][1]],
      1,
    );
    // Обход (a, b, c) положительный в осях (x, z), то есть его нормаль направлена вниз.
    indices.push(a, b, c, n + a, n + c, n + b);
  }
  const parts = [walls, roof, ...(windows.indices.length ? [windows] : []), ...facade.parts];
  const colliders: StaticCollider[] = [
    { id: 'body', kind: 'mesh', position: { x: 0, y: 0, z: 0 }, ...fixed, vertices, indices },
  ];
  if (facade.roofCollider)
    colliders.push({
      id: 'roof',
      kind: 'mesh',
      position: { x: 0, y: 0, z: 0 },
      ...fixed,
      ...facade.roofCollider,
    });
  return { parts, physics: { assetId, bounds: boundsOf(parts), colliders } };
}

export interface GroundLayer {
  id: string;
  color: string;
  /** Высота слоя над плоскостью столкновений; разные слои не должны совпадать по высоте. */
  elevation: number;
  /** Многоугольники: первый контур внешний, остальные — отверстия. */
  polygons: Point2[][][];
}
export interface GroundRecipe {
  formatVersion: 1;
  min: Point2;
  max: Point2;
  depth: number;
  color: string;
  layers: GroundLayer[];
}

/** Плита земли с плоскими слоями покрытия. Слои только визуальные; столкновение — одна плита. */
export function generateGround(
  assetId: string,
  recipe: GroundRecipe,
): { parts: StaticMeshPart[]; physics: BuildingPhysicsAsset } {
  if (recipe.formatVersion !== 1) throw new Error('Unsupported ground recipe version');
  requireColor(recipe.color, 'ground color');
  const [x0, z0] = recipe.min,
    [x1, z1] = recipe.max;
  if (!(x1 > x0 && z1 > z0) || !(recipe.depth > 0 && recipe.depth <= 10))
    throw new Error('Invalid ground extent');
  const center: Vec3 = { x: (x0 + x1) / 2, y: -recipe.depth / 2, z: (z0 + z1) / 2 };
  const size: Vec3 = { x: x1 - x0, y: recipe.depth, z: z1 - z0 };
  const base = meshPart('ground', 'detail', recipe.color);
  base.occlusionGroup = null;
  addBox(base, center, size);
  const parts = [base];
  const ids = new Set(['ground']);
  for (const layer of recipe.layers) {
    if (!/^[a-z0-9-]{1,40}$/.test(layer.id) || ids.has(layer.id))
      throw new Error(`Invalid ground layer ${layer.id}`);
    ids.add(layer.id);
    requireColor(layer.color, `ground layer ${layer.id} color`);
    if (!(layer.elevation > 0 && layer.elevation < 0.05))
      throw new Error(`Invalid ground layer ${layer.id} elevation`);
    const part = meshPart(layer.id, 'detail', layer.color);
    part.occlusionGroup = null;
    for (const [outer, ...holes] of layer.polygons) {
      requirePoints(outer, `ground layer ${layer.id} polygon`);
      for (const hole of holes) requirePoints(hole, `ground layer ${layer.id} hole`);
      const shape = triangulate(outer, holes);
      for (let t = 0; t < shape.triangles.length; t += 3) {
        const [a, b, c] = shape.triangles.slice(t, t + 3).map((i) => shape.points[i]);
        const y = layer.elevation;
        // Слой не выходит за плиту: это сохраняет общие границы модели и коллайдера.
        const clamp = ([x, z]: Point2) => [
          Math.min(x1, Math.max(x0, x)),
          y,
          Math.min(z1, Math.max(z0, z)),
        ];
        addHorizontal(part, clamp(a), clamp(b), clamp(c), 1);
      }
    }
    if (part.indices.length) parts.push(part);
  }
  const collider: StaticCollider = { id: 'slab', kind: 'box', position: center, ...fixed, size };
  return { parts, physics: { assetId, bounds: boundsOf(parts), colliders: [collider] } };
}

export interface TreeRecipe {
  formatVersion: 1;
  height: number;
  crownRadius: number;
  trunkColor: string;
  crownColor: string;
}

/** Низкополигональная ель: ствол и два конуса кроны. Столкновение — только ствол. */
export function generateTree(
  assetId: string,
  recipe: TreeRecipe,
): { parts: StaticMeshPart[]; physics: BuildingPhysicsAsset } {
  if (recipe.formatVersion !== 1) throw new Error('Unsupported tree recipe version');
  if (!(recipe.height >= 3 && recipe.height <= 40)) throw new Error('Invalid tree height');
  if (!(recipe.crownRadius >= 0.5 && recipe.crownRadius <= 10))
    throw new Error('Invalid tree crown radius');
  requireColor(recipe.trunkColor, 'tree trunkColor');
  requireColor(recipe.crownColor, 'tree crownColor');
  const h = recipe.height,
    r = recipe.crownRadius;
  const trunkHeight = Math.max(2.2, h * 0.3);
  const trunk = meshPart('trunk', 'detail', recipe.trunkColor);
  addBox(trunk, { x: 0, y: trunkHeight / 2, z: 0 }, { x: 0.34, y: trunkHeight, z: 0.34 });
  const crown = meshPart('crown', 'detail', recipe.crownColor);
  const cone = (bottom: number, top: number, radius: number, sides: number, phase: number) => {
    const ring = Array.from({ length: sides }, (_, k) => {
      const angle = phase + (k / sides) * Math.PI * 2;
      return [Math.cos(angle) * radius, bottom, Math.sin(angle) * radius];
    });
    const middle = [0, (bottom + top) / 2, 0];
    for (let k = 0; k < sides; k++)
      addOutward(crown, [ring[k], ring[(k + 1) % sides], [0, top, 0]], middle);
    for (let k = 1; k < sides - 1; k++) addOutward(crown, [ring[0], ring[k], ring[k + 1]], middle);
  };
  cone(trunkHeight * 0.75, h * 0.78, r, 7, 0);
  cone(h * 0.5, h, r * 0.68, 7, Math.PI / 7);
  const parts = [trunk, crown];
  const collider: StaticCollider = {
    id: 'trunk',
    kind: 'box',
    position: { x: 0, y: trunkHeight / 2, z: 0 },
    ...fixed,
    size: { x: 0.4, y: trunkHeight, z: 0.4 },
  };
  return { parts, physics: { assetId, bounds: boundsOf(parts), colliders: [collider] } };
}
