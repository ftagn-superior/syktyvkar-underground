/**
 * Разовое расширение проезжей части старой области ring-block (X −269…331, Z −745…131).
 *
 *   pnpm world:ground:widen            # применить к content/ (только к исходной версии основания)
 *   pnpm world:ground:widen -- --dry   # отчёт без записи
 *
 * Дороги (`road`) расширяются на 1,5 м с каждой стороны, проезды (`service`) — на 0,65 м
 * (3,7 → 5 м). Внутри диска кольца R = 47 м ничего не меняется, к 62 м расширение плавно
 * нарастает до полного. Исходные полигоны остаются, расширенный контур добавляется поверх
 * в тот же слой. Линии разметки раздвигаются пропорционально новой ширине, зебры
 * достраиваются полосами того же шага до новой бровки. Деревья, кусты и мелкие объекты,
 * оказавшиеся на новом асфальте, сдвигаются наружу; их Y в каноническом seed
 * корректируется по сетке высот. Ограды и стены не двигаются.
 *
 * Для действующей БД тот же сдвиг применяется к экспорту размещений:
 *   pnpm world:ground:widen -- --layout <export.json> --out <edited.json>
 * затем `make map-patch`/`map-apply` (docs/operations.md, «Файловые патчи размещений»).
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Point2 } from '@su/terrain-build/triangulate';
import type { GroundRecipe } from './city.js';
import {
  Field,
  fieldPolygons,
  pointInRings,
  polygonDistance,
  rectDistance,
} from './ground-contour.js';

const GROUND = 'content/buildings/ring-block/ring-block-ground/source.json';
const SEED = 'content/worlds/ring-block/cells/0_0.json';
const RELEASE = 'content/worlds/ring-block/terrain-release.json';
const GRID = 'content/worlds/ring-block/terrain-expansion/grid.json';
/** SHA-256 основания до расширения (main 523197b): повторный запуск не расширяет дважды. */
const ORIGINAL_SHA256 = 'a714b5f5885c79048114b58e9ff7eb2baf21818e67b7b75eedee865d5d54eaa6';
export const OLD_MIN: Point2 = [-269, -745];
export const OLD_MAX: Point2 = [331, 131];
export const ROAD_GROW = 1.5;
export const SERVICE_GROW = 0.65;
const RING_KEEP = 47;
const RING_FULL = 62;
const CELL = 125;
const WORLD_MIN: Point2 = [-1500, -850];

/** Доля полного расширения: 0 в диске кольца, плавный рост до 1 к RING_FULL. */
export function taper(x: number, z: number) {
  const t = Math.min(1, Math.max(0, (Math.hypot(x, z) - RING_KEEP) / (RING_FULL - RING_KEEP)));
  return t * t * (3 - 2 * t);
}

type Polygon = Point2[][];
const sub = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Point2, b: Point2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Point2) => Math.hypot(a[0], a[1]);

function centroid(ring: readonly Point2[]): Point2 {
  let x = 0,
    z = 0;
  for (const p of ring) {
    x += p[0];
    z += p[1];
  }
  return [x / ring.length, z / ring.length];
}
function axis(ring: readonly Point2[]) {
  let best = 0,
    u: Point2 = [1, 0];
  for (let i = 0; i < ring.length; i++) {
    const d = sub(ring[(i + 1) % ring.length], ring[i]),
      l = len(d);
    if (l > best) {
      best = l;
      u = [d[0] / l, d[1] / l];
    }
  }
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return { u, n: [-u[1], u[0]] as Point2, length: best, width: Math.abs(area / 2) / best };
}
/** Расстояние вдоль луча до первого пересечения с контуром. */
function rayHit(origin: Point2, dir: Point2, rings: Polygon) {
  let best = Infinity;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const e = sub(b, a);
      const den = dir[0] * e[1] - dir[1] * e[0];
      if (Math.abs(den) < 1e-12) continue;
      const w = sub(a, origin);
      const t = (w[0] * e[1] - w[1] * e[0]) / den;
      const s = (w[0] * dir[1] - w[1] * dir[0]) / den;
      if (t > 1e-6 && s >= 0 && s <= 1) best = Math.min(best, t);
    }
  return best;
}

export interface WidenContext {
  roads: Polygon[];
  services: Polygon[];
  islands: Polygon[];
}
/** Знаковое расстояние до расширенного асфальта (дороги и проезды). */
export function widenedDistance(ctx: WidenContext, x: number, z: number) {
  const k = taper(x, z);
  let best = Infinity;
  for (const p of ctx.roads) best = Math.min(best, polygonDistance(x, z, p) - ROAD_GROW * k);
  for (const p of ctx.services) best = Math.min(best, polygonDistance(x, z, p) - SERVICE_GROW * k);
  return best;
}
function originalDistance(ctx: WidenContext, x: number, z: number) {
  let best = Infinity;
  for (const p of [...ctx.roads, ...ctx.services]) best = Math.min(best, polygonDistance(x, z, p));
  return best;
}
const inAny = (polygons: Polygon[], p: Point2) =>
  polygons.some((poly) => pointInRings(p[0], p[1], poly));

interface Placed {
  entityId: string;
  assetId: string;
  position: { x: number; y: number; z: number };
}
const MOVABLE = /^(tree-|bush-|bench|lamp-|bollard|bus-stop|traffic-light|playground|water-kiosk)/;
const CLEARANCE = 0.6;

/** Сдвиги объектов с нового асфальта: entityId → новая позиция XZ. */
export function objectMoves(ctx: WidenContext, placed: Placed[]) {
  const moves = new Map<string, { from: Point2; to: Point2 }>();
  const skipped: string[] = [];
  const original = [...ctx.roads, ...ctx.services];
  for (const item of placed) {
    if (!MOVABLE.test(item.assetId)) continue;
    const p: Point2 = [item.position.x, item.position.z];
    if (p[0] < OLD_MIN[0] || p[0] > OLD_MAX[0] || p[1] < OLD_MIN[1] || p[1] > OLD_MAX[1]) continue;
    const before = widenedDistance(ctx, p[0], p[1]);
    if (before >= CLEARANCE || before > originalDistance(ctx, p[0], p[1]) - 0.1) continue;
    if (inAny(original, p) || inAny(ctx.islands, p)) continue;
    let q: Point2 = p;
    for (let step = 0; step < 12; step++) {
      const d = widenedDistance(ctx, q[0], q[1]);
      if (d >= CLEARANCE) break;
      const e = 0.05;
      const g: Point2 = [
        (widenedDistance(ctx, q[0] + e, q[1]) - widenedDistance(ctx, q[0] - e, q[1])) / (2 * e),
        (widenedDistance(ctx, q[0], q[1] + e) - widenedDistance(ctx, q[0], q[1] - e)) / (2 * e),
      ];
      const l = len(g) || 1;
      q = [q[0] + (g[0] / l) * (CLEARANCE - d + 0.02), q[1] + (g[1] / l) * (CLEARANCE - d + 0.02)];
    }
    const moved = len(sub(q, p));
    if (widenedDistance(ctx, q[0], q[1]) < CLEARANCE - 0.05 || moved > 3) {
      skipped.push(item.entityId);
      continue;
    }
    moves.set(item.entityId, {
      from: p,
      to: [Math.round(q[0] * 1000) / 1000, Math.round(q[1] * 1000) / 1000],
    });
  }
  return { moves, skipped };
}

export function terrainHeight(
  grid: { origin: { x: number; z: number }; spacing: number; columns: number; heights: number[] },
  x: number,
  z: number,
) {
  const fx = (x - grid.origin.x) / grid.spacing,
    fz = (z - grid.origin.z) / grid.spacing;
  const i = Math.floor(fx),
    j = Math.floor(fz),
    tx = fx - i,
    tz = fz - j;
  const h = (a: number, b: number) => grid.heights[b * grid.columns + a];
  return (
    (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - tz) +
    (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * tz
  );
}

function widenLayer(polygons: Polygon[], grow: number) {
  const out: Polygon[] = [];
  let dropped = 0;
  for (let x0 = WORLD_MIN[0]; x0 < OLD_MAX[0]; x0 += CELL)
    for (let z0 = WORLD_MIN[1]; z0 < OLD_MAX[1]; z0 += CELL) {
      const tile = { x0, z0, x1: x0 + CELL, z1: z0 + CELL, h: 0.25 };
      if (tile.x1 <= OLD_MIN[0] || tile.z1 <= OLD_MIN[1]) continue;
      const field = new Field(tile, 1);
      for (const polygon of polygons) field.polygon(polygon, grow, (x, z) => grow * taper(x, z));
      field.intersect((x, z) => rectDistance(x, z, OLD_MIN, OLD_MAX));
      const result = fieldPolygons(field, { tolerance: 0.03, minArea: 0.05 });
      out.push(...result.polygons);
      dropped += result.dropped;
    }
  return { polygons: out, dropped };
}

/** Раздвинуть линии разметки и достроить зебры. */
function adjustMarkings(ctx: WidenContext, markings: Polygon[]) {
  const roadDistance = (p: Point2) => {
    const k = taper(p[0], p[1]);
    let best = Infinity;
    for (const poly of ctx.roads)
      best = Math.min(best, polygonDistance(p[0], p[1], poly) - ROAD_GROW * k);
    return best;
  };
  let shifted = 0;
  const out: Polygon[] = [];
  const bars: { index: number; c: Point2; u: Point2; n: Point2; length: number }[] = [];
  for (const [index, polygon] of markings.entries()) {
    const ring = polygon[0];
    const c = centroid(ring);
    const { u, n, length, width } = axis(ring);
    if (taper(c[0], c[1]) === 0 || ring.length !== 4) {
      out.push(polygon);
      continue;
    }
    if (width > 0.4 && width < 0.6 && length > 2 && length < 6) {
      bars.push({ index, c, u, n, length });
      out.push(polygon);
      continue;
    }
    if (width > 0.3) {
      out.push(polygon);
      continue;
    }
    const owners = ctx.roads.filter((poly) => pointInRings(c[0], c[1], poly));
    if (owners.length !== 1) {
      out.push(polygon);
      continue;
    }
    // Поперечное сечение в трёх точках вдоль линии должно совпадать.
    const sections = [-1, 0, 1].map((t) => {
      const o: Point2 = [c[0] + u[0] * t, c[1] + u[1] * t];
      const a = rayHit(o, n, owners[0]),
        b = rayHit(o, [-n[0], -n[1]], owners[0]);
      return { a, b, w: a + b };
    });
    const { a, b, w } = sections[1];
    if (!Number.isFinite(w) || w < 3 || w > 30 || sections.some((s) => Math.abs(s.w - w) > 1)) {
      out.push(polygon);
      continue;
    }
    const grow = ROAD_GROW * taper(c[0], c[1]);
    const offset = ((b - a) / 2) * ((2 * grow) / w);
    out.push(
      polygon.map((r) => r.map(([x, z]) => [x + n[0] * offset, z + n[1] * offset] as Point2)),
    );
    shifted++;
  }
  // Зебры: группы параллельных полос с общим шагом.
  const parent = bars.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < bars.length; i++)
    for (let j = i + 1; j < bars.length; j++) {
      const A = bars[i],
        B = bars[j],
        d = sub(B.c, A.c);
      if (
        Math.abs(dot(A.u, B.u)) > 0.97 &&
        Math.abs(dot(d, A.u)) < 0.6 &&
        Math.abs(dot(d, A.n)) < 1.6
      )
        parent[find(i)] = find(j);
    }
  const groups = new Map<number, typeof bars>();
  for (const [i, bar] of bars.entries()) {
    const key = find(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(bar);
  }
  let added = 0;
  const centres = bars.map((b) => b.c);
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const n = group[0].n;
    group.sort((a, b) => dot(a.c, n) - dot(b.c, n));
    const steps = group
      .slice(1)
      .map((b, i) => dot(sub(b.c, group[i].c), n))
      .sort((a, b) => a - b);
    const pitch = steps[Math.floor(steps.length / 2)];
    if (pitch < 0.8 || pitch > 1.6) continue;
    for (const [end, sign] of [
      [group[0], -1],
      [group[group.length - 1], 1],
    ] as const) {
      for (let k = 1; k <= 4; k++) {
        const shift: Point2 = [n[0] * pitch * k * sign, n[1] * pitch * k * sign];
        const c: Point2 = [end.c[0] + shift[0], end.c[1] + shift[1]];
        const tips: Point2[] = [-1, 1].map((s) => [
          c[0] + (end.u[0] * end.length * s) / 2,
          c[1] + (end.u[1] * end.length * s) / 2,
        ]);
        if (![c, ...tips].every((p) => roadDistance(p) < -0.3)) break;
        if (inAny(ctx.islands, c) || centres.some((q) => len(sub(q, c)) < pitch * 0.6)) break;
        out.push(
          markings[end.index].map((r) => r.map(([x, z]) => [x + shift[0], z + shift[1]] as Point2)),
        );
        centres.push(c);
        added++;
      }
    }
  }
  return { markings: out, shifted, added };
}

async function main() {
  const args = process.argv.slice(2);
  const layoutIndex = args.indexOf('--layout');
  const sourceText = await readFile(GROUND, 'utf8');
  const recipe = JSON.parse(sourceText) as GroundRecipe;
  const layer = (id: string) => recipe.layers.find((l) => l.id === id)!.polygons as Polygon[];
  const original = createHash('sha256').update(sourceText).digest('hex') === ORIGINAL_SHA256;

  if (layoutIndex >= 0) {
    // Экспорт БД: сдвиги считаются по исходным полигонам из git-истории основания.
    const outIndex = args.indexOf('--out');
    if (outIndex < 0) throw new Error('--layout requires --out <edited.json>');
    const base = original ? recipe : await originalRecipe();
    const ctx = context(base);
    const exported = JSON.parse(await readFile(args[layoutIndex + 1], 'utf8'));
    const grid = JSON.parse(await readFile(GRID, 'utf8'));
    const items: Placed[] = findPlaced(exported);
    const { moves, skipped } = objectMoves(ctx, items);
    for (const item of items) {
      const move = moves.get(item.entityId);
      if (!move) continue;
      item.position.y +=
        terrainHeight(grid, move.to[0], move.to[1]) -
        terrainHeight(grid, move.from[0], move.from[1]);
      item.position.x = move.to[0];
      item.position.z = move.to[1];
    }
    await writeFile(args[outIndex + 1], JSON.stringify(exported, null, 2) + '\n');
    console.log(`layout: moved ${moves.size}, skipped ${skipped.length} ${skipped.join(' ')}`);
    return;
  }

  if (!original)
    throw new Error(
      'Ground source is not the original pre-widening version; roads already widened',
    );
  const ctx = context(recipe);
  const roads = widenLayer(ctx.roads, ROAD_GROW);
  const services = widenLayer(ctx.services, SERVICE_GROW);
  const marks = adjustMarkings(ctx, layer('markings'));
  const seedText = await readFile(SEED, 'utf8');
  const seed = JSON.parse(seedText);
  if (JSON.stringify(seed, null, 2) + '\n' !== seedText.replace(/\r\n/g, '\n'))
    throw new Error('Seed formatting is not JSON.stringify(…, 2); refusing to rewrite');
  const { moves, skipped } = objectMoves(ctx, seed.buildings);
  console.log(
    `road +${roads.polygons.length} (dropped ${roads.dropped}), service +${services.polygons.length} (dropped ${services.dropped}), ` +
      `markings shifted ${marks.shifted}, zebra bars added ${marks.added}, objects moved ${moves.size}, skipped ${skipped.length} ${skipped.join(' ')}`,
  );
  for (const [id, m] of moves)
    console.log(`  ${id}: ${m.from.map((v) => v.toFixed(2))} → ${m.to.map((v) => v.toFixed(2))}`);
  if (args.includes('--dry')) return;

  layer('road').push(...roads.polygons);
  layer('service').push(...services.polygons);
  recipe.layers.find((l) => l.id === 'markings')!.polygons = marks.markings;
  await writeFile(GROUND, JSON.stringify(recipe));

  const grid = JSON.parse(await readFile(GRID, 'utf8'));
  const releaseText = await readFile(RELEASE, 'utf8');
  const start = releaseText.indexOf('"seedY": {');
  const end = releaseText.indexOf('}', start);
  let block = releaseText.slice(start, end);
  for (const item of seed.buildings as Placed[]) {
    const move = moves.get(item.entityId);
    if (!move) continue;
    const dy =
      terrainHeight(grid, move.to[0], move.to[1]) - terrainHeight(grid, move.from[0], move.from[1]);
    item.position.x = move.to[0];
    item.position.z = move.to[1];
    const pattern = new RegExp(`("${item.entityId}": )(-?[0-9.e+-]+)`);
    const match = block.match(pattern);
    if (!match) throw new Error(`seedY is missing ${item.entityId}`);
    block = block.replace(pattern, `$1${Number(match[2]) + dy}`);
  }
  await writeFile(SEED, JSON.stringify(seed, null, 2) + '\n');
  await writeFile(RELEASE, releaseText.slice(0, start) + block + releaseText.slice(end));
}

function context(recipe: GroundRecipe): WidenContext {
  const layer = (id: string) => recipe.layers.find((l) => l.id === id)!.polygons as Polygon[];
  return { roads: layer('road'), services: layer('service'), islands: layer('islands') };
}
async function originalRecipe(): Promise<GroundRecipe> {
  const { execFileSync } = await import('node:child_process');
  return JSON.parse(
    execFileSync('git', ['show', `523197b:${GROUND}`], { encoding: 'utf8', maxBuffer: 1 << 26 }),
  );
}
/** Экспорт размещений: любые объекты с entityId, assetId и position. */
function findPlaced(value: unknown, out: Placed[] = []): Placed[] {
  if (Array.isArray(value)) for (const v of value) findPlaced(v, out);
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (
      typeof o.entityId === 'string' &&
      typeof o.assetId === 'string' &&
      o.position &&
      typeof o.position === 'object'
    )
      out.push(o as unknown as Placed);
    else for (const v of Object.values(o)) findPlaced(v, out);
  }
  return out;
}

if (
  import.meta.url ===
    `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}` ||
  process.argv[1]?.endsWith('widen-roads.ts')
)
  await main();
