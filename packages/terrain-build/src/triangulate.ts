/** Точка на плоскости земли: [x, z] в метрах. */
export type Point2 = readonly [number, number];

const cross = (a: Point2, b: Point2, c: Point2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const distance = (a: Point2, b: Point2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Удвоенная ориентированная площадь в математическом смысле осей (x, z). */
export function signedArea(ring: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/**
 * Убирает замыкающую точку, повторы и вершины на прямой (в пределах tolerance метров).
 * Контуры OSM и результаты отсечения прямоугольником часто содержат такие вершины.
 */
export function cleanRing(ring: readonly Point2[], tolerance = 1e-3): Point2[] {
  const out: Point2[] = [];
  for (const point of ring) {
    if (!out.length || distance(out[out.length - 1], point) > tolerance) out.push(point);
  }
  while (out.length > 1 && distance(out[0], out[out.length - 1]) <= tolerance) out.pop();
  let changed = true;
  while (changed && out.length >= 3) {
    changed = false;
    for (let i = 0; i < out.length && out.length >= 3; i++) {
      const a = out[(i - 1 + out.length) % out.length],
        b = out[i],
        c = out[(i + 1) % out.length];
      const base = distance(a, c);
      // Игла (a → b → a) или вершина на отрезке ac не добавляют площади.
      if (base <= tolerance || Math.abs(cross(a, b, c)) / base <= tolerance) {
        out.splice(i, 1);
        i--;
        changed = true;
      }
    }
  }
  return out.length >= 3 ? out : [];
}

/**
 * Точка внутри треугольника или на его границе. Допуск ~1 нм: вершина, лежащая на
 * диагонали из-за совпадения прямых контура, иначе может оказаться «чуть снаружи»
 * из-за округления — тогда диагональ проходит через вершину и крышка теряет замкнутость.
 */
function insideTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  const tolerance = (u: Point2, v: Point2) => -1e-9 * Math.max(1, distance(u, v));
  return (
    cross(a, b, p) >= tolerance(a, b) &&
    cross(b, c, p) >= tolerance(b, c) &&
    cross(c, a, p) >= tolerance(c, a)
  );
}

/** Соединяет отверстие с внешним контуром разрезом нулевой ширины (метод Эберли). */
function bridgeHole(list: number[], hole: number[], points: Point2[]): number[] {
  let start = 0;
  for (let i = 1; i < hole.length; i++) if (points[hole[i]][0] > points[hole[start]][0]) start = i;
  const m = points[hole[start]];
  let nearest = Infinity,
    candidate = -1;
  for (let i = 0; i < list.length; i++) {
    const j = (i + 1) % list.length;
    const a = points[list[i]],
      b = points[list[j]];
    if ((a[1] > m[1] && b[1] > m[1]) || (a[1] < m[1] && b[1] < m[1])) continue;
    const x =
      a[1] === b[1] ? Math.min(a[0], b[0]) : a[0] + ((m[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
    if (x < m[0] - 1e-9 || x >= nearest) continue;
    nearest = x;
    candidate = a[0] >= b[0] ? i : j;
  }
  if (candidate < 0) throw new Error('Hole is outside its polygon');
  const intersection: Point2 = [nearest, m[1]];
  const p = points[list[candidate]];
  // Если в треугольнике (M, I, P) есть вершины, выбираем ближайшую к лучу.
  let best = candidate,
    bestAngle = Infinity,
    bestDistance = Infinity;
  const [a, b, c] = cross(m, intersection, p) >= 0 ? [m, intersection, p] : [m, p, intersection];
  for (let i = 0; i < list.length; i++) {
    const v = points[list[i]];
    if (i === candidate || !insideTriangle(v, a, b, c) || distance(v, m) === 0) continue;
    const angle = Math.abs(Math.atan2(v[1] - m[1], v[0] - m[0]));
    const length = distance(v, m);
    if (angle < bestAngle || (angle === bestAngle && length < bestDistance)) {
      best = i;
      bestAngle = angle;
      bestDistance = length;
    }
  }
  return [
    ...list.slice(0, best + 1),
    ...hole.slice(start),
    ...hole.slice(0, start + 1),
    list[best],
    ...list.slice(best + 1),
  ];
}

export interface Triangulation {
  points: Point2[];
  /** Тройки индексов против часовой стрелки в осях (x, z). */
  triangles: number[];
  /** Сумма площадей треугольников относительно площади многоугольника. */
  coverage: number;
}

/**
 * Отсечение ушей для многоугольника с отверстиями. Входная ориентация не важна.
 * Этого достаточно для подготовки контуров зданий и поверхности земли при сборке мира.
 */
export function triangulate(
  outerRing: readonly Point2[],
  holeRings: readonly (readonly Point2[])[] = [],
  cleanTolerance = 1e-3,
): Triangulation {
  const outer = cleanRing(outerRing, cleanTolerance);
  if (outer.length < 3 || Math.abs(signedArea(outer)) < 1e-6)
    return { points: [], triangles: [], coverage: 1 };
  if (signedArea(outer) < 0) outer.reverse();
  const points: Point2[] = [...outer];
  let list = outer.map((_, index) => index);
  let expected = signedArea(outer);
  const holes = holeRings
    .map((ring) => cleanRing(ring, cleanTolerance))
    .filter((ring) => ring.length >= 3 && Math.abs(signedArea(ring)) >= 1e-6)
    .map((ring) => {
      if (signedArea(ring) > 0) ring.reverse();
      expected += signedArea(ring);
      const offset = points.length;
      points.push(...ring);
      return ring.map((_, index) => offset + index);
    })
    .sort(
      (a, b) => Math.max(...b.map((i) => points[i][0])) - Math.max(...a.map((i) => points[i][0])),
    );
  for (const hole of holes) list = bridgeHole(list, hole, points);

  const triangles: number[] = [];
  const remaining = [...list];
  const corner = (i: number) => {
    const n = remaining.length;
    return [remaining[(i - 1 + n) % n], remaining[i], remaining[(i + 1) % n]] as const;
  };
  const turnAt = (i: number) => {
    const [ia, ib, ic] = corner(i);
    return cross(points[ia], points[ib], points[ic]);
  };
  const isEar = (i: number) => {
    const [ia, ib, ic] = corner(i);
    const a = points[ia],
      b = points[ib],
      c = points[ic];
    if (cross(a, b, c) <= 1e-12) return false;
    for (const iv of remaining) {
      if (iv === ia || iv === ib || iv === ic) continue;
      const v = points[iv];
      // Совпадающие вершины появляются на разрезах к отверстиям.
      if (distance(v, a) === 0 || distance(v, b) === 0 || distance(v, c) === 0) continue;
      if (insideTriangle(v, a, b, c)) return false;
    }
    return true;
  };
  let index = 0,
    sinceClip = 0;
  while (remaining.length > 3) {
    if (index >= remaining.length) index = 0;
    if (Math.abs(turnAt(index)) <= 1e-12) {
      // Вырожденная вершина не добавляет площади: удаляем без треугольника.
      remaining.splice(index, 1);
      sinceClip = 0;
      continue;
    }
    if (isEar(index)) {
      triangles.push(...corner(index));
      remaining.splice(index, 1);
      index = Math.max(0, index - 1);
      sinceClip = 0;
      continue;
    }
    index++;
    if (++sinceClip < remaining.length) continue;
    // Полный круг без ушей: контур самопересекается. Отсекаем первую выпуклую вершину,
    // чтобы завершиться; потерю площади покажет coverage.
    const convex = remaining.findIndex((_, i) => turnAt(i) > 0);
    if (convex < 0) break;
    triangles.push(...corner(convex));
    remaining.splice(convex, 1);
    sinceClip = 0;
  }
  if (remaining.length === 3 && turnAt(1) > 0) triangles.push(...remaining);
  let area = 0;
  for (let i = 0; i < triangles.length; i += 3)
    area += cross(points[triangles[i]], points[triangles[i + 1]], points[triangles[i + 2]]) / 2;
  return { points, triangles, coverage: expected > 0 ? area / expected : 1 };
}

/** Отсечение многоугольника выпуклой прямоугольной областью (Сазерленд — Ходжмен). */
export function clipRing(ring: readonly Point2[], min: Point2, max: Point2): Point2[] {
  let output: Point2[] = [...ring];
  const edges: [axis: 0 | 1, value: number, keepGreater: boolean][] = [
    [0, min[0], true],
    [0, max[0], false],
    [1, min[1], true],
    [1, max[1], false],
  ];
  for (const [axis, value, keepGreater] of edges) {
    const input = output;
    output = [];
    if (!input.length) break;
    const inside = (p: Point2) => (keepGreater ? p[axis] >= value : p[axis] <= value);
    for (let i = 0; i < input.length; i++) {
      const current = input[i],
        previous = input[(i - 1 + input.length) % input.length];
      const intersect = (): Point2 => {
        const t = (value - previous[axis]) / (current[axis] - previous[axis]);
        const point: [number, number] = [
          previous[0] + (current[0] - previous[0]) * t,
          previous[1] + (current[1] - previous[1]) * t,
        ];
        point[axis] = value;
        return point;
      };
      if (inside(current)) {
        if (!inside(previous)) output.push(intersect());
        output.push(current);
      } else if (inside(previous)) output.push(intersect());
    }
  }
  return output;
}
