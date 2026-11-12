/**
 * Кольцевая развязка с единообразной разметкой.
 *
 * Разметка из OSM на кольце рвётся: у каждого примыкания она отступает от узла,
 * а число полос подбирается заново на каждом отрезке. Поэтому внутри кольца
 * разметка строится здесь: прерывистые окружности между полосами, «зубы дракона»
 * (знак «Уступи дорогу») поперёк въездов и треугольные островки безопасности
 * между въездом и выездом. Концы подъездных дорог не заходят на центральный остров.
 */
import type { Point2 } from './triangulate.js';

export interface RoundaboutArm {
  id: string;
  /** Любая точка на оси подъезда и единичное направление от кольца наружу. */
  at: Point2;
  direction: Point2;
  /** Полная ширина проезжей части подъезда. */
  width: number;
  /** Островок безопасности: ширина основания у кольца и длина вдоль оси. */
  island?: { base: number; length: number };
  /** Где рисовать «Уступи дорогу»: на правой половине (по умолчанию), на всей ширине или нигде. */
  entry?: 'half' | 'full' | 'none';
}

export interface RoundaboutConfig {
  center: Point2;
  /** Радиусы внутреннего и внешнего края проезжей части кольца. */
  inner: number;
  outer: number;
  lanes: number;
  arms: RoundaboutArm[];
}

const LINE = 0.15;
const ISLAND_GAP = 1;

const add = (a: Point2, b: Point2, k = 1): Point2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const polar = (c: Point2, r: number, angle: number): Point2 => [
  c[0] + Math.cos(angle) * r,
  c[1] + Math.sin(angle) * r,
];

export function validateRoundabout(config: RoundaboutConfig) {
  if (!(config.inner > 0 && config.outer > config.inner + 2))
    throw new Error('Roundabout radii must satisfy 0 < inner < outer');
  if (!Number.isInteger(config.lanes) || config.lanes < 1 || config.lanes > 6)
    throw new Error('Roundabout lanes must be an integer from 1 to 6');
  const ids = new Set<string>();
  for (const arm of config.arms) {
    if (ids.has(arm.id)) throw new Error(`Duplicate roundabout arm ${arm.id}`);
    ids.add(arm.id);
    if (Math.abs(Math.hypot(...arm.direction) - 1) > 1e-3)
      throw new Error(`Roundabout arm ${arm.id} direction must be a unit vector`);
    if (arm.island && arm.island.base >= arm.width)
      throw new Error(`Roundabout arm ${arm.id} island is wider than the road`);
  }
}

/** Точки дороги внутри центрального острова сдвигаются на его край: остров остаётся кругом. */
export function clampOutOfIsland(ring: Point2[], config: RoundaboutConfig): Point2[] {
  return ring.map((p) => {
    const d: Point2 = [p[0] - config.center[0], p[1] - config.center[1]];
    const r = Math.hypot(d[0], d[1]);
    if (r >= config.inner || r === 0) return p;
    return add(config.center, d, config.inner / r);
  });
}

/** Точка на линии подъезда со смещением `offset` от оси, лежащая на окружности радиуса `radius`. */
function onCircle(arm: RoundaboutArm, c: Point2, offset: number, radius: number): Point2 {
  const n: Point2 = [-arm.direction[1], arm.direction[0]];
  const base = add(arm.at, n, offset);
  const w: Point2 = [base[0] - c[0], base[1] - c[1]];
  // |w + t·u|² = R²: берётся дальний корень, то есть выход наружу.
  const b = w[0] * arm.direction[0] + w[1] * arm.direction[1];
  const disc = b * b - (w[0] * w[0] + w[1] * w[1] - radius * radius);
  if (disc < 0) throw new Error(`Roundabout arm ${arm.id} misses the ring`);
  return add(base, arm.direction, -b + Math.sqrt(disc));
}

/**
 * Треугольные островки между въездом и выездом: основание у кольца, вершина на оси подъезда.
 * `margin` расширяет островок во все стороны (для очистки разметки под ним).
 */
export function roundaboutIslands(config: RoundaboutConfig, margin = 0): Point2[][] {
  return config.arms.flatMap((arm) => {
    if (!arm.island) return [];
    const radius = config.outer + ISLAND_GAP - margin;
    const half = arm.island.base / 2 + margin;
    const mouth = onCircle(arm, config.center, 0, radius);
    const triangle: Point2[] = [
      onCircle(arm, config.center, -half, radius),
      add(mouth, arm.direction, arm.island.length + 2 * margin),
      onCircle(arm, config.center, half, radius),
    ];
    return [signed(triangle) < 0 ? triangle.reverse() : triangle];
  });
}

const signed = (ring: Point2[]) =>
  ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;

/** Разметка кольца: прерывистые линии между полосами и «зубы дракона» на въездах. */
export function roundaboutMarkings(config: RoundaboutConfig): Point2[][] {
  const out: Point2[][] = [];
  const { center: c, inner, outer, lanes } = config;
  const width = (outer - inner) / lanes;
  for (let k = 1; k < lanes; k++) {
    const r = inner + k * width;
    // Целое число штрихов по окружности, чтобы шаг 3 + 6 м не ломался на стыке.
    const count = Math.max(4, Math.round((2 * Math.PI * r) / 9));
    const step = (2 * Math.PI) / count,
      dash = 3 / r;
    for (let i = 0; i < count; i++) {
      const a0 = i * step,
        a1 = a0 + dash;
      out.push([
        polar(c, r - LINE / 2, a0),
        polar(c, r - LINE / 2, a1),
        polar(c, r + LINE / 2, a1),
        polar(c, r + LINE / 2, a0),
      ]);
    }
  }
  for (const arm of config.arms) {
    const entry = arm.entry ?? 'half';
    if (entry === 'none') continue;
    const half = arm.width / 2 - 0.4;
    // Справа по ходу въезжающего потока (движение к кольцу, правостороннее).
    const right = -1;
    const from = entry === 'full' ? -half : arm.island ? arm.island.base / 2 + 0.4 : 0.4;
    const n: Point2 = [-arm.direction[1], arm.direction[0]];
    for (let o = from + 0.3; o <= half - 0.3 + 1e-9; o += 1) {
      const offset = entry === 'full' ? o : o * right;
      const foot = onCircle(arm, c, offset, outer + 0.5);
      // Треугольник основанием к кольцу, вершиной навстречу подъезжающим машинам.
      out.push([add(foot, n, -0.3), add(foot, n, 0.3), add(foot, arm.direction, 0.7)]);
    }
  }
  return out.map((ring) => (signed(ring) < 0 ? ring.reverse() : ring));
}

function inside(p: Point2, ring: Point2[]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i],
      [xj, zj] = ring[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Разметка OSM, которую заменяет разметка кольца: на самом кольце и на островках. */
export function replacedByRoundabout(polygon: Point2[], config: RoundaboutConfig): boolean {
  const centroid: Point2 = [
    polygon.reduce((s, p) => s + p[0], 0) / polygon.length,
    polygon.reduce((s, p) => s + p[1], 0) / polygon.length,
  ];
  if (
    Math.hypot(centroid[0] - config.center[0], centroid[1] - config.center[1]) <
    config.outer + 0.5
  )
    return true;
  // Под островком с запасом 0,6 м не остаётся кусков линий.
  return roundaboutIslands(config, 0.6).some((island) => polygon.some((p) => inside(p, island)));
}
