import type { StaticMeshPart } from './glb.js';
import { addFace, meshPart } from './house.js';
import { GLOW_KIND, type StaticLightSource } from '@su/contracts';
import { glowRandom, markGlow, withGlow } from './glow.js';
import type { Point2 } from './triangulate.js';

/**
 * Детали фасадов для зданий по контуру: витрины, балконы, цоколь, парапет,
 * вальмовая крыша и крышная вывеска. Всё низкополигональное и без текстур.
 * Стороны света заданы в осях модели: север — −Z, восток — +X.
 */
export type Facing = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' | 'all';

export interface FacadeDetails {
  /** Полоса цоколя по низу фасадов, кроме витрин. */
  plinth?: { height: number; color: string };
  /** Торговый первый этаж: облицовка, витрины, полоса вывески и козырёк. */
  shopfront?: {
    facing: Facing[];
    height: number;
    glassColor: string;
    wallColor?: string;
    signColor?: string;
    awningColor?: string;
  };
  /** Колонны балконов или лоджий: `at` — доли длины фасада, либо шаг `every` в метрах. */
  balconies?: {
    facing: Facing[];
    at?: number[];
    every?: number;
    width?: number;
    depth?: number;
    color: string;
    /** Цвет остекления лоджии; без него балкон открытый. */
    glazing?: string;
    fromFloor?: number;
  }[];
  /** Парапет над плоской крышей; необязательная матовая накрывка внутри контура. */
  parapet?: { height: number; copingColor?: string };
  /** Вальмовая крыша над описанным прямоугольником контура. */
  hippedRoof?: { height: number; color: string; chimneys?: number; chimneyColor?: string };
  /** Щит на крыше у фасада; `text` рисуется объёмными буквами. */
  roofSign?: RoofSign;
  /** Несколько крышных вывесок у одного здания. */
  roofSigns?: RoofSign[];
  /**
   * Надписи прямо на стене: объёмные буквы на фасаде `facing`. `fromTop` — расстояние
   * от верха стены до верха строки в метрах, поэтому растяжение высоты их не искажает.
   */
  wallText?: {
    facing: Facing;
    text: string;
    at?: number;
    fromTop: number;
    height: number;
    width: number;
    color: string;
    /** Светятся ли буквы ночью, как неоновая вывеска. */
    glow?: boolean;
  }[];
  /** Пилястры: вертикальные выступы на всю высоту стены с шагом `every` метров. */
  pilasters?: { facing: Facing[]; every: number; width?: number; depth?: number; color: string };
  /** Толстая плита-карниз над стенами, выступающая на `overhang` за описанный прямоугольник. */
  roofSlab?: { thickness: number; overhang: number; color: string };
  /**
   * Окрашенные прямоугольники на фасаде, например упрощённая роспись.
   * `from`/`to` — доли ширины фасада слева направо для зрителя снаружи, `bottom`/`top` — метры.
   * Слои рисуются в порядке списка, окна остаются поверх.
   */
  paint?: {
    facing: Facing[];
    from: number;
    to: number;
    bottom: number;
    top: number;
    color: string;
  }[];
  /** Входной тамбур с навесом, вывеской и ступенями; `at` — доля ширины фасада слева. */
  porch?: {
    facing: Facing;
    at?: number;
    width: number;
    depth: number;
    height: number;
    wallColor: string;
    roofColor: string;
    signColor?: string;
    doorColor?: string;
  };
}

export interface RoofSign {
  facing: Facing;
  width: number;
  height: number;
  color: string;
  /** Полоса-подложка под буквами (без `board`) или опоры щита без текста. */
  backColor?: string;
  /** Сплошной щит за буквами, например белый фон или красный круг логотипа. */
  board?: string;
  text?: string;
  /** Светится ли щит или буквы ночью, как неоновая вывеска. */
  glow?: boolean;
  /** Положение центра на фасаде: доля ширины слева направо для зрителя снаружи. */
  at?: number;
}

const R = Math.SQRT1_2;
const DIRECTIONS: Record<Exclude<Facing, 'all'>, Point2> = {
  N: [0, -1],
  NE: [R, -R],
  E: [1, 0],
  SE: [R, R],
  S: [0, 1],
  SW: [-R, R],
  W: [-1, 0],
  NW: [-R, -R],
};

export interface Edge {
  index: number;
  p: Point2;
  q: Point2;
  length: number;
  /** Единичное направление p → q и внешняя нормаль в плоскости (x, z). */
  d: Point2;
  n: Point2;
}

/** Рёбра контура с положительной площадью: внешняя нормаль равна up × d. */
export function edgesOf(ring: Point2[]): Edge[] {
  return ring.map((p, index) => {
    const q = ring[(index + 1) % ring.length];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const d: Point2 = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
    return { index, p, q, length, d, n: [d[1], -d[0]] };
  });
}
export function faces(edge: Edge, facing: Facing[]): boolean {
  return facing.some((f) => {
    if (f === 'all') return true;
    const dir = DIRECTIONS[f];
    if (!dir) throw new Error(`Unknown facing ${f}`);
    // Допуск ±40°: контуры OSM редко идут строго по сторонам света.
    return edge.n[0] * dir[0] + edge.n[1] * dir[1] >= 0.76;
  });
}

/** Точка на фасаде: s — метры вдоль ребра, y — высота, out — вынос наружу. */
function along(edge: Edge, s: number, y: number, out: number): number[] {
  return [
    edge.p[0] + edge.d[0] * s + edge.n[0] * out,
    y,
    edge.p[1] + edge.d[1] * s + edge.n[1] * out,
  ];
}
/** Прямоугольник на фасаде, обращённый наружу. */
function facadeQuad(
  part: StaticMeshPart,
  edge: Edge,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  out: number,
) {
  addFace(part, [
    along(edge, s0, y0, out),
    along(edge, s0, y1, out),
    along(edge, s1, y1, out),
    along(edge, s1, y0, out),
  ]);
}

/** Параллелепипед, повёрнутый вокруг Y: оси u (ширина) и v (глубина) в плоскости. */
export function addOrientedBox(
  part: StaticMeshPart,
  center: number[],
  size: number[],
  u: Point2,
  v: Point2 = [-u[1], u[0]],
) {
  const [hx, hy, hz] = size.map((n) => n / 2);
  const corner = (a: number, b: number, c: number) => [
    center[0] + u[0] * hx * a + v[0] * hz * c,
    center[1] + hy * b,
    center[2] + u[1] * hx * a + v[1] * hz * c,
  ];
  const quads = [
    [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
    [
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
      [-1, -1, -1],
    ],
    [
      [-1, 1, -1],
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
    ],
    [
      [-1, -1, 1],
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
    ],
    [
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
      [-1, -1, 1],
    ],
    [
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
      [1, -1, -1],
    ],
  ];
  for (const quad of quads)
    addOutwardFace(
      part,
      quad.map(([a, b, c]) => corner(a, b, c)),
      center,
    );
}
/** Грань с нормалью от точки center; порядок вершин исправляется при необходимости. */
export function addOutwardFace(part: StaticMeshPart, points: number[][], center: number[]) {
  const [a, b, c] = points;
  const u = b.map((n, i) => n - a[i]),
    w = c.map((n, i) => n - a[i]);
  const normal = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const centroid = [0, 1, 2].map((i) => points.reduce((s, p) => s + p[i], 0) / points.length);
  const away = centroid.map((n, i) => n - center[i]);
  addFace(
    part,
    normal.reduce((s, n, i) => s + n * away[i], 0) >= 0 ? points : [...points].reverse(),
  );
}

/** Минимальный описанный прямоугольник: центр, ось длинной стороны и полуразмеры. */
export function minimumRectangle(ring: Point2[]) {
  let best: { area: number; center: Point2; u: Point2; half: Point2 } | undefined;
  for (const edge of edgesOf(ring)) {
    const u = edge.d,
      v: Point2 = [-u[1], u[0]];
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [x, z] of ring) {
      const a = x * u[0] + z * u[1],
        b = x * v[0] + z * v[1];
      [u0, u1, v0, v1] = [Math.min(u0, a), Math.max(u1, a), Math.min(v0, b), Math.max(v1, b)];
    }
    const area = (u1 - u0) * (v1 - v0);
    if (best && area >= best.area) continue;
    const cu = (u0 + u1) / 2,
      cv = (v0 + v1) / 2;
    const center: Point2 = [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv];
    // Ось u всегда вдоль длинной стороны: по ней идёт конёк.
    best =
      u1 - u0 >= v1 - v0
        ? { area, center, u, half: [(u1 - u0) / 2, (v1 - v0) / 2] }
        : { area, center, u: v, half: [(v1 - v0) / 2, (u1 - u0) / 2] };
  }
  return best!;
}

/** Вальмовая крыша: видимые скаты и замкнутое тело для столкновений. */
function hippedRoof(
  ring: Point2[],
  base: number,
  recipe: NonNullable<FacadeDetails['hippedRoof']>,
) {
  const { center, u, half } = minimumRectangle(ring);
  const v: Point2 = [-u[1], u[0]];
  const overhang = 0.3;
  const [hu, hv] = [half[0] + overhang, half[1] + overhang];
  const top = base + recipe.height;
  const point = (a: number, b: number, y: number) => [
    center[0] + u[0] * a + v[0] * b,
    y,
    center[1] + u[1] * a + v[1] * b,
  ];
  const corners = [
    point(-hu, -hv, base),
    point(hu, -hv, base),
    point(hu, hv, base),
    point(-hu, hv, base),
  ];
  const ridge = Math.max(0, hu - hv);
  const apexes = ridge > 0.2 ? [point(-ridge, 0, top), point(ridge, 0, top)] : [point(0, 0, top)];
  const vertices = [...corners, ...apexes];
  const triangles: number[][] =
    apexes.length === 2
      ? [
          [0, 1, 5, 4],
          [1, 2, 5],
          [2, 3, 4, 5],
          [3, 0, 4],
          [0, 1, 2, 3],
        ]
      : [
          [0, 1, 4],
          [1, 2, 4],
          [2, 3, 4],
          [3, 0, 4],
          [0, 1, 2, 3],
        ];
  const middle = [center[0], base + recipe.height / 3, center[1]];
  const roof = meshPart('roof-slopes', 'roof', recipe.color);
  const indices: number[] = [];
  const collider = meshPart('collider', 'roof', recipe.color);
  for (const face of triangles) {
    const points = face.map((i) => vertices[i]);
    if (face.length === 4 && face.every((i) => i < 4)) addOutwardFace(collider, points, middle);
    else {
      addOutwardFace(roof, points, middle);
      addOutwardFace(collider, points, middle);
    }
  }
  indices.push(...collider.indices);
  const chimneys = meshPart('chimneys', 'detail', recipe.chimneyColor ?? '#7a5546');
  const count = recipe.chimneys ?? 0;
  for (let k = 0; k < count; k++) {
    const a = -ridge + ((k + 1) / (count + 1)) * 2 * ridge;
    const [x, , z] = point(a, k % 2 ? 0.7 : -0.7, 0);
    addOrientedBox(
      chimneys,
      [x, top - recipe.height * 0.3 + 0.5, z],
      [0.8, recipe.height * 0.6 + 1, 0.8],
      u,
    );
  }
  return {
    parts: [roof, ...(count ? [chimneys] : [])],
    collider: { vertices: collider.positions, indices },
  };
}

/** Пиксельный шрифт 5 × 7 для вывесок: только нужные буквы, остальные — ошибка сборки. */
const GLYPHS: Record<string, string[]> = {
  А: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  Б: ['#####', '#....', '#....', '####.', '#...#', '#...#', '####.'],
  Г: ['#####', '#....', '#....', '#....', '#....', '#....', '#....'],
  И: ['#...#', '#...#', '#..##', '#.#.#', '##..#', '#...#', '#...#'],
  Й: ['.#.#.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '#...#'],
  Л: ['.####', '.#..#', '.#..#', '.#..#', '.#..#', '.#..#', '##..#'],
  М: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  Н: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  Т: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  Е: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  Ё: ['.#.#.', '#####', '#....', '####.', '#....', '#....', '#####'],
  К: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  О: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  П: ['#####', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#'],
  Р: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Ч: ['#...#', '#...#', '#...#', '.####', '....#', '....#', '....#'],
  Я: ['.####', '#...#', '#...#', '.####', '..#.#', '.#..#', '#...#'],
  В: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  Д: ['.###.', '.#.#.', '.#.#.', '.#.#.', '.#.#.', '#####', '#...#'],
  С: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  У: ['#...#', '#...#', '#...#', '.####', '....#', '#...#', '.###.'],
  Ы: ['#...#', '#...#', '#...#', '###.#', '#.#.#', '#.#.#', '###.#'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

/**
 * Неоновая вывеска: светятся только грани букв, обращённые наружу от фасада, и перед
 * вывеской появляется источник света её цвета. Такие вывески горят от сумерек до утра.
 */
function signGlow(
  part: StaticMeshPart,
  spec: { glow?: boolean; text?: string; color: string },
  edge: Edge,
  center: number[],
  lights: StaticLightSource[],
) {
  if (!spec.glow) return;
  const seed = glowRandom(`${spec.text ?? ''}:${spec.color}`)();
  const count = part.positions.length / 3;
  part.glow = [];
  for (let i = 0; i < count; i++) {
    const facing = part.normals[i * 3] * edge.n[0] + part.normals[i * 3 + 2] * edge.n[1];
    part.glow.push(facing > 0.7 ? GLOW_KIND.neon : 0, facing > 0.7 ? seed : 0);
  }
  const [x, y, z] = center;
  // Высокая вывеска освещает большую область, но до земли с крыши доходит слабый свет.
  lights.push({
    position: { x, y, z },
    radius: Math.min(40, Math.max(10, y + 4)),
    color: spec.color,
    kind: 'neon',
  });
}

function roofSign(
  edges: Edge[],
  top: number,
  recipe: RoofSign,
  index: number,
  lights: StaticLightSource[],
) {
  const candidates = edges.filter((edge) => faces(edge, [recipe.facing]));
  if (!candidates.length) throw new Error(`No facade faces ${recipe.facing} for the roof sign`);
  const edge = candidates.reduce((a, b) => (b.length > a.length ? b : a));
  const width = Math.min(recipe.width, edge.length - 1);
  // Слева направо для зрителя снаружи — это направление −d, см. текст ниже.
  const s = Math.min(
    edge.length - width / 2 - 0.3,
    Math.max(width / 2 + 0.3, edge.length * (1 - (recipe.at ?? 0.5))),
  );
  const suffix = index ? `-${index}` : '';
  const back = meshPart(`sign-back${suffix}`, 'detail', recipe.backColor ?? recipe.color);
  const face = meshPart(`sign${suffix}`, 'detail', recipe.color);
  const board = meshPart(`sign-board${suffix}`, 'detail', recipe.board ?? recipe.color);
  const inset = 0.8;
  const at = (offsetS: number, y: number, out: number) => along(edge, s + offsetS, y, out - inset);
  const text = recipe.text?.toUpperCase();
  if (!text) {
    addOrientedBox(
      face,
      at(0, top + recipe.height / 2 + 0.3, 0),
      [width, recipe.height, 0.25],
      edge.d,
    );
    // Две опоры под щитом.
    for (const offset of [-width / 3, width / 3])
      addOrientedBox(back, at(offset, top + 0.15, 0), [0.25, 0.3, 0.25], edge.d);
    signGlow(face, recipe, edge, along(edge, s, top + recipe.height / 2 + 0.3, 1.8), lights);
    return [face, back];
  }
  const glyphs = [...text].map((c) => {
    const glyph = GLYPHS[c];
    if (!glyph) throw new Error(`Sign glyph is not supported: ${c}`);
    return glyph;
  });
  const columns = glyphs.length * 6 - 1;
  const pixel = Math.min(recipe.height / 7, width / columns);
  const left = -(columns * pixel) / 2;
  if (recipe.board) {
    // Сплошной щит за буквами; буквы выступают из него.
    addOrientedBox(
      board,
      at(0, top + pixel * 4.7, -0.02),
      [columns * pixel + pixel * 2, pixel * 9, 0.16],
      edge.d,
    );
    // Опоры щита на крыше.
    for (const offset of [-columns * pixel * 0.3, columns * pixel * 0.3])
      addOrientedBox(back, at(offset, top + pixel * 0.1, -0.02), [0.15, pixel * 0.2, 0.15], edge.d);
  } else {
    // Подложка под буквами — узкая полоса, как у объёмных вывесок на крышах.
    addOrientedBox(
      back,
      at(0, top + pixel * 0.6, 0.05),
      [columns * pixel + pixel, pixel * 1.2, 0.3],
      edge.d,
    );
  }
  glyphs.forEach((glyph, index) => {
    glyph.forEach((row, line) => {
      // Соседние пиксели строки объединяются в один брусок.
      for (const match of row.matchAll(/#+/g)) {
        const start = index * 6 + match.index!;
        // Для зрителя снаружи «вправо» — это −d, поэтому ось текста обращена.
        const centerS = -(left + (start + match[0].length / 2) * pixel);
        const y = top + pixel * 1.2 + (6 - line + 0.5) * pixel;
        addOrientedBox(face, at(centerS, y, 0.1), [match[0].length * pixel, pixel, 0.2], edge.d);
      }
    });
  });
  signGlow(face, recipe, edge, along(edge, s, top + pixel * 4.7, 1.8), lights);
  return [face, back, ...(recipe.board ? [board] : [])];
}

/** Строка объёмных букв на стене; верх стены — на высоте `top`. */
function wallText(
  edges: Edge[],
  top: number,
  spec: NonNullable<FacadeDetails['wallText']>[number],
  index: number,
  lights: StaticLightSource[],
) {
  const candidates = edges.filter((edge) => faces(edge, [spec.facing]));
  if (!candidates.length) throw new Error(`No facade faces ${spec.facing} for the wall text`);
  const edge = candidates.reduce((a, b) => (b.length > a.length ? b : a));
  const glyphs = [...spec.text.toUpperCase()].map((c) => {
    const glyph = GLYPHS[c];
    if (!glyph) throw new Error(`Sign glyph is not supported: ${c}`);
    return glyph;
  });
  const columns = glyphs.length * 6 - 1;
  const width = Math.min(spec.width, edge.length - 0.6);
  const pixel = Math.min(spec.height / 7, width / columns);
  const s = Math.min(
    edge.length - width / 2,
    Math.max(width / 2, edge.length * (1 - (spec.at ?? 0.5))),
  );
  const left = -(columns * pixel) / 2;
  const part = meshPart(`wall-text-${index}`, 'detail', spec.color);
  glyphs.forEach((glyph, k) =>
    glyph.forEach((row, line) => {
      for (const match of row.matchAll(/#+/g)) {
        const start = k * 6 + match.index!;
        // Для зрителя снаружи «вправо» — это −d, как у крышных вывесок.
        const centerS = s - (left + (start + match[0].length / 2) * pixel);
        const y = top - spec.fromTop - (line + 0.5) * pixel;
        addOrientedBox(
          part,
          along(edge, centerS, y, 0.06),
          [match[0].length * pixel, pixel, 0.08],
          edge.d,
        );
      }
    }),
  );
  signGlow(part, spec, edge, along(edge, s, top - spec.fromTop - pixel * 3.5, 1.5), lights);
  return part;
}

export interface FacadeResult {
  parts: StaticMeshPart[];
  /** Этажи и рёбра, где окна не нужны (например, витрины первого этажа). */
  skipWindow: (edge: number, floor: number) => boolean;
  /** Источники света неоновых вывесок. */
  lights: StaticLightSource[];
  /** Дополнительная высота стен над крышей. */
  parapet: number;
  /** Замкнутое тело крыши для столкновений. */
  roofCollider?: { vertices: number[]; indices: number[] };
  /** Повёрнутые коробки столкновений деталей: ось u — ширина. */
  boxes: { center: number[]; size: number[]; u: Point2 }[];
}

/** Самый длинный фасад, обращённый в заданную сторону. */
function widestFacing(edges: Edge[], facing: Facing, label: string): Edge {
  const candidates = edges.filter((edge) => faces(edge, [facing]));
  if (!candidates.length) throw new Error(`No facade faces ${facing} for the ${label}`);
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

export function buildFacade(
  ring: Point2[],
  height: number,
  floors: number,
  details: FacadeDetails | undefined,
  elevation = 0,
  /** Ночное свечение: случайные числа окон и класс остеклённых лоджий. */
  glow: { random: () => number; windows?: 'window' | 'office' } = { random: () => 0.5 },
): FacadeResult {
  if (!details) return { parts: [], skipWindow: () => false, parapet: 0, boxes: [], lights: [] };
  const edges = edgesOf(ring);
  const parts: StaticMeshPart[] = [];
  const boxes: FacadeResult['boxes'] = [];
  const lights: StaticLightSource[] = [];
  const storey = (height - elevation) / floors;
  const shopEdges = new Set<number>();
  const shop = details.shopfront;
  if (shop) {
    const band = meshPart('shopfront', 'wall', shop.wallColor ?? '#8a8f93');
    const glass = meshPart('shop-glass', 'detail', shop.glassColor);
    const sign = meshPart('shop-sign', 'detail', shop.signColor ?? shop.glassColor);
    const awning = meshPart('awning', 'detail', shop.awningColor ?? '#b33a32');
    for (const edge of edges) {
      if (edge.length < 2.5 || !faces(edge, shop.facing)) continue;
      shopEdges.add(edge.index);
      if (shop.wallColor) facadeQuad(band, edge, 0, edge.length, 0, shop.height, 0.02);
      const panes = Math.max(1, Math.round(edge.length / 3.2));
      const step = edge.length / panes;
      // Витрины одного фасада принадлежат одному магазину и включаются вместе.
      const shopSeed = glow.random();
      for (let k = 0; k < panes; k++)
        withGlow(glass, 'shop', shopSeed, () =>
          facadeQuad(
            glass,
            edge,
            k * step + 0.18,
            (k + 1) * step - 0.18,
            0.35,
            shop.height - 0.75,
            0.04,
          ),
        );
      if (shop.signColor)
        withGlow(sign, 'sign', glow.random(), () =>
          facadeQuad(
            sign,
            edge,
            0.1,
            edge.length - 0.1,
            shop.height - 0.65,
            shop.height - 0.1,
            0.06,
          ),
        );
      if (shop.awningColor) {
        const y = shop.height - 0.75;
        const near = (s: number) => along(edge, s, y, 0.07);
        const far = (s: number) => along(edge, s, y - 0.35, 1.1);
        addFace(awning, [near(edge.length), near(0), far(0), far(edge.length)]);
        addFace(awning, [near(0), near(edge.length), far(edge.length), far(0)]);
      }
    }
    for (const part of [band, glass, sign, awning]) if (part.indices.length) parts.push(part);
  }
  if (details.plinth) {
    const plinth = meshPart('plinth', 'detail', details.plinth.color);
    for (const edge of edges)
      if (!shopEdges.has(edge.index))
        facadeQuad(plinth, edge, 0, edge.length, 0, details.plinth.height, 0.015);
    if (plinth.indices.length) parts.push(plinth);
  }
  details.balconies?.forEach((group, index) => {
    const slab = meshPart(`balconies-${index}`, 'detail', group.color);
    const glass = meshPart(`loggias-${index}`, 'detail', group.glazing ?? group.color);
    const width = group.width ?? 2.6,
      depth = group.depth ?? 1;
    for (const edge of edges) {
      if (edge.length < width + 0.5 || !faces(edge, group.facing)) continue;
      const count = Math.max(1, Math.floor(edge.length / (group.every ?? 6)));
      const positions = group.at
        ? group.at.map((t) => t * edge.length)
        : Array.from({ length: count }, (_, k) => ((k + 0.5) * edge.length) / count);
      for (const s of positions) {
        const clamped = Math.min(edge.length - width / 2 - 0.2, Math.max(width / 2 + 0.2, s));
        for (let floor = group.fromFloor ?? 1; floor < floors; floor++) {
          const y = elevation + floor * storey;
          addOrientedBox(slab, along(edge, clamped, y + 0.5, depth / 2), [width, 1, depth], edge.d);
          if (group.glazing) {
            const start = glass.positions.length / 3;
            addOrientedBox(
              glass,
              along(edge, clamped, y + 1 + (storey - 1.3) / 2, depth / 2 - 0.03),
              [width - 0.1, storey - 1.3, depth - 0.12],
              edge.d,
            );
            const seed = glow.random();
            if (glow.windows) markGlow(glass, start, glow.windows, seed);
          }
        }
      }
    }
    if (slab.indices.length) parts.push(slab);
    if (glass.indices.length && group.glazing) parts.push(glass);
  });
  const parapet = details.parapet?.height ?? 0;
  if (details.parapet?.copingColor) {
    if (!/^#[a-f0-9]{6}$/i.test(details.parapet.copingColor) || parapet < 0.07)
      throw new Error('Invalid parapet coping');
    const coping = meshPart('parapet-coping', 'roof', details.parapet.copingColor);
    for (const edge of edges) {
      // Накрывка лежит ниже существующего верха и внутри контура: размеры
      // здания и коллизия не меняются. Отступы на концах избегают стыков углов.
      if (edge.length < 0.4) continue;
      addOrientedBox(
        coping,
        along(edge, edge.length / 2, height + parapet - 0.035, -0.083),
        [edge.length - 0.32, 0.07, 0.16],
        edge.d,
      );
    }
    if (coping.indices.length) parts.push(coping);
  }
  let roofCollider: FacadeResult['roofCollider'];
  if (details.hippedRoof) {
    const roof = hippedRoof(ring, height, details.hippedRoof);
    parts.push(...roof.parts);
    roofCollider = roof.collider;
  }
  details.wallText?.forEach((spec, index) =>
    parts.push(wallText(edges, height + parapet, spec, index, lights)),
  );
  [...(details.roofSign ? [details.roofSign] : []), ...(details.roofSigns ?? [])].forEach(
    (sign, index) => parts.push(...roofSign(edges, height + parapet, sign, index, lights)),
  );
  if (details.roofSlab) {
    const spec = details.roofSlab;
    if (!(spec.thickness > 0 && spec.thickness < height - elevation) || !(spec.overhang >= 0))
      throw new Error('Invalid roof slab');
    const { center, u, half } = minimumRectangle(ring);
    const slab = meshPart('roof-slab', 'roof', spec.color);
    // Верх плиты чуть выше плоской крыши, иначе две поверхности мерцают на одной высоте.
    const top = height + parapet + 0.05;
    addOrientedBox(
      slab,
      [center[0], top - spec.thickness / 2, center[1]],
      [2 * (half[0] + spec.overhang), spec.thickness, 2 * (half[1] + spec.overhang)],
      u,
    );
    parts.push(slab);
  }
  if (details.pilasters) {
    const spec = details.pilasters;
    const part = meshPart('pilasters', 'wall', spec.color);
    const width = spec.width ?? 0.8,
      depth = spec.depth ?? 0.3;
    if (!(spec.every >= width + 0.5)) throw new Error('Pilaster spacing is too small');
    for (const edge of edges) {
      if (edge.length < spec.every || !faces(edge, spec.facing)) continue;
      const count = Math.floor(edge.length / spec.every) + 1;
      const step = (edge.length - width) / (count - 1);
      for (let k = 0; k < count; k++)
        addOrientedBox(
          part,
          along(edge, width / 2 + k * step, (elevation + height + parapet) / 2, depth / 2),
          [width, height + parapet - elevation, depth],
          edge.d,
        );
    }
    if (part.indices.length) parts.push(part);
  }
  details.paint?.forEach((layer, index) => {
    if (!(layer.from >= 0 && layer.to <= 1 && layer.from < layer.to && layer.bottom < layer.top))
      throw new Error(`Invalid facade paint layer ${index}`);
    // Слои лежат между стеной и окнами: от 12 до 28 мм от стены.
    const out = 0.012 + Math.min(index, 8) * 0.002;
    const part = meshPart(`paint-${index}`, 'detail', layer.color);
    for (const edge of edges)
      if (faces(edge, layer.facing))
        facadeQuad(
          part,
          edge,
          edge.length * (1 - layer.to),
          edge.length * (1 - layer.from),
          layer.bottom,
          Math.min(layer.top, height + parapet),
          out,
        );
    if (part.indices.length) parts.push(part);
  });
  if (details.porch) {
    const spec = details.porch;
    const edge = widestFacing(edges, spec.facing, 'porch');
    const s = edge.length * (1 - (spec.at ?? 0.5));
    const walls = meshPart('porch', 'detail', spec.wallColor);
    const roof = meshPart('porch-roof', 'detail', spec.roofColor);
    const sign = meshPart('porch-sign', 'detail', spec.signColor ?? spec.roofColor);
    const door = meshPart('porch-door', 'detail', spec.doorColor ?? '#2e2a28');
    const steps = meshPart('porch-steps', 'detail', '#9a968e');
    const body = { width: spec.width * 0.6, depth: spec.depth * 0.75 };
    const center = along(edge, s, spec.height / 2, body.depth / 2);
    addOrientedBox(walls, center, [body.width, spec.height, body.depth], edge.d);
    boxes.push({ center, size: [body.width, spec.height, body.depth], u: edge.d });
    addOrientedBox(
      roof,
      along(edge, s, spec.height + 0.3, spec.depth / 2),
      [spec.width, 0.6, spec.depth],
      edge.d,
    );
    // Вывеска на торце навеса и дверь на фасаде тамбура.
    facadeQuad(
      sign,
      edge,
      s - spec.width / 2 + 0.2,
      s + spec.width / 2 - 0.2,
      spec.height + 0.05,
      spec.height + 0.55,
      spec.depth + 0.02,
    );
    facadeQuad(door, edge, s - 0.9, s + 0.9, 0, 2.3, body.depth + 0.02);
    for (const side of [-1, 1])
      addOrientedBox(
        walls,
        along(edge, s + side * (spec.width / 2 - 0.3), spec.height / 2, spec.depth - 0.3),
        [0.3, spec.height, 0.3],
        edge.d,
      );
    addOrientedBox(
      steps,
      along(edge, s, 0.12, body.depth + 0.8),
      [body.width + 1, 0.24, 1.6],
      edge.d,
    );
    parts.push(walls, roof, sign, door, steps);
  }
  return {
    parts,
    skipWindow: (edge, floor) => floor === 0 && shopEdges.has(edge),
    parapet,
    roofCollider,
    boxes,
    lights,
  };
}
