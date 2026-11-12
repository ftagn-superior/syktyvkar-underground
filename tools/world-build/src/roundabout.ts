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
  /**
   * Скругление между краем подъезда и внешним краем кольца: радиус дуги, касающейся обоих.
   * `right` — край справа, если смотреть от кольца наружу (в осях x, z — по нормали (−dz, dx)), `left` — слева.
   * Без поля край остаётся как в исходной дороге.
   */
  fillet?: { left?: number; right?: number };
  /**
   * Подъезд за обведённым сечением: сколько метров держать реальную ширину (`length`) и на скольких метрах
   * сужать её до прежней ширины дороги (`taper`). Без поля асфальт кончается ступенькой на конце обводки.
   */
  approach?: { length: number; taper: number };
  /** Где рисовать «Уступи дорогу»: на правой половине (по умолчанию), на всей ширине или нигде. */
  entry?: 'half' | 'full' | 'none';
}

export interface RoundaboutConfig {
  center: Point2;
  /** Радиусы внутреннего и внешнего края проезжей части кольца. */
  inner: number;
  outer: number;
  lanes: number;
  /** Радиусы прерывистых линий между полосами; без поля линии делят кольцо на `lanes` равных полос. */
  lines?: number[];
  arms: RoundaboutArm[];
  /** «Зебры», которых нет в OSM: отрезок поперёк проезжей части от `from` до `to` (игровые метры). */
  crosswalks?: { from: Point2; to: Point2 }[];
  /** Файл трассировки по снимку (`content/worlds/ring-block/ring-trace.json`): контуры, которых нет в OSM и прототипе. */
  trace?: string;
  /** Разобранная трассировка; заполняется при импорте из `trace`. */
  traced?: TracedGeometry;
}

/** Трассы по спутниковому снимку, пересчитанные в игровые метры. */
export interface TracedGeometry {
  /** Края проезжей части от дальнего конца одного подъезда до дальнего конца соседнего. */
  curbs: Point2[][];
  /** Островки: `arm` — начало id подъезда (`oktyabrsky-north`), чей островок заменяется контуром. */
  islands: { arm: string; ring: Point2[] }[];
  /** «Зебры»: две точки по ближнему к кольцу краю и по одной на дальнем (глубина полос). */
  crosswalks: Point2[][];
  /** Линии разметки на подъездах; ломаные идут от дальнего конца подъезда к кольцу. */
  lines: { style: 'dashed' | 'solid' | 'double'; points: Point2[] }[];
}

const LINE = 0.15;
const TWO_PI = 2 * Math.PI;
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
  if (config.lines?.some((r) => !(r > config.inner && r < config.outer)))
    throw new Error('Roundabout lane lines must lie between inner and outer radii');
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
    // Островок, обведённый по снимку, заменяет расчётный треугольник.
    const traced = config.traced?.islands.find((t) => armTowards(config, t.ring) === arm);
    if (traced) return [grow(traced.ring, margin)];
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

/**
 * Подъезд, в сторону которого лежит контур: по направлению от центра кольца к центру тяжести контура.
 * Так трассу не нужно подписывать названием подъезда правильно — важно лишь, где она нарисована.
 */
function armTowards(config: RoundaboutConfig, ring: Point2[]): RoundaboutArm | undefined {
  const centroid: Point2 = [
    ring.reduce((sum, p) => sum + p[0], 0) / ring.length - config.center[0],
    ring.reduce((sum, p) => sum + p[1], 0) / ring.length - config.center[1],
  ];
  const length = Math.hypot(...centroid) || 1;
  let best: RoundaboutArm | undefined;
  let bestDot = -Infinity;
  for (const arm of config.arms) {
    const dot = (centroid[0] * arm.direction[0] + centroid[1] * arm.direction[1]) / length;
    if (dot > bestDot) {
      bestDot = dot;
      best = arm;
    }
  }
  return best;
}

/** Контур, расширенный от центра тяжести на `margin` метров. */
function grow(ring: Point2[], margin: number): Point2[] {
  if (!margin) return ring;
  const c: Point2 = [
    ring.reduce((sum, p) => sum + p[0], 0) / ring.length,
    ring.reduce((sum, p) => sum + p[1], 0) / ring.length,
  ];
  return ring.map((p) =>
    add(p, [p[0] - c[0], p[1] - c[1]], margin / (Math.hypot(p[0] - c[0], p[1] - c[1]) || 1)),
  );
}

/**
 * Сглаживание срезанием углов (Chaikin). Незамкнутая ломаная сохраняет концы, замкнутая — нет.
 * Обводка кликами даёт ломаные с углами; реальные края дорог и линии разметки плавные.
 */
export function smoothTrace(points: Point2[], iterations = 2, closed = false): Point2[] {
  let pts = points;
  for (let step = 0; step < iterations; step++) {
    const n = pts.length;
    const out: Point2[] = closed ? [] : [pts[0]];
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      out.push(
        [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]],
        [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]],
      );
    }
    if (!closed) out.push(pts[n - 1]);
    pts = out;
  }
  return pts;
}

/**
 * Трассы по снимку → контуры в игровых метрах. Имя трассы — `подъезд:вид`.
 * Линии, края и островки при `smooth` сглаживаются: обводка кликами неровная.
 */
export function tracedGeometry(
  trace: { traces: { name: string; points: Point2[] }[] },
  { smooth = false }: { smooth?: boolean } = {},
): TracedGeometry {
  const out: TracedGeometry = { curbs: [], islands: [], crosswalks: [], lines: [] };
  const need = (name: string, points: Point2[], count: number) => {
    if (points.length < count) throw new Error(`Trace ${name} needs at least ${count} points`);
  };
  const STYLES = {
    'lane-dashed': 'dashed',
    'lane-line': 'dashed',
    'lane-solid': 'solid',
    'lane-double': 'double',
  } as const;
  for (const { name, points } of trace.traces) {
    const [arm, kind = ''] = name.split(':');
    if (kind.startsWith('edge-') && arm !== 'ring') {
      need(name, points, 2);
      out.curbs.push(smooth ? smoothTrace(points) : points);
    } else if (kind === 'island') {
      need(name, points, 3);
      // Если обводка замкнута повторной точкой, дубль убирается.
      const last = points[points.length - 1];
      const closedByRepeat = Math.hypot(points[0][0] - last[0], points[0][1] - last[1]) < 1;
      const open = closedByRepeat ? points.slice(0, -1) : points;
      const ring = smooth ? smoothTrace(open, 1, true) : open;
      out.islands.push({ arm, ring: signed(ring) < 0 ? [...ring].reverse() : ring });
    } else if (kind === 'crosswalk') {
      need(name, points, 3);
      out.crosswalks.push(points.slice(0, 3));
    } else if (kind in STYLES && arm !== 'ring') {
      need(name, points, 2);
      out.lines.push({
        style: STYLES[kind as keyof typeof STYLES],
        points: smooth ? smoothTrace(points) : points,
      });
    }
  }
  return out;
}

/** Ближайший подъезд к точке: ось не дальше 25 м и точка на внешней стороне от кольца. */
function nearestArm(config: RoundaboutConfig, end: Point2): RoundaboutArm | undefined {
  let best: { arm: RoundaboutArm; offset: number } | undefined;
  for (const arm of config.arms) {
    const rel: Point2 = [end[0] - arm.at[0], end[1] - arm.at[1]];
    const offset = Math.abs(rel[0] * arm.direction[1] - rel[1] * arm.direction[0]);
    // Подъезды лежат на одной прямой попарно: нужна ось, у которой точка на внешней стороне от кольца.
    const c = config.center;
    const outward = (end[0] - c[0]) * arm.direction[0] + (end[1] - c[1]) * arm.direction[1] > 0;
    if (outward && offset < 25 && (!best || offset < best.offset)) best = { arm, offset };
  }
  return best?.arm;
}

/**
 * Продолжение обведённого сечения подъезда: участок реальной ширины длиной `length`, затем сужение
 * на `taper` метрах до прежней ширины дороги подъезда. Асфальт только добавляется.
 */
export function roundaboutApproaches(config: RoundaboutConfig): Point2[][] {
  const out: Point2[][] = [];
  const ends = (config.traced?.curbs ?? []).flatMap((curb) => [curb[0], curb[curb.length - 1]]);
  for (const arm of config.arms) {
    if (!arm.approach) continue;
    const mine = ends.filter((p) => nearestArm(config, p) === arm);
    if (mine.length < 2) continue;
    const d = arm.direction;
    const n: Point2 = [-d[1], d[0]];
    const offset = (p: Point2) => (p[0] - arm.at[0]) * n[0] + (p[1] - arm.at[1]) * n[1];
    const sorted = [...mine].sort((p, q) => offset(p) - offset(q));
    const c1 = sorted[0];
    const c2 = sorted[sorted.length - 1];
    const { length, taper } = arm.approach;
    const far1 = add(c1, d, length);
    const far2 = add(c2, d, length);
    const mid: Point2 = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
    const t = (mid[0] - arm.at[0]) * d[0] + (mid[1] - arm.at[1]) * d[1];
    const axis = add(arm.at, d, t + length + taper);
    const shapes: Point2[][] = [];
    if (length > 0) shapes.push([c1, c2, far2, far1]);
    if (taper > 0)
      shapes.push([far1, far2, add(axis, n, arm.width / 2), add(axis, n, -arm.width / 2)]);
    for (const shape of shapes) out.push(signed(shape) < 0 ? shape.reverse() : shape);
  }
  return out;
}

/**
 * Асфальт между обведённым краем и центральным островом. Край идёт от одного подъезда к соседнему
 * мимо кольца. Участок замыкается по осям подъездов (до половины их ширины) и дугой по краю острова,
 * поэтому две соседние половины подъезда вместе дают всю дорогу. Участок добавляется к уже нарисованной
 * дороге, а островки рисуются поверх.
 */
export function roundaboutCurbPatches(config: RoundaboutConfig): Point2[][] {
  const c = config.center;
  const angle = (p: Point2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  // Замыкание от конца края: к оси ближайшего подъезда и по ней к краю острова; вдали от подъездов — по лучу.
  const closure = (end: Point2): Point2[] => {
    const arm = nearestArm(config, end);
    if (!arm) return [polar(c, config.inner, angle(end))];
    const t = (end[0] - arm.at[0]) * arm.direction[0] + (end[1] - arm.at[1]) * arm.direction[1];
    return [add(arm.at, arm.direction, t), onCircle(arm, c, 0, config.inner)];
  };
  return (config.traced?.curbs ?? []).map((curb) => {
    const start = closure(curb[0]);
    const finish = closure(curb[curb.length - 1]);
    const from = angle(finish[finish.length - 1]);
    const to = angle(start[start.length - 1]);
    let delta = to - from;
    delta -= Math.round(delta / TWO_PI) * TWO_PI;
    const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 36)));
    const arc = Array.from({ length: steps + 1 }, (_, i) =>
      polar(c, config.inner, from + (delta * i) / steps),
    );
    const patch = [...curb, ...finish, ...arc, ...[...start].reverse()];
    return signed(patch) < 0 ? patch.reverse() : patch;
  });
}

/**
 * Асфальт скруглений: между краем подъезда, дугой радиуса `fillet` и внешним краем кольца.
 * Дуга касается края подъезда и внешней окружности кольца, поэтому линия дороги течёт плавно,
 * а не уходит в кольцо угловым срезом. Всё лежит снаружи проезжей части и добавляет асфальт к уже нарисованному.
 */
export function roundaboutFillets(config: RoundaboutConfig): Point2[][] {
  const out: Point2[][] = [];
  const c = config.center;
  const R = config.outer;
  for (const arm of config.arms) {
    const n: Point2 = [-arm.direction[1], arm.direction[0]];
    for (const [side, radius] of [
      [1, arm.fillet?.right],
      [-1, arm.fillet?.left],
    ] as const) {
      if (!radius) continue;
      const half = side * (arm.width / 2);
      // Центр дуги: на расстоянии radius от края подъезда (снаружи) и R + radius от центра кольца.
      const w: Point2 = [
        arm.at[0] + n[0] * (half + side * radius) - c[0],
        arm.at[1] + n[1] * (half + side * radius) - c[1],
      ];
      const b = w[0] * arm.direction[0] + w[1] * arm.direction[1];
      const disc = b * b - (w[0] * w[0] + w[1] * w[1] - (R + radius) ** 2);
      if (disc < 0)
        throw new Error(`Roundabout arm ${arm.id} fillet ${radius} does not reach the ring`);
      const centre = add(add(c, w), arm.direction, -b + Math.sqrt(disc));
      // Точка касания на краю подъезда — ближайшая к центру дуги; на кольце — на луче от центра кольца.
      const foot = add(centre, n, -side * radius);
      const toCentre: Point2 = [centre[0] - c[0], centre[1] - c[1]];
      const onRing = add(c, toCentre, R / Math.hypot(...toCentre));
      const mouth = onCircle(arm, c, half, R);
      const arc = (from: Point2, to: Point2, middle: Point2, r: number) => {
        const a0 = Math.atan2(from[1] - middle[1], from[0] - middle[0]);
        let delta = Math.atan2(to[1] - middle[1], to[0] - middle[0]) - a0;
        delta -= Math.round(delta / (2 * Math.PI)) * 2 * Math.PI;
        const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 36)));
        return Array.from({ length: steps + 1 }, (_, i) =>
          polar(middle, r, a0 + (delta * i) / steps),
        );
      };
      const ring = [...arc(onRing, mouth, c, R)];
      const polygon = [...arc(foot, onRing, centre, radius), ...ring.slice(1), mouth];
      out.push(signed(polygon) < 0 ? polygon.reverse() : polygon);
    }
  }
  return out;
}

const signed = (ring: Point2[]) =>
  ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;

interface CrosswalkFrame {
  origin: Point2;
  across: Point2;
  along: Point2;
  length: number;
  depth: number;
}

/** Система координат «зебры» по трём точкам обводки: порядок точек и угол начала не важны. */
function crosswalkFrame([p0, p1, p2]: Point2[]): CrosswalkFrame {
  // Длинная сторона — поперёк дороги, короткая — глубина полос.
  const a: Point2 = [p1[0] - p0[0], p1[1] - p0[1]];
  const b: Point2 = [p2[0] - p1[0], p2[1] - p1[1]];
  const aLong = Math.hypot(...a) >= Math.hypot(...b);
  const origin = aLong ? p0 : p1;
  const acrossVec = aLong ? a : b;
  const depthVec: Point2 = aLong ? b : [-a[0], -a[1]];
  const length = Math.hypot(...acrossVec);
  if (length < 2) throw new Error('Roundabout crosswalk is shorter than 2 m');
  const across: Point2 = [acrossVec[0] / length, acrossVec[1] / length];
  let along: Point2 = [-across[1], across[0]];
  const side = depthVec[0] * along[0] + depthVec[1] * along[1];
  if (side < 0) along = [-along[0], -along[1]];
  return { origin, across, along, length, depth: Math.abs(side) };
}

/** «Зебра» поперёк дороги: полосы 0,5 × до 4,5 м вдоль движения с шагом 1,1 м. */
export function roundaboutCrosswalks(config: RoundaboutConfig): Point2[][] {
  const islands = config.arms.length ? roundaboutIslands(config) : [];
  const traced = (config.traced?.crosswalks ?? []).flatMap((quad) => {
    const { origin, across, along, length, depth: full } = crosswalkFrame(quad);
    const depth = Math.min(full, 4.5);
    const count = Math.max(2, Math.floor(length / 1.1));
    return Array.from({ length: count }, (_, k) =>
      add(add(origin, across, 0.25 + (k * (length - 0.5)) / (count - 1)), along, full / 2),
    )
      .filter((centre) => !islands.some((island) => inside(centre, island)))
      .map((centre) => {
        const a = add(centre, along, -depth / 2),
          b = add(centre, along, depth / 2);
        const ring = [
          add(a, across, -0.25),
          add(b, across, -0.25),
          add(b, across, 0.25),
          add(a, across, 0.25),
        ];
        return signed(ring) < 0 ? ring.reverse() : ring;
      });
  });
  return [...traced, ...manualCrosswalks(config)];
}

/** Полоса шириной `width` вдоль ломаной: один простой многоугольник. */
function strip(points: Point2[], width: number): Point2[] {
  const normals = points.map((_, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / length, (b[0] - a[0]) / length] as Point2;
  });
  const left = points.map((p, i) => add(p, normals[i], width / 2));
  const right = points.map((p, i) => add(p, normals[i], -width / 2)).reverse();
  const ring = [...left, ...right];
  return signed(ring) < 0 ? ring.reverse() : ring;
}

/** Часть ломаной между длинами дуги `from` и `to`, считая от начала. */
function sliceLine(points: Point2[], from: number, to: number): Point2[] {
  const out: Point2[] = [];
  let at = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const start = Math.max(from, at);
    const end = Math.min(to, at + length);
    if (end > start && length > 0) {
      const point = (s: number): Point2 => add(a, [b[0] - a[0], b[1] - a[1]], (s - at) / length);
      if (!out.length) out.push(point(start));
      out.push(point(end));
    }
    at += length;
  }
  return out;
}

/** Линии разметки по трассам: прерывистая 3 + 6 м, сплошная, двойная сплошная. */
export function roundaboutTracedLines(config: RoundaboutConfig): Point2[][] {
  const out: Point2[][] = [];
  for (const { style, points } of config.traced?.lines ?? []) {
    const total = points.reduce(
      (sum, p, i) => (i ? sum + Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) : 0),
      0,
    );
    const shifted = (shift: number) =>
      points.map((p, i) => {
        const a = points[Math.max(0, i - 1)];
        const b = points[Math.min(points.length - 1, i + 1)];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return add(p, [-(b[1] - a[1]) / length, (b[0] - a[0]) / length], shift);
      });
    if (style === 'solid') out.push(strip(points, LINE));
    else if (style === 'double')
      for (const shift of [-0.12, 0.12]) out.push(strip(shifted(shift), LINE));
    else
      for (let s = 0; s + 0.5 <= total; s += 9) {
        const piece = sliceLine(points, s, Math.min(s + 3, total));
        if (piece.length >= 2) out.push(strip(piece, LINE));
      }
  }
  return out;
}

function manualCrosswalks(config: RoundaboutConfig): Point2[][] {
  return (config.crosswalks ?? []).flatMap(({ from, to }) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (length < 2) throw new Error('Roundabout crosswalk is shorter than 2 m');
    const across: Point2 = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
    const along: Point2 = [-across[1], across[0]];
    const count = Math.max(2, Math.floor(length / 1.1));
    return Array.from({ length: count }, (_, k) => {
      const centre = add(from, across, 0.25 + (k * (length - 0.5)) / (count - 1));
      const a = add(centre, along, -1.5),
        b = add(centre, along, 1.5);
      const ring = [
        add(a, across, -0.25),
        add(b, across, -0.25),
        add(b, across, 0.25),
        add(a, across, 0.25),
      ];
      return signed(ring) < 0 ? ring.reverse() : ring;
    });
  });
}

/** Разметка кольца: прерывистые линии между полосами и «зубы дракона» на въездах. */
export function roundaboutMarkings(config: RoundaboutConfig): Point2[][] {
  const out: Point2[][] = [];
  const { center: c, inner, outer, lanes } = config;
  const width = (outer - inner) / lanes;
  const radii =
    config.lines ?? Array.from({ length: lanes - 1 }, (_, k) => inner + (k + 1) * width);
  for (const r of radii) {
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
const zoneCache = new WeakMap<TracedGeometry, { patches: Point2[][]; frames: CrosswalkFrame[] }>();

/** Участки обведённой дороги и «зебры», внутри которых разметка OSM заменяется обведённой. */
function tracedZones(config: RoundaboutConfig) {
  const traced = config.traced;
  if (!traced) return { patches: [] as Point2[][], frames: [] as CrosswalkFrame[] };
  let zones = zoneCache.get(traced);
  if (!zones) {
    zones = {
      patches: roundaboutCurbPatches(config),
      frames: traced.crosswalks.map(crosswalkFrame),
    };
    zoneCache.set(traced, zones);
  }
  return zones;
}

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
  // Между обведёнными краями разметку задают трассы; OSM-линии старого рисунка здесь лишние.
  const { patches, frames } = tracedZones(config);
  if (patches.some((ring) => inside(centroid, ring))) return true;
  // «Зебра» OSM рядом с обведённой — дубль: запас 7 м, потому что узел OSM сидит не по центру.
  const near = frames.some(({ origin, across, along, length, depth }) => {
    const rel: Point2 = [centroid[0] - origin[0], centroid[1] - origin[1]];
    const u = rel[0] * across[0] + rel[1] * across[1];
    const v = rel[0] * along[0] + rel[1] * along[1];
    return u > -7 && u < length + 7 && v > -7 && v < depth + 7;
  });
  if (near) return true;
  // Под островком с запасом 0,6 м не остаётся кусков линий.
  return roundaboutIslands(config, 0.6).some((island) => polygon.some((p) => inside(p, island)));
}
