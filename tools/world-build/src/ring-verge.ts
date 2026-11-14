/**
 * Разовая правка земли и оград у кольца по Street View 2021 и спутниковому снимку.
 *
 *   pnpm world:ground:ring-verge            # применить к content/ (только к исходной версии)
 *   pnpm world:ground:ring-verge -- --dry   # отчёт и SVG dist/preview/ring-verge.svg без записи
 *
 * Что меняется:
 * - вдоль внешнего края кольца (обводки `*:edge-*` из ring-trace.json) между бордюром и
 *   тротуаром появляется газон шириной 1,5–3 м, как на фото; у «зебр» газон обрывается;
 * - ограды OSM вокруг кольца (часть стояла прямо на проезжей части) заменяются новыми цепочками
 *   низкой светлой решётки `fence-road-*` по внешнему краю газона;
 * - островки безопасности на подъездах — не приподнятые светлые площадки, а разметка:
 *   контур и косая штриховка на асфальте;
 * - газон центрального острова доходит до бордюра (было ~1,6 м голой плиты);
 * - фонари и светофоры у кольца, стоявшие на асфальте, переносятся за бордюр.
 *
 * Для действующей БД те же замены оград применяются к экспорту размещений:
 *   pnpm world:ground:ring-verge -- --layout <export.json> --out <edited.json>
 * затем `make map-patch`/`map-apply` (docs/operations.md, «Файловые патчи размещений»).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { validateTerrainGrid, type BuildingInstance, type TerrainGrid } from '@su/contracts';
import {
  validateFoundationSupportRule,
  type FoundationSupportRuleV2,
} from '@su/terrain-build/private-data';
import { planSupportPlacement } from '@su/terrain-build/supports';
import type { Point2 } from '@su/terrain-build/triangulate';
import type { GroundRecipe } from './city.js';
import { seedHeight as canonicalHeight } from './seed-height.js';
import { smoothTrace } from './roundabout.js';

const GROUND = 'content/buildings/ring-block/ring-block-ground/source.json';
const SEED = 'content/worlds/ring-block/cells/0_0.json';
const TRACE = 'content/worlds/ring-block/ring-trace.json';
const LAYOUT = 'content/worlds/ring-block/ring-layout.json';
const WORLD_DIR = 'content/worlds/ring-block';
const RELEASE = `${WORLD_DIR}/terrain-release.json`;
const PLACEMENT = `${WORLD_DIR}/placement.json`;
const CATALOG = 'content/buildings/ring-block/catalog.json';
/** SHA-256 основания до правки (main 8bf7364): повторный запуск не добавит газон дважды. */
const ORIGINAL_SHA256 = '00e0aa7cf8591998e9767a7be2e5203c36f4ae433fa9c0a9aff9aa36fc59c260';

/** Бордюр между асфальтом и газоном. */
const CURB = 0.3;
/** Ширина газона по четвертям кольца (азимут середины обводки), м: по кадрам Street View. */
const VERGE: Record<string, number> = { NE: 2.5, SE: 1.5, SW: 3, NW: 2.5 };
/** Ограда стоит на газоне в стольких метрах от его внешнего края. */
const FENCE_INSET = 0.3;
/** Газон и ограда обрываются за столько метров до «зебры». */
const CROSSWALK_GAP = 2.5;
/** Старые ограды в этой полосе от обводки бордюра заменяются. */
const REPLACE_BAND = 5;
/** Модули новой ограды: длина и стойки (центры по X), как в их source.json. */
const FENCE_LONG = { assetId: 'fence-road-long', length: 4, posts: [-1.97, 0, 1.97] };
const FENCE_SHORT = { assetId: 'fence-road-short', length: 1, posts: [-0.47, 0.47] };
const POST = 0.06;
/** Центральный остров: радиус газона = внутренний радиус кольца минус бордюр. */
const LAWN_SIDES = 72;
/** Столбы у кольца, которые не должны стоять на асфальте, и отступ от края проезжей части. */
const POLES = /^(lamp-street|traffic-light-standard)$/;
const POLE_AREA = 110;
const POLE_CLEARANCE = 0.8;
/** Штриховка островков. */
const HATCH = { line: 0.15, stripe: 0.4, step: 1.6, inset: 0.35, angle: 45 };

type Polygon = Point2[][];
interface Placed {
  entityId: string;
  assetId: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  [key: string]: unknown;
}

const sub = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point2, b: Point2, k = 1): Point2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const len = (a: Point2) => Math.hypot(a[0], a[1]);
const norm = (a: Point2): Point2 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};
const round = (p: Point2): Point2 => [
  Math.round(p[0] * 1000) / 1000,
  Math.round(p[1] * 1000) / 1000,
];

function segmentDistance(p: Point2, a: Point2, b: Point2) {
  const d = sub(b, a);
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2 || 1)),
  );
  return len(sub(p, add(a, d, t)));
}
function polylineDistance(p: Point2, line: readonly Point2[]) {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++)
    best = Math.min(best, segmentDistance(p, line[i], line[i + 1]));
  return best;
}
function inside(p: Point2, ring: readonly Point2[]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i],
      [xj, zj] = ring[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}
const inPolygon = (p: Point2, [outer, ...holes]: Polygon) =>
  inside(p, outer) && !holes.some((h) => inside(p, h));
const signedArea = (ring: readonly Point2[]) =>
  ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;
const ccw = (ring: Point2[]) => (signedArea(ring) < 0 ? [...ring].reverse() : ring);

/** Плотная выборка ломаной с шагом ~step. */
function resample(line: readonly Point2[], step: number): Point2[] {
  const out: Point2[] = [line[0]];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i],
      b = line[i + 1];
    const n = Math.max(1, Math.ceil(len(sub(b, a)) / step));
    for (let k = 1; k <= n; k++) out.push(add(a, sub(b, a), k / n));
  }
  return out;
}

/** Сдвиг ломаной вбок: `side` +1 — влево по ходу (нормаль (−dz, dx)). */
function offset(line: readonly Point2[], distance: number, side: number): Point2[] {
  return line.map((p, i) => {
    const a = line[Math.max(0, i - 1)],
      b = line[Math.min(line.length - 1, i + 1)];
    const d = norm(sub(b, a));
    return add(p, [-d[1] * side, d[0] * side], distance);
  });
}

/** Часть ломаной между длинами from и to от начала. */
function slice(line: readonly Point2[], from: number, to: number): Point2[] {
  const out: Point2[] = [];
  let s = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i],
      b = line[i + 1],
      l = len(sub(b, a));
    const s0 = s,
      s1 = s + l;
    if (s1 >= from && s0 <= to) {
      const t0 = Math.max(0, (from - s0) / (l || 1));
      const t1 = Math.min(1, (to - s0) / (l || 1));
      if (!out.length) out.push(add(a, sub(b, a), t0));
      out.push(add(a, sub(b, a), t1));
    }
    s = s1;
  }
  return out;
}
const lengthOf = (line: readonly Point2[]) =>
  line.reduce((s, p, i) => (i ? s + len(sub(p, line[i - 1])) : 0), 0);

const quadrant = (p: Point2) => {
  const bearing = ((Math.atan2(p[0], -p[1]) * 180) / Math.PI + 360) % 360;
  return bearing < 90 ? 'NE' : bearing < 180 ? 'SE' : bearing < 270 ? 'SW' : 'NW';
};

interface Verge {
  name: string;
  quadrant: string;
  curb: Point2[];
  strip: Point2[];
  fence: Point2[];
}

async function loadTraces() {
  const trace = JSON.parse(await readFile(TRACE, 'utf8')) as {
    traces: { name: string; points: Point2[] }[];
  };
  const layout = JSON.parse(await readFile(LAYOUT, 'utf8'));
  const smooth = layout.smooth === true;
  const curbs = trace.traces
    .filter((t) => /:edge-/.test(t.name) && !t.name.startsWith('ring:'))
    .map((t) => ({ name: t.name, points: smooth ? smoothTrace(t.points) : t.points }));
  const crosswalks = trace.traces.filter((t) => t.name.endsWith(':crosswalk')).map((t) => t.points);
  const islands = trace.traces.filter((t) => t.name.endsWith(':island'));
  return { curbs, crosswalks, islands, center: layout.roundabout.center as Point2 };
}

function verges(
  curbs: { name: string; points: Point2[] }[],
  crosswalks: Point2[][],
  roads: Polygon[],
): Verge[] {
  return curbs.map(({ name, points }) => {
    const line = resample(points, 0.5);
    // Газон — с той стороны бордюра, где нет асфальта.
    const mid = line[Math.floor(line.length / 2)];
    const probe = (side: number) =>
      add(
        mid,
        norm([
          -(line[Math.floor(line.length / 2) + 1][1] - mid[1]) * side,
          (line[Math.floor(line.length / 2) + 1][0] - mid[0]) * side,
        ]),
        1.5,
      );
    const side = roads.some((r) => inPolygon(probe(1), r)) ? -1 : 1;
    const q = quadrant(mid);
    const width = VERGE[q];
    // Обрыв у «зебр»: от каждого конца отступаем, пока ближе CROSSWALK_GAP к контуру перехода.
    const nearCrossing = (p: Point2) =>
      crosswalks.some(
        (c) =>
          inside(p, c) ||
          c.some((_, i) => segmentDistance(p, c[i], c[(i + 1) % c.length]) < CROSSWALK_GAP),
      );
    const total = lengthOf(line);
    let from = 0,
      to = total;
    const probes = (s: number) => {
      const p = slice(line, s, s + 1e-6)[0];
      return [
        p,
        ...[CURB, CURB + width].map(
          (d) => offset(slice(line, Math.max(0, s - 0.5), Math.min(total, s + 0.5)), d, side)[0],
        ),
      ];
    };
    while (from < total && probes(from).some(nearCrossing)) from += 0.25;
    while (to > from && probes(to).some(nearCrossing)) to -= 0.25;
    const curb = slice(line, from, to);
    const inner = offset(curb, CURB, side);
    const outer = offset(curb, CURB + width, side);
    return {
      name,
      quadrant: q,
      curb,
      strip: ccw([...inner, ...outer.reverse()].map(round)),
      fence: offset(curb, CURB + width - FENCE_INSET, side),
    };
  });
}

/** Цепочка модулей: концы модулей лежат на ломаной, хорды по 4 м и остаток метровыми. */
function fenceChain(line: readonly Point2[], prefix: string): Placed[] {
  const dense = resample(line, 0.1);
  const out: Placed[] = [];
  let at = dense[0],
    i = 0;
  const total = lengthOf(dense);
  let walked = 0;
  while (i < dense.length - 1) {
    const left = total - walked;
    const module = left >= FENCE_LONG.length - 0.05 ? FENCE_LONG : FENCE_SHORT;
    if (left < FENCE_SHORT.length * 0.6) break;
    // Первая точка ломаной на расстоянии module.length от начала модуля.
    let j = i + 1;
    while (j < dense.length - 1 && len(sub(dense[j], at)) < module.length) j++;
    const end = dense[j];
    const chord = len(sub(end, at));
    if (chord < module.length * 0.6) break;
    const dir = norm(sub(end, at));
    const centre = add(at, dir, module.length / 2);
    const yaw = Math.atan2(-dir[1], dir[0]);
    out.push({
      entityId: `${prefix}-${String(out.length + 1).padStart(3, '0')}`,
      assetId: module.assetId,
      position: { x: round(centre)[0], y: 0, z: round(centre)[1] },
      rotation: {
        x: 0,
        y: Number(Math.sin(yaw / 2).toFixed(8)),
        z: 0,
        w: Number(Math.cos(yaw / 2).toFixed(8)),
      },
    });
    walked += lengthOf(dense.slice(i, j + 1));
    at = add(at, dir, module.length);
    i = j;
  }
  return out;
}

/** Контур и косая штриховка островка вместо светлой площадки. */
function paintedIsland(ring: Point2[], center: Point2): Point2[][] {
  const out: Point2[][] = [];
  const closed = [...ring, ring[0]];
  for (let i = 0; i + 1 < closed.length; i++) {
    const a = closed[i],
      b = closed[i + 1];
    const d = norm(sub(b, a));
    const n: Point2 = [-d[1] * (HATCH.line / 2), d[0] * (HATCH.line / 2)];
    // Небольшой нахлёст на стыках, чтобы контур не рвался на изгибах.
    const a2 = add(a, d, -HATCH.line / 2),
      b2 = add(b, d, HATCH.line / 2);
    out.push(ccw([add(a2, n), add(b2, n), add(b2, n, -1), add(a2, n, -1)].map(round)));
  }
  let cx = 0,
    cz = 0;
  for (const p of ring) {
    cx += p[0] / ring.length;
    cz += p[1] / ring.length;
  }
  const radial = norm(sub([cx, cz], center));
  const a = (HATCH.angle * Math.PI) / 180;
  const u: Point2 = [
    radial[0] * Math.cos(a) - radial[1] * Math.sin(a),
    radial[0] * Math.sin(a) + radial[1] * Math.cos(a),
  ];
  const v: Point2 = [-u[1], u[0]];
  const along = ring.map((p) => p[0] * v[0] + p[1] * v[1]);
  const lo = Math.min(...along),
    hi = Math.max(...along);
  for (let o = Math.ceil(lo / HATCH.step) * HATCH.step; o <= hi; o += HATCH.step) {
    // Пересечения прямой {p·v = o} с контуром — чётные отрезки внутри.
    const hits: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i],
        q = ring[(i + 1) % ring.length];
      const sp = p[0] * v[0] + p[1] * v[1] - o,
        sq = q[0] * v[0] + q[1] * v[1] - o;
      if (sp > 0 === sq > 0) continue;
      const x = add(p, sub(q, p), sp / (sp - sq));
      hits.push(x[0] * u[0] + x[1] * u[1]);
    }
    hits.sort((m, n) => m - n);
    for (let k = 0; k + 1 < hits.length; k += 2) {
      const t0 = hits[k] + HATCH.inset,
        t1 = hits[k + 1] - HATCH.inset;
      if (t1 - t0 < 0.4) continue;
      const base = add([0, 0], v, o);
      const s = HATCH.stripe / 2;
      out.push(
        ccw(
          [
            add(add(base, u, t0), v, -s),
            add(add(base, u, t1), v, -s),
            add(add(base, u, t1), v, s),
            add(add(base, u, t0), v, s),
          ].map(round),
        ),
      );
    }
  }
  return out;
}

const circle = (c: Point2, r: number): Point2[] =>
  Array.from({ length: LAWN_SIDES }, (_, k) =>
    round([
      c[0] + Math.cos((k / LAWN_SIDES) * 2 * Math.PI) * r,
      c[1] + Math.sin((k / LAWN_SIDES) * 2 * Math.PI) * r,
    ]),
  );

function replacedFences(items: Placed[], curbs: Point2[][]) {
  return items.filter(
    (e) =>
      typeof e.assetId === 'string' &&
      /^fence-(long|short)$/.test(e.assetId) &&
      curbs.some((c) => polylineDistance([e.position.x, e.position.z], c) < REPLACE_BAND),
  );
}

/** Фундамент под стойками, как у fence-long: по квадрату на стойку. */
function supportRule(module: typeof FENCE_LONG) {
  const h = POST / 2;
  return validateFoundationSupportRule({
    assetId: module.assetId,
    burial: 0.1,
    clearance: 0.02,
    color: '#8b8580',
    components: module.posts.map((x) => ({
      outline: [
        [x - h, -h],
        [x - h, h],
        [x + h, h],
        [x + h, -h],
      ].map(([a, b]) => [Math.round(a * 1000) / 1000, b]),
    })),
    jointY: 0,
    kind: 'foundation-v2',
  }) as FoundationSupportRuleV2;
}

/** Ближайшая точка вне асфальта плюс отступ: для столбов, стоящих на проезжей части. */
function poleMoves(items: Placed[], roads: Polygon[], center: Point2) {
  const onRoad = (p: Point2) => roads.some((r) => inPolygon(p, r));
  const moves = new Map<string, { from: Point2; to: Point2 }>();
  for (const e of items) {
    const from: Point2 = [e.position.x, e.position.z];
    if (!POLES.test(e.assetId) || len(sub(from, center)) > POLE_AREA || !onRoad(from)) continue;
    let to: Point2 | undefined;
    for (let r = 0.25; r <= 12 && !to; r += 0.25)
      for (let k = 0; k < 72 && !to; k++) {
        const d: Point2 = [Math.cos((k * Math.PI) / 36), Math.sin((k * Math.PI) / 36)];
        const edge = add(from, d, r);
        const q = add(edge, d, POLE_CLEARANCE);
        if (!onRoad(edge) && !onRoad(q)) to = round(q);
      }
    if (!to) throw new Error(`${e.entityId}: no ground off the road within 12 m`);
    moves.set(e.entityId, { from, to });
  }
  return moves;
}

async function terrain() {
  const release = JSON.parse(await readFile(RELEASE, 'utf8'));
  const ground = release.groundTerrain;
  const gridBytes = await readFile(`${WORLD_DIR}/${ground.grid.file}`);
  if (createHash('sha256').update(gridBytes).digest('hex') !== ground.grid.sha256)
    throw new Error('Terrain grid hash mismatch: restore LF bytes (git show HEAD:<grid> > <grid>)');
  return { release, grid: validateTerrainGrid(JSON.parse(gridBytes.toString())) };
}

/** Высота seed, как у остальных оград: допустимый Y фундамента над рельефом под стойками. */
function seedHeight(grid: TerrainGrid, fence: Placed) {
  const module = fence.assetId === FENCE_LONG.assetId ? FENCE_LONG : FENCE_SHORT;
  const owner = { ...fence, position: { ...fence.position, y: 0 } } as BuildingInstance;
  return planSupportPlacement(grid, supportRule(module), owner).minimumY;
}

function svg(
  recipe: GroundRecipe,
  all: Verge[],
  fences: Placed[],
  removed: Placed[],
  marks: Point2[][],
) {
  const path = (ring: Point2[]) => 'M' + ring.map(([x, z]) => `${x} ${z}`).join('L') + 'Z';
  let body = '';
  for (const layer of recipe.layers)
    for (const poly of layer.polygons as Polygon[])
      if (poly[0].some(([x, z]) => Math.abs(x) < 110 && Math.abs(z) < 110))
        body += `<path d="${poly.map(path).join('')}" fill="${layer.color}" fill-rule="evenodd"/>`;
  for (const m of marks) body += `<path d="${path(m)}" fill="#ffffff"/>`;
  for (const v of all) body += `<path d="${path(v.strip)}" fill="#3c9a3c" opacity="0.8"/>`;
  const seg = (e: Placed, color: string, half: number) => {
    const a = 2 * Math.atan2(e.rotation.y, e.rotation.w);
    const u = [Math.cos(a), -Math.sin(a)];
    return `<line x1="${e.position.x - u[0] * half}" y1="${e.position.z - u[1] * half}" x2="${e.position.x + u[0] * half}" y2="${e.position.z + u[1] * half}" stroke="${color}" stroke-width="0.35"/>`;
  };
  for (const e of removed) body += seg(e, '#ff2020', e.assetId === 'fence-long' ? 2 : 0.25);
  for (const e of fences) body += seg(e, '#2040ff', e.assetId === FENCE_LONG.assetId ? 2 : 0.5);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="1100" viewBox="-110 -110 220 220">${body}</svg>`;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const layoutIndex = args.indexOf('--layout');
  const sourceText = await readFile(GROUND, 'utf8');
  const sha = createHash('sha256').update(sourceText).digest('hex');
  const original = sha === ORIGINAL_SHA256;
  if (!original && layoutIndex < 0 && !dry)
    throw new Error(`Ground source ${sha} is not the pre-verge version; already applied?`);
  const recipe = JSON.parse(sourceText) as GroundRecipe;
  const layer = (id: string) => {
    const found = recipe.layers.find((l) => l.id === id);
    if (!found) throw new Error(`No ground layer ${id}`);
    return found;
  };
  const { curbs, crosswalks, islands, center } = await loadTraces();
  const all = verges(curbs, crosswalks, layer('road').polygons as Polygon[]);
  // У концов газона асфальт подъезда может заходить за линию ограды: такие модули не ставятся.
  const roads = layer('road').polygons as Polygon[];
  const onRoad = (p: Point2) => roads.some((r) => inPolygon(p, r));
  const fences = all.flatMap((v) =>
    fenceChain(v.fence, `fence-ring-${v.quadrant.toLowerCase()}`).filter((f) => {
      const a = 2 * Math.atan2(f.rotation.y, f.rotation.w);
      const half = (f.assetId === FENCE_LONG.assetId ? FENCE_LONG : FENCE_SHORT).length / 2;
      const u: Point2 = [Math.cos(a) * half, -Math.sin(a) * half];
      const c: Point2 = [f.position.x, f.position.z];
      return ![add(c, u, -1), c, add(c, u)].some(onRoad);
    }),
  );

  if (layoutIndex >= 0) {
    const outIndex = args.indexOf('--out');
    if (outIndex < 0) throw new Error('--layout requires --out <edited.json>');
    const exported = JSON.parse(await readFile(args[layoutIndex + 1], 'utf8'));
    const items: Placed[] = exported.instances;
    if (!Array.isArray(items)) throw new Error('Export has no instances');
    const removed = new Set(
      replacedFences(
        items,
        all.map((v) => v.curb),
      ).map((e) => e.entityId),
    );
    const ids = new Set(items.map((e) => e.entityId));
    const added = fences.filter((f) => !ids.has(f.entityId));
    const { release, grid } = await terrain();
    const moves = poleMoves(items, layer('road').polygons as Polygon[], center);
    for (const e of items) {
      const move = moves.get(e.entityId);
      if (!move) continue;
      e.position.y = canonicalHeight(release.groundTerrain, grid, {
        ...e,
        position: { x: move.to[0], y: 0, z: move.to[1] },
      } as BuildingInstance);
      e.position.x = move.to[0];
      e.position.z = move.to[1];
    }
    exported.instances = [
      ...items.filter((e) => !removed.has(e.entityId)),
      ...added.map((f) => ({
        ...f,
        position: { ...f.position, y: seedHeight(grid, f) },
        enabled: true,
        instanceRevision: 1,
      })),
    ];
    await writeFile(args[outIndex + 1], JSON.stringify(exported, null, 2) + '\n');
    console.log(
      `layout: removed ${removed.size} fences, added ${added.length}, moved ${moves.size} poles`,
    );
    return;
  }

  const seedText = await readFile(SEED, 'utf8');
  const seed = JSON.parse(seedText);
  if (JSON.stringify(seed, null, 2) + '\n' !== seedText.replace(/\r\n/g, '\n'))
    throw new Error('Seed formatting is not JSON.stringify(…, 2); refusing to rewrite');
  const removed = replacedFences(
    seed.buildings,
    all.map((v) => v.curb),
  );
  const moves = poleMoves(seed.buildings, layer('road').polygons as Polygon[], center);

  // Островки: светлые площадки убираются, вместо них разметка.
  const islandLayer = layer('islands');
  const painted = islands.flatMap((t) => {
    const last = t.points[t.points.length - 1];
    const open = len(sub(t.points[0], last)) < 1 ? t.points.slice(0, -1) : t.points;
    return paintedIsland(ccw(smoothTrace(open, 1, true)), center);
  });

  // Центральный газон до бордюра.
  const layoutRecipe = JSON.parse(await readFile(LAYOUT, 'utf8'));
  const lawnRadius = Math.round((layoutRecipe.roundabout.inner - CURB) * 100) / 100;
  const lawn = circle(center, lawnRadius);
  const central = (id: string) =>
    (layer(id).polygons as Polygon[]).findIndex(
      ([outer]) => Math.max(...outer.map((p) => len(sub(p, center)))) < lawnRadius,
    );
  const centralIds = ['park', 'green'].map((id) => [id, central(id)] as const);

  console.log(
    all.map((v) => `${v.quadrant} ${v.name}: ${lengthOf(v.curb).toFixed(1)} m`).join('\n') +
      `\nfences: remove ${removed.length}, add ${fences.length} (${fences.filter((f) => f.assetId === FENCE_LONG.assetId).length} long)` +
      `\nislands: ${islandLayer.polygons.length} → painted ${painted.length} marks` +
      `\ncentral lawn r=${lawnRadius}: ${centralIds.map(([id, i]) => `${id}#${i}`).join(', ')}` +
      `\npoles off the road: ${[...moves].map(([id, m]) => `${id} ${len(sub(m.to, m.from)).toFixed(2)} m`).join(', ')}`,
  );
  await mkdir('dist/preview', { recursive: true });
  await writeFile('dist/preview/ring-verge.svg', svg(recipe, all, fences, removed, painted));
  if (dry) return;

  for (const [id, index] of centralIds) {
    if (index < 0) throw new Error(`No central ${id} polygon`);
    (layer(id).polygons as Polygon[])[index] = [lawn];
  }
  islandLayer.polygons = [];
  (layer('green').polygons as Polygon[]).push(...all.map((v) => [v.strip]));
  (layer('markings').polygons as Polygon[]).push(...painted.map((m) => [m]));
  await writeFile(GROUND, JSON.stringify(recipe) + '\n');

  const gone = new Set(removed.map((e) => e.entityId));
  seed.buildings = [...seed.buildings.filter((e: Placed) => !gone.has(e.entityId)), ...fences];

  // Выпуск рельефа: фундаменты и политика новых модулей, высоты seed новых оград.
  const { release, grid } = await terrain();
  const ground = release.groundTerrain;
  for (const module of [FENCE_LONG, FENCE_SHORT]) {
    if (ground.supports.some((r: { assetId: string }) => r.assetId === module.assetId))
      throw new Error(`Release already has ${module.assetId}`);
    ground.supports.push(supportRule(module));
    ground.placementModels.push({
      assetId: module.assetId,
      policy: { kind: 'foundation', maximumVisibleHeight: 0.6 },
    });
  }
  ground.placementModels.sort((a: { assetId: string }, b: { assetId: string }) =>
    a.assetId.localeCompare(b.assetId),
  );
  for (const id of gone) delete ground.seedY[id];
  for (const e of seed.buildings as Placed[]) {
    const move = moves.get(e.entityId);
    if (!move) continue;
    const y = canonicalHeight(ground, grid, {
      ...e,
      position: { x: move.to[0], y: 0, z: move.to[1] },
    } as BuildingInstance);
    if (Object.hasOwn(ground.seedY, e.entityId)) ground.seedY[e.entityId] = y;
    else e.position.y = y;
    e.position.x = move.to[0];
    e.position.z = move.to[1];
  }
  for (const f of fences) ground.seedY[f.entityId] = seedHeight(grid, f);
  await writeFile(SEED, JSON.stringify(seed, null, 2) + '\n');
  await writeFile(RELEASE, JSON.stringify(release, null, 2) + '\n');

  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  const placement = JSON.parse(await readFile(PLACEMENT, 'utf8'));
  for (const module of [FENCE_LONG, FENCE_SHORT]) {
    catalog.assets[module.assetId] = `objects/${module.assetId}/asset.json`;
    if (!placement.assetIds.includes(module.assetId)) placement.assetIds.push(module.assetId);
  }
  catalog.assets = Object.fromEntries(
    Object.entries(catalog.assets as Record<string, string>).sort(([a], [b]) => a.localeCompare(b)),
  );
  placement.assetIds.sort();
  await writeFile(CATALOG, JSON.stringify(catalog, null, 2) + '\n');
  await writeFile(PLACEMENT, JSON.stringify(placement, null, 2) + '\n');
  console.log(`written ${GROUND}, ${SEED}, ${RELEASE}, ${CATALOG}, ${PLACEMENT}`);
}

await main();
