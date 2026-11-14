/**
 * Полигоны основания из поля расстояний: буфер линий, объединение, отступ и обрезка
 * одним проходом без внешних библиотек.
 *
 * Поле хранит знаковое расстояние до границы (отрицательное внутри) в узлах сетки шага `h`.
 * Объединение — минимум, пересечение — максимум. Изолиния нуля строится направленными
 * marching squares: внешние контуры против часовой стрелки в осях (x, z), отверстия — по
 * часовой. Значения вне полосы `band` вокруг границ ограничены, поэтому точность нужна
 * и обеспечивается только вблизи изолинии.
 */
import { cleanRing, signedArea, triangulate, type Point2 } from '@su/terrain-build/triangulate';

export interface Tile {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Шаг сетки, должен делить размеры плитки. */
  h: number;
}

const segmentDistance = (
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
) => {
  const dx = bx - ax,
    dz = bz - az,
    length = dx * dx + dz * dz;
  let t = length ? ((px - ax) * dx + (pz - az) * dz) / length : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
};

/** Знаковое расстояние до прямоугольника, отрицательное внутри. */
export function rectDistance(x: number, z: number, min: Point2, max: Point2) {
  const dx = Math.max(min[0] - x, x - max[0]),
    dz = Math.max(min[1] - z, z - max[1]);
  return dx > 0 || dz > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) : Math.max(dx, dz);
}

export function pointInRings(x: number, z: number, rings: readonly (readonly Point2[])[]) {
  let inside = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i],
        [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  return inside;
}

/** Точное знаковое расстояние до многоугольника (чётно-нечётное правило по всем контурам). */
export function polygonDistance(x: number, z: number, rings: readonly (readonly Point2[])[]) {
  let best = Infinity;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
      best = Math.min(best, segmentDistance(x, z, ring[j][0], ring[j][1], ring[i][0], ring[i][1]));
  return pointInRings(x, z, rings) ? -best : best;
}

export class Field {
  readonly nx: number;
  readonly nz: number;
  readonly values: Float32Array;
  constructor(
    readonly tile: Tile,
    /** Полуширина полосы точных значений; дальше хранится ±band. */
    readonly band: number,
  ) {
    this.nx = Math.round((tile.x1 - tile.x0) / tile.h) + 1;
    this.nz = Math.round((tile.z1 - tile.z0) / tile.h) + 1;
    this.values = new Float32Array(this.nx * this.nz).fill(band);
  }
  private range(min: number, max: number, origin: number, count: number) {
    const h = this.tile.h;
    return [
      Math.max(0, Math.ceil((min - origin) / h)),
      Math.min(count - 1, Math.floor((max - origin) / h)),
    ] as const;
  }
  /** Объединение с отрезком толщины 2r (капсула). */
  capsule(a: Point2, b: Point2, r: number) {
    const { x0, z0, h } = this.tile,
      reach = r + this.band;
    const [i0, i1] = this.range(
      Math.min(a[0], b[0]) - reach,
      Math.max(a[0], b[0]) + reach,
      x0,
      this.nx,
    );
    const [j0, j1] = this.range(
      Math.min(a[1], b[1]) - reach,
      Math.max(a[1], b[1]) + reach,
      z0,
      this.nz,
    );
    for (let j = j0; j <= j1; j++) {
      const z = z0 + j * h,
        row = j * this.nx;
      for (let i = i0; i <= i1; i++) {
        const d = segmentDistance(x0 + i * h, z, a[0], a[1], b[0], b[1]) - r;
        if (d < this.values[row + i]) this.values[row + i] = d;
      }
    }
  }
  polyline(points: readonly Point2[], r: number) {
    for (let k = 1; k < points.length; k++) this.capsule(points[k - 1], points[k], r);
    if (points.length === 1) this.capsule(points[0], points[0], r);
  }
  /**
   * Объединение с многоугольником, расширенным на grow(x, z) ≤ maxGrow.
   * Внутренность — по чётно-нечётному правилу всех контуров.
   */
  polygon(
    rings: readonly (readonly Point2[])[],
    maxGrow = 0,
    grow?: (x: number, z: number) => number,
  ) {
    const { x0, z0, h } = this.tile,
      reach = maxGrow + this.band;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const ring of rings)
      for (const [x, z] of ring) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    const [i0, i1] = this.range(minX - reach, maxX + reach, x0, this.nx);
    const [j0, j1] = this.range(minZ - reach, maxZ + reach, z0, this.nz);
    if (i0 > i1 || j0 > j1) return;
    const w = i1 - i0 + 1,
      rows = j1 - j0 + 1;
    const distance = new Float32Array(w * rows).fill(reach);
    for (const ring of rings)
      for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
        const a = ring[m],
          b = ring[k];
        const [ei0, ei1] = this.range(
          Math.min(a[0], b[0]) - reach,
          Math.max(a[0], b[0]) + reach,
          x0,
          this.nx,
        );
        const [ej0, ej1] = this.range(
          Math.min(a[1], b[1]) - reach,
          Math.max(a[1], b[1]) + reach,
          z0,
          this.nz,
        );
        for (let j = Math.max(ej0, j0); j <= Math.min(ej1, j1); j++) {
          const z = z0 + j * h,
            row = (j - j0) * w;
          for (let i = Math.max(ei0, i0); i <= Math.min(ei1, i1); i++) {
            const d = segmentDistance(x0 + i * h, z, a[0], a[1], b[0], b[1]);
            if (d < distance[row + i - i0]) distance[row + i - i0] = d;
          }
        }
      }
    const crossings: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const z = z0 + j * h;
      crossings.length = 0;
      for (const ring of rings)
        for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
          const [xa, za] = ring[m],
            [xb, zb] = ring[k];
          if (za > z !== zb > z) crossings.push(xa + ((z - za) * (xb - xa)) / (zb - za));
        }
      crossings.sort((a, b) => a - b);
      let c = 0,
        inside = false;
      const row = j * this.nx,
        local = (j - j0) * w;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * h;
        while (c < crossings.length && crossings[c] < x) {
          inside = !inside;
          c++;
        }
        const d =
          (inside ? -distance[local + i - i0] : distance[local + i - i0]) - (grow ? grow(x, z) : 0);
        if (d < this.values[row + i]) this.values[row + i] = d;
      }
    }
  }
  /** Пересечение с областью constraint(x, z) ≤ 0. */
  intersect(constraint: (x: number, z: number) => number) {
    const { x0, z0, h } = this.tile;
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const k = j * this.nx + i,
          c = constraint(x0 + i * h, z0 + j * h);
        if (c > this.values[k]) this.values[k] = c;
      }
  }
  /** Направленные контуры изолинии нуля. Узлы на краю плитки считаются внешними. */
  contours(): Point2[][] {
    const { nx, nz, values } = this;
    const { x0, z0, h } = this.tile;
    const value = (i: number, j: number) =>
      i === 0 || j === 0 || i === nx - 1 || j === nz - 1
        ? Math.max(0, values[j * nx + i])
        : values[j * nx + i];
    const inside = (v: number) => v < 0;
    const horizontal = nz * (nx - 1);
    // Ребро p0→p1 нижнее (i..i+1, j), p1→p2 правое (i+1, j..j+1), p2→p3 верхнее, p3→p0 левое.
    const edgeId = (i: number, j: number, e: number) =>
      e === 0
        ? j * (nx - 1) + i
        : e === 2
          ? (j + 1) * (nx - 1) + i
          : horizontal + j * nx + (e === 1 ? i + 1 : i);
    const points = new Map<number, Point2>();
    const point = (i: number, j: number, e: number, v: number[]): number => {
      const id = edgeId(i, j, e);
      if (!points.has(id)) {
        // Каноническое направление ребра: по возрастанию i или j.
        if (e === 0 || e === 2) {
          const jj = e === 0 ? j : j + 1;
          const a = e === 0 ? v[0] : v[3],
            b = e === 0 ? v[1] : v[2];
          const t = a / (a - b);
          points.set(id, [x0 + (i + t) * h, z0 + jj * h]);
        } else {
          const ii = e === 1 ? i + 1 : i;
          const a = e === 1 ? v[1] : v[0],
            b = e === 1 ? v[2] : v[3];
          const t = a / (a - b);
          points.set(id, [x0 + ii * h, z0 + (j + t) * h]);
        }
      }
      return id;
    };
    const next = new Map<number, number>();
    const v = [0, 0, 0, 0];
    for (let j = 0; j < nz - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        v[0] = value(i, j);
        v[1] = value(i + 1, j);
        v[2] = value(i + 1, j + 1);
        v[3] = value(i, j + 1);
        const s = [inside(v[0]), inside(v[1]), inside(v[2]), inside(v[3])];
        if (s[0] === s[1] && s[1] === s[2] && s[2] === s[3]) continue;
        const exits: number[] = [],
          entries: number[] = [];
        const order: { e: number; exit: boolean }[] = [];
        for (let e = 0; e < 4; e++) if (s[e] !== s[(e + 1) % 4]) order.push({ e, exit: s[e] });
        if (order.length === 2) {
          const exit = order.find((o) => o.exit)!,
            entry = order.find((o) => !o.exit)!;
          exits.push(exit.e);
          entries.push(entry.e);
        } else {
          // Седло: центр внутри — внутренние углы связаны.
          const centre = (v[0] + v[1] + v[2] + v[3]) / 4 < 0;
          for (let k = 0; k < 4; k++)
            if (order[k].exit) {
              exits.push(order[k].e);
              entries.push(order[centre ? (k + 1) % 4 : (k + 3) % 4].e);
            }
        }
        for (let k = 0; k < exits.length; k++)
          next.set(point(i, j, exits[k], v), point(i, j, entries[k], v));
      }
    const rings: Point2[][] = [];
    const used = new Set<number>();
    for (const start of next.keys()) {
      if (used.has(start)) continue;
      const ring: Point2[] = [];
      let id: number | undefined = start;
      while (id !== undefined && !used.has(id)) {
        used.add(id);
        ring.push(points.get(id)!);
        id = next.get(id);
      }
      if (id === start && ring.length >= 3) rings.push(ring);
    }
    return rings;
  }
}

function simplifyClosed(ring: Point2[], tolerance: number): Point2[] {
  if (tolerance <= 0 || ring.length < 8) return ring;
  // Опорные точки: самая левая и самая удалённая от неё.
  let a = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i][0] < ring[a][0]) a = i;
  let b = a,
    far = -1;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[a][0], ring[i][1] - ring[a][1]);
    if (d > far) {
      far = d;
      b = i;
    }
  }
  const keep = new Uint8Array(ring.length);
  keep[a] = keep[b] = 1;
  const stack: [number, number][] = [
    [a, b],
    [b, a],
  ];
  const n = ring.length;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const span = (e - s + n) % n;
    if (span < 2) continue;
    let index = -1,
      worst = tolerance;
    for (let k = 1; k < span; k++) {
      const i = (s + k) % n;
      const d = segmentDistance(
        ring[i][0],
        ring[i][1],
        ring[s][0],
        ring[s][1],
        ring[e][0],
        ring[e][1],
      );
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index >= 0) {
      keep[index] = 1;
      stack.push([s, index], [index, e]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

const cross = (a: Point2, b: Point2, c: Point2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const crosses = (a: Point2, b: Point2, c: Point2, d: Point2) =>
  cross(a, b, c) * cross(a, b, d) < -1e-16 && cross(c, d, a) * cross(c, d, b) < -1e-16;

/** Нет строгих пересечений рёбер внутри многоугольника (то же правило, что при сборке основания). */
export function polygonIsSimple(rings: readonly Point2[][]) {
  const edges: [Point2, Point2, number, number][] = [];
  for (const [r, ring] of rings.entries())
    for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length], r, i]);
  const cell = 4;
  const buckets = new Map<string, number[]>();
  for (const [k, [a, b]] of edges.entries())
    for (
      let gx = Math.floor(Math.min(a[0], b[0]) / cell);
      gx <= Math.floor(Math.max(a[0], b[0]) / cell);
      gx++
    )
      for (
        let gz = Math.floor(Math.min(a[1], b[1]) / cell);
        gz <= Math.floor(Math.max(a[1], b[1]) / cell);
        gz++
      ) {
        const key = `${gx},${gz}`;
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        list.push(k);
      }
  for (const list of buckets.values())
    for (let p = 0; p < list.length; p++)
      for (let q = p + 1; q < list.length; q++) {
        const [a, b] = edges[list[p]],
          [c, d] = edges[list[q]];
        if (crosses(a, b, c, d)) return false;
      }
  return true;
}

const round = (ring: Point2[]): Point2[] =>
  ring.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100] as Point2);

function polygonValid(rings: Point2[][]) {
  if (rings.some((ring) => ring.length < 3 || Math.abs(signedArea(ring)) < 1e-6)) return false;
  if (!polygonIsSimple(rings)) return false;
  try {
    const shape = triangulate(rings[0], rings.slice(1));
    return shape.triangles.length > 0 && Math.abs(shape.coverage - 1) <= 1e-6;
  } catch {
    return false;
  }
}

export interface ContourOptions {
  /** Допуск упрощения, м. */
  tolerance: number;
  /** Отбросить контуры меньше этой площади, м². */
  minArea: number;
}

/**
 * Многоугольники `[outer, ...holes]` из контуров поля с округлением до сантиметра.
 * Упрощение уменьшается до нуля, если нарушает топологию; невалидные остатки отбрасываются.
 */
export function fieldPolygons(field: Field, options: ContourOptions) {
  const raw = field.contours();
  const outers: { ring: Point2[]; area: number; holes: Point2[][] }[] = [];
  const holes: Point2[][] = [];
  for (const ring of raw) {
    const area = signedArea(ring);
    if (Math.abs(area) < options.minArea) continue;
    if (area > 0) outers.push({ ring, area, holes: [] });
    else holes.push(ring);
  }
  outers.sort((a, b) => a.area - b.area);
  for (const hole of holes) {
    const owner = outers.find((o) => pointInRings(hole[0][0], hole[0][1], [o.ring]));
    owner?.holes.push(hole);
  }
  const result: Point2[][][] = [];
  let dropped = 0;
  for (const { ring, holes: own } of outers) {
    let done = false;
    for (const tolerance of [options.tolerance, options.tolerance / 4, 0]) {
      const [outer, ...inner] = [ring, ...own].map((r) =>
        cleanRing(round(simplifyClosed(r, tolerance)), 1e-3),
      );
      const rings = [
        outer,
        ...inner.filter((r) => r.length >= 3 && Math.abs(signedArea(r)) >= options.minArea),
      ];
      if (polygonValid(rings)) {
        result.push(rings);
        done = true;
        break;
      }
    }
    if (!done) dropped++;
  }
  return { polygons: result, dropped };
}
