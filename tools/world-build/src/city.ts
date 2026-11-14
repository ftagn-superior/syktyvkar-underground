import type {
  Bounds,
  BuildingPhysicsAsset,
  StaticCollider,
  StaticLightSource,
  Vec3,
} from '@su/contracts';
import type { StaticMeshPart } from './glb.js';
import { addBox, addFace, meshPart } from './house.js';
import { triangulate, type Point2 } from './triangulate.js';
import {
  addOrientedBox,
  buildFacade,
  edgesOf,
  shopfrontEdges,
  type FacadeDetails,
} from './facade.js';
import {
  addFrame,
  addReveals,
  DEFAULT_RECESS,
  markSurface,
  onEdge,
  quadWithHoles,
  validateLayout,
  windowHoles,
  windowPitch,
  type WindowLayout,
} from './windows.js';
import { SURFACE_KIND, type SurfaceKind } from '@su/contracts';
import { mergeParts } from './merge.js';
import { bakeLocalAo } from './ambient-occlusion.js';
import { glowRandom, markGlow } from './glow.js';

/**
 * Генераторы городских моделей по контурам: здание-призма и поверхность земли.
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
  if (Math.abs(normalY) > 1e-10) addFace(part, normalY * up >= 0 ? [a, b, c] : [a, c, b]);
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
  /** Раскладка, размер, глубина проёма и переплёт окон; см. windows.ts. */
  windowLayout?: WindowLayout;
  /** Материал стен: процедурный рисунок шейдера клиента (кирпич, доска, панели…). */
  wallMaterial?: SurfaceKind;
  /** Высота низа стен, например у перехода над аркой. Этажи считаются от неё. */
  elevation?: number;
  /**
   * Корпуса сложного здания: каждый — своя призма с собственными цветами, этажностью
   * и деталями. Незаданные поля берутся из рецепта; общий `outline` тогда не строится.
   */
  sections?: FootprintSection[];
  /**
   * Вертикальное растяжение стен: высота, низ корпуса и роспись умножаются на него.
   * Окна, витрины, крыльцо, вывески и цоколь остаются в человеческом масштабе.
   */
  heightScale?: number;
  /** Точки входов [x, z] у стен: дверь с козырьком на ближайшем фасаде. */
  doors?: Point2[];
  /** Слить части в один меш на группу прозрачности (цвета — в вершинах). */
  merge?: boolean;
  /**
   * Как окна светятся ночью: `window` (по умолчанию) — жилой дом, `office` — школа, вуз,
   * учреждение: вечером горят, к ночи гаснут почти все; `none` — окна не светятся.
   */
  windowGlow?: 'window' | 'office' | 'none';
}

/** Двери с козырьками у ближайших к точкам входов рёбер контура. */
function addDoors(ring: Point2[], base: number, points: Point2[]): StaticMeshPart[] {
  const doors = meshPart('doors', 'detail', '#4b3d33');
  const canopies = meshPart('door-canopies', 'detail', '#8c9196');
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))
      throw new Error('Invalid footprint door');
    let best: { s: number; distance: number; p: Point2; d: Point2; length: number } | undefined;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i],
        q = ring[(i + 1) % ring.length];
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (length < 2) continue;
      const d: Point2 = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
      const s = Math.max(
        1,
        Math.min(length - 1, (point[0] - p[0]) * d[0] + (point[1] - p[1]) * d[1]),
      );
      const distance = Math.hypot(p[0] + d[0] * s - point[0], p[1] + d[1] * s - point[1]);
      if (!best || distance < best.distance) best = { s, distance, p, d, length };
    }
    if (!best) continue;
    const { s, p, d } = best;
    // Внешняя нормаль ребра контура с положительной площадью: up × d = (d.z, −d.x).
    const at = (offset: number, y: number, out: number) => [
      p[0] + d[0] * (s + offset) + d[1] * out,
      y,
      p[1] + d[1] * (s + offset) - d[0] * out,
    ];
    addFace(doors, [
      at(-0.65, base, 0.035),
      at(-0.65, base + 2.2, 0.035),
      at(0.65, base + 2.2, 0.035),
      at(0.65, base, 0.035),
    ]);
    addOrientedBox(canopies, at(0, base + 2.55, 0.55), [1.9, 0.12, 1.1], d);
  }
  return doors.indices.length ? [doors, canopies] : [];
}
export type FootprintSection = Partial<Omit<FootprintRecipe, 'formatVersion' | 'sections'>> & {
  id: string;
  outline: Point2[];
};

/** Здание по контуру: призма или несколько корпусов и замкнутые коллайдеры той же формы. */
const NO_AO = /(^|-)(windows|window-frames|window-reveals)$/;

export function generateFootprint(
  assetId: string,
  recipe: FootprintRecipe,
): { parts: StaticMeshPart[]; physics: BuildingPhysicsAsset; lights?: StaticLightSource[] } {
  const built = recipe.sections?.length
    ? generateSections(assetId, recipe)
    : generatePrism(assetId, recipe);
  // Стёкла, переплёты и откосы окон не запекаются: их сотни, откосы затенены заранее.
  bakeLocalAo(built.parts.filter((part) => !NO_AO.test(part.partId)));
  // Слияние частей с цветами вершин: один меш на группу прозрачности вместо десятка.
  return {
    parts: recipe.merge ? mergeParts(built.parts) : built.parts,
    physics: built.physics,
    ...(built.lights.length ? { lights: built.lights } : {}),
  };
}

function generateSections(
  assetId: string,
  recipe: FootprintRecipe,
): { parts: StaticMeshPart[]; physics: BuildingPhysicsAsset; lights: StaticLightSource[] } {
  const parts: StaticMeshPart[] = [];
  const lights: StaticLightSource[] = [];
  const colliders: StaticCollider[] = [];
  const ids = new Set<string>();
  for (const section of recipe.sections ?? []) {
    if (!/^[a-z0-9-]{1,24}$/.test(section.id) || ids.has(section.id))
      throw new Error(`Invalid footprint section ${section.id}`);
    ids.add(section.id);
    const { id, ...fields } = section;
    const built = generatePrism(assetId, { ...recipe, sections: undefined, ...fields });
    for (const part of built.parts) parts.push({ ...part, partId: `${id}-${part.partId}` });
    lights.push(...built.lights);
    for (const collider of built.physics.colliders)
      colliders.push({ ...collider, id: `${id}-${collider.id}` });
  }
  return { parts, physics: { assetId, bounds: boundsOf(parts), colliders }, lights };
}

/** Применяет heightScale к размерам, которые растягиваются вместе со стенами. */
function stretched(recipe: FootprintRecipe): FootprintRecipe {
  const scale = recipe.heightScale ?? 1;
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 3)
    throw new Error('Invalid footprint heightScale');
  if (scale === 1) return recipe;
  const paint = recipe.details?.paint?.map((layer) => ({
    ...layer,
    bottom: layer.bottom * scale,
    top: layer.top * scale,
  }));
  return {
    ...recipe,
    heightScale: 1,
    height: recipe.height * scale,
    ...(recipe.elevation !== undefined ? { elevation: recipe.elevation * scale } : {}),
    ...(recipe.details ? { details: { ...recipe.details, ...(paint ? { paint } : {}) } } : {}),
  };
}

function generatePrism(
  assetId: string,
  source: FootprintRecipe,
): { parts: StaticMeshPart[]; physics: BuildingPhysicsAsset; lights: StaticLightSource[] } {
  if (source.formatVersion !== 1) throw new Error('Unsupported footprint recipe version');
  const recipe = stretched(source);
  const e = recipe.elevation ?? 0;
  if (!Number.isFinite(e) || e < 0 || e > recipe.height - 2)
    throw new Error('Invalid footprint elevation');
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
  const windowGlow = recipe.windowGlow ?? 'window';
  if (!['window', 'office', 'none'].includes(windowGlow))
    throw new Error('Invalid footprint windowGlow');
  // Порядок окон в контуре стабилен, поэтому случайные числа повторяются от сборки к сборке.
  const random = glowRandom(`${assetId}:${JSON.stringify(recipe.outline)}`);
  const layout = recipe.windowLayout;
  validateLayout(layout);
  if (recipe.wallMaterial !== undefined && !(recipe.wallMaterial in SURFACE_KIND))
    throw new Error(`Unknown footprint wallMaterial ${recipe.wallMaterial}`);
  const recess = layout?.recess ?? DEFAULT_RECESS;
  const storey = (h - e) / recipe.floors;
  // triangulate возвращает контур с положительной площадью в осях (x, z);
  // для такого обхода внешняя нормаль ребра p → q равна up × (q − p).
  const edges = edgesOf(ring);
  const shopEdges = shopfrontEdges(edges, recipe.details);
  const holes = edges.map((edge) =>
    recipe.windows
      ? windowHoles(
          edge.length,
          e,
          storey,
          recipe.floors,
          layout,
          (floor) => floor === 0 && shopEdges.has(edge.index),
        )
      : [],
  );
  const facade = buildFacade(ring, h, recipe.floors, recipe.details, e, {
    random,
    windows: windowGlow === 'none' ? undefined : windowGlow,
    holes: recess > 0 ? (edge) => holes[edge] : undefined,
  });
  const reveals = meshPart('window-reveals', 'wall', recipe.wallColor);
  const frames = layout?.frameColor
    ? meshPart('window-frames', 'detail', layout.frameColor)
    : undefined;
  const top = h + facade.parapet;
  for (let i = 0; i < n; i++) {
    const [px, pz] = ring[i],
      [qx, qz] = ring[(i + 1) % n];
    const edge = edges[i];
    const wallStart = walls.positions.length / 3;
    const revealStart = reveals.positions.length / 3;
    if (recess > 0 && holes[i].length)
      quadWithHoles(walls, edge, 0, edge.length, e, top, 0, holes[i]);
    else
      addFace(walls, [
        [px, e, pz],
        [px, top, pz],
        [qx, top, qz],
        [qx, e, qz],
      ]);
    // Внутренняя сторона парапета видна сверху, когда камера смотрит через крышу.
    if (top > h)
      addFace(walls, [
        [qx, h, qz],
        [qx, top, qz],
        [px, top, pz],
        [px, h, pz],
      ]);
    // Стекло в глубине проёма; без проёма — на 3 см перед стеной, как раньше.
    const glassOut = recess > 0 ? -recess : 0.03;
    for (const hole of holes[i]) {
      if (recess > 0) addReveals(reveals, edge, hole, recess);
      const start = windows.positions.length / 3;
      addFace(windows, [
        onEdge(edge, hole.s0, hole.y0, glassOut),
        onEdge(edge, hole.s0, hole.y1, glassOut),
        onEdge(edge, hole.s1, hole.y1, glassOut),
        onEdge(edge, hole.s1, hole.y0, glassOut),
      ]);
      const seed = random();
      if (windowGlow !== 'none') markGlow(windows, start, windowGlow, seed);
      if (frames) addFrame(frames, edge, hole, glassOut + 0.015);
    }
    if (recipe.wallMaterial) {
      const scale =
        recipe.wallMaterial === 'panel'
          ? { u: windowPitch(edge.length, layout), v: storey }
          : undefined;
      markSurface(walls, wallStart, recipe.wallMaterial, edge, e, scale);
      if (reveals.positions.length / 3 > revealStart)
        markSurface(reveals, revealStart, recipe.wallMaterial, edge, e, scale);
    }
  }
  const vertices: number[] = [];
  for (const [x, z] of ring) vertices.push(x, e, z);
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
    // Поднятый корпус виден снизу: потолок арки.
    if (e > 0)
      addHorizontal(
        walls,
        [ring[a][0], e, ring[a][1]],
        [ring[b][0], e, ring[b][1]],
        [ring[c][0], e, ring[c][1]],
        -1,
      );
  }
  const parts = [
    walls,
    roof,
    ...(windows.indices.length ? [windows] : []),
    ...(reveals.indices.length ? [reveals] : []),
    ...(frames?.indices.length ? [frames] : []),
    ...facade.parts,
    ...(recipe.doors?.length ? addDoors(ring, e, recipe.doors) : []),
  ];
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
  facade.boxes.forEach((box, index) => {
    // Ось u — локальная X коробки: поворот вокруг Y на угол atan2(−u.z, u.x).
    const half = Math.atan2(-box.u[1], box.u[0]) / 2;
    colliders.push({
      id: `detail-${index}`,
      kind: 'box',
      position: { x: box.center[0], y: box.center[1], z: box.center[2] },
      rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
      size: { x: box.size[0], y: box.size[1], z: box.size[2] },
      friction: fixed.friction,
      restitution: fixed.restitution,
    });
  });
  return {
    parts,
    physics: { assetId, bounds: boundsOf(parts), colliders },
    lights: facade.lights,
  };
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
  /** Слить плиту и слои в один меш с цветами вершин. */
  merge?: boolean;
}

/** Sutherland–Hodgman on triangles: triangulation already accounts for holes. */
export function clipGroundPolygon(points: Point2[], min: Point2, max: Point2): Point2[] {
  let polygon = points;
  for (const [axis, edge, direction] of [
    [0, min[0], 1],
    [0, max[0], -1],
    [1, min[1], 1],
    [1, max[1], -1],
  ]) {
    const output: Point2[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      const insideA = direction * (a[axis] - edge) >= 0;
      const insideB = direction * (b[axis] - edge) >= 0;
      if (insideA) output.push(a);
      if (insideA !== insideB) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        output.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    polygon = output;
  }
  return polygon;
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
        // Clip the triangulated surface, preserving holes and every layer at cell seams.
        const clipped = clipGroundPolygon([a, b, c], recipe.min, recipe.max);
        for (let i = 1; i + 1 < clipped.length; i++) {
          const point = ([x, z]: Point2) => [x, y, z];
          addHorizontal(part, point(clipped[0]), point(clipped[i]), point(clipped[i + 1]), 1);
        }
      }
    }
    if (part.indices.length) parts.push(part);
  }
  const collider: StaticCollider = { id: 'slab', kind: 'box', position: center, ...fixed, size };
  return {
    parts: recipe.merge ? mergeParts(parts) : parts,
    physics: { assetId, bounds: boundsOf(parts), colliders: [collider] },
  };
}
