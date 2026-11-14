/**
 * Проход по улицам старой области ring-block (X −269…331, Z −745…131) по кадрам Street View 2021.
 * Кольцо (R < 110 м) правится отдельно: `pnpm world:ground:ring-verge`.
 *
 *   pnpm world:ground:streets -- --init     # собрать street-pass.json из снимка OSM (авторский шаг)
 *   pnpm world:ground:streets -- --dry      # отчёт и SVG dist/preview/street-pass.svg без записи
 *   pnpm world:ground:streets               # применить к content/ (только к исходной версии основания)
 *
 * Что меняется (параметры улиц — в `content/worlds/ring-block/street-pass.json`):
 * - газон от бордюра шириной `verge` м вдоль выбранных улиц, как на фото (было — голая плита);
 *   у переходов, светофоров и остановок газон не кладётся;
 * - ограды, стоящие посреди проезжей части, удаляются; задевающие асфальт или проезды
 *   сдвигаются поперёк себя до 1,5 м;
 * - светофоры и фонари на асфальте переносятся за бордюр (светофоры OSM стоят на оси дороги);
 * - посередине нового газона — ряд деревьев (берёзы и лиственные) с шагом `trees` м;
 * - вдоль улиц с `lamps` ставятся фонари `lamp-street` с шагом `lampSpacing` м на газоне у
 *   бордюра, плафоном к дороге.
 *
 * Для действующей БД те же правки применяются к экспорту размещений:
 *   pnpm world:ground:streets -- --layout <export.json> --out <edited.json>
 * затем `make map-patch`/`map-apply` (docs/operations.md, «Файловые патчи размещений»).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { validateTerrainGrid, type TerrainGrid } from '@su/contracts';
import type { Point2 } from '@su/terrain-build/triangulate';
import type { GroundRecipe } from './city.js';
import { Field, fieldPolygons, rectDistance } from './ground-contour.js';
import { seedHeight as canonicalHeight } from './seed-height.js';
import { OLD_MAX, OLD_MIN } from './widen-roads.js';

const GROUND = 'content/buildings/ring-block/ring-block-ground/source.json';
const WORLD_DIR = 'content/worlds/ring-block';
const SEED = `${WORLD_DIR}/cells/0_0.json`;
const RELEASE = `${WORLD_DIR}/terrain-release.json`;
const CONFIG = `${WORLD_DIR}/street-pass.json`;
const OSM_SNAPSHOT = 'output/expansion-ground/osm.json';
/** SHA-256 основания до прохода (после `world:ground:ring-verge`): повторный запуск не нужен. */
const ORIGINAL_SHA256 = 'e5a9e6d1d44e814654bb384e80302b6dcf413a6618ea96859071d319e3db6392';

const CURB = 0.3;
/** Кольцо правится своим инструментом. */
const RING_KEEP = 110;
/** Без газона и новых фонарей вокруг переходов и остановок. */
const CROSSING_CLEAR = 7;
const STOP_CLEAR = 9;
/** Поперёк улицы газон ищется не дальше этого от оси. */
const CORRIDOR = 18;
const TILE = 125;
const FENCE_SHIFT_MAX = 1.5;
const POLE_CLEARANCE = 0.8;
const LAMP_SETBACK = 0.8;
const LAMP_GAP = 14;
/** Деревья: зазор до столбов и до уже стоящих деревьев и кустов. */
const TREE_POLE_GAP = 3.5;
const TREE_KEEP = 5;
/** Породы на газонах по фото: в основном берёзы, реже лиственные. Доли накопительные. */
const TREE_MIX: [number, string][] = [
  [0.35, 'tree-birch-large'],
  [0.65, 'tree-birch-medium'],
  [0.85, 'tree-leaf-large'],
  [1, 'tree-leaf-medium'],
];
const POLES = /^(lamp-street|traffic-light-standard)$/;
const FENCES: Record<string, number> = { 'fence-long': 4, 'fence-short': 0.5 };

type Polygon = Point2[][];
interface Placed {
  entityId: string;
  assetId: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  [key: string]: unknown;
}
interface Street {
  name: string;
  /** Ширина газона от бордюра, м; null — улица не трогается (тротуар у бордюра). */
  verge: number | null;
  /** Газон только внутри прямоугольника [x0, z0, x1, z1]. */
  vergeClip?: [number, number, number, number];
  lamps: 'both' | 'one' | null;
  lampSpacing?: number;
  /** Шаг ряда деревьев посередине газона, м; без поля деревья не сажаются. */
  trees?: number;
  /** Оси улицы в игровых метрах. */
  lines: Point2[][];
}
interface Config {
  formatVersion: 1;
  source: string;
  license: string;
  streets: Street[];
  /** Переходы и светофоры OSM: вокруг них газон не кладётся. */
  crossings: Point2[];
}

const sub = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point2, b: Point2, k = 1): Point2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const len = (a: Point2) => Math.hypot(a[0], a[1]);
const norm = (a: Point2): Point2 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const round = (p: Point2): Point2 => [r3(p[0]), r3(p[1])];
const inOld = ([x, z]: Point2) =>
  x >= OLD_MIN[0] && x <= OLD_MAX[0] && z >= OLD_MIN[1] && z <= OLD_MAX[1];

function inside(p: Point2, ring: readonly Point2[]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i],
      [xj, zj] = ring[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}
/** Быстрая проверка «точка на покрытии»: многоугольники с рамками. */
class Surface {
  private items: { poly: Polygon; b: [number, number, number, number] }[];
  constructor(polygons: Polygon[]) {
    this.items = polygons.map((poly) => {
      const xs = poly[0].map((p) => p[0]),
        zs = poly[0].map((p) => p[1]);
      return {
        poly,
        b: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)],
      };
    });
  }
  has(p: Point2) {
    return this.items.some(
      ({ poly, b }) =>
        p[0] >= b[0] &&
        p[0] <= b[2] &&
        p[1] >= b[1] &&
        p[1] <= b[3] &&
        inside(p, poly[0]) &&
        !poly.slice(1).some((h) => inside(p, h)),
    );
  }
}

function segmentDistance(p: Point2, a: Point2, b: Point2) {
  const d = sub(b, a);
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2 || 1)),
  );
  return len(sub(p, add(a, d, t)));
}
const linesDistance = (p: Point2, lines: Point2[][]) => {
  let best = Infinity;
  for (const line of lines)
    for (let i = 0; i + 1 < line.length; i++)
      best = Math.min(best, segmentDistance(p, line[i], line[i + 1]));
  return best;
};

// ---------- конфигурация из OSM ----------

/** Улицы старой области и параметры по кадрам Street View 2021 (output/streets/sheet-*.jpg). */
const STREETS: Omit<Street, 'lines'>[] = [
  // Запад: газон 2–3 м с деревьями от бордюра до тротуара; восток (СыктГУ) — ряд деревьев на газоне.
  // Севернее Z −90 — кольцо; южнее Z −650 тротуар примыкает к бордюру.
  {
    name: 'Октябрьский проспект',
    verge: 2.5,
    vergeClip: [-300, -650, 0, -90],
    lamps: 'both',
    lampSpacing: 35,
    trees: 8,
  },
  // К западу от кольца — газон и низкая решётка у бордюра; к востоку — мощёные тротуары у бордюра.
  {
    name: 'Коммунистическая улица',
    verge: 2.5,
    vergeClip: [-300, 0, -60, 200],
    lamps: 'both',
    lampSpacing: 35,
    trees: 8,
  },
  { name: 'улица Чернова', verge: 2.5, lamps: 'one', lampSpacing: 40, trees: 8 },
  { name: 'улица Оплеснина', verge: 2.5, lamps: 'one', lampSpacing: 40, trees: 8 },
  { name: 'улица Катаева', verge: 2.5, lamps: 'one', lampSpacing: 40, trees: 8 },
  { name: 'улица Карла Маркса', verge: 2, lamps: 'one', lampSpacing: 40, trees: 8 },
  { name: 'улица Юхнина', verge: 2, lamps: 'one', lampSpacing: 40, trees: 8 },
  // Безымянная жилая улица у X 200, Z −330: деревья и газон с обеих сторон.
  { name: '', verge: 3, lamps: 'one', lampSpacing: 40, trees: 8 },
];

async function init() {
  const ORIGIN = { lat: 61.66386729706631, lon: 50.815951774241576 };
  const SCALE = { lon: 52837.29, lat: 110573.15 };
  const toGame = (n: { lat: number; lon: number }): Point2 =>
    round([(n.lon - ORIGIN.lon) * SCALE.lon, -(n.lat - ORIGIN.lat) * SCALE.lat]);
  const osm = JSON.parse(await readFile(OSM_SNAPSHOT, 'utf8'));
  const elements: any[] = osm.elements ?? osm;
  const streets: Street[] = STREETS.map((s) => ({ ...s, lines: [] }));
  for (const e of elements) {
    if (e.type !== 'way' || !['primary', 'tertiary', 'residential'].includes(e.tags?.highway))
      continue;
    const name = e.tags.name ?? '';
    const street = streets.find((s) => s.name === name);
    if (!street || (name === '' && e.tags.highway !== 'residential')) continue;
    const line: Point2[] = (e.geometry ?? []).map(toGame);
    if (!line.some(inOld)) continue;
    street.lines.push(line);
  }
  // Пешеходные переходы — линии `footway=crossing` поперёк дороги: их вершины и середины.
  const crossings: Point2[] = [];
  for (const e of elements) {
    if (e.type !== 'way' || (e.tags?.footway !== 'crossing' && e.tags?.crossing === undefined))
      continue;
    const line: Point2[] = (e.geometry ?? []).map(toGame);
    for (let i = 0; i < line.length; i++) {
      crossings.push(line[i]);
      if (i + 1 < line.length) crossings.push(round(add(line[i], sub(line[i + 1], line[i]), 0.5)));
    }
  }
  for (let i = crossings.length - 1; i >= 0; i--) if (!inOld(crossings[i])) crossings.splice(i, 1);
  const config: Config = {
    formatVersion: 1,
    source: 'OpenStreetMap via Overpass API (снимок output/expansion-ground/osm.json, 14.11.2026)',
    license: 'ODbL 1.0, © OpenStreetMap contributors',
    streets,
    crossings,
  };
  await writeFile(CONFIG, JSON.stringify(config) + '\n');
  console.log(
    streets.map((s) => `${s.name || '(без имени)'}: ${s.lines.length} линий`).join('\n') +
      `\ncrossings: ${crossings.length} → ${CONFIG}`,
  );
}

// ---------- газон ----------

function verges(config: Config, roads: Polygon[], stops: Point2[]) {
  const selected = config.streets.filter((s) => s.verge !== null && s.lines.length);
  const maxWidth = Math.max(...selected.map((s) => s.verge!));
  const band = CURB + maxWidth + 2;
  const out: Polygon[] = [];
  let dropped = 0;
  for (let x0 = OLD_MIN[0] - 1; x0 < OLD_MAX[0]; x0 += TILE)
    for (let z0 = OLD_MIN[1] - 1; z0 < OLD_MAX[1]; z0 += TILE) {
      const tile = { x0, z0, x1: x0 + TILE, z1: z0 + TILE, h: 0.25 };
      const road = new Field(tile, band);
      for (const polygon of roads) road.polygon(polygon);
      const verge = new Field(tile, band);
      verge.values.fill(band);
      for (let j = 0; j < verge.nz; j++)
        for (let i = 0; i < verge.nx; i++) {
          const k = j * verge.nx + i;
          const p: Point2 = [x0 + i * tile.h, z0 + j * tile.h];
          const d = road.values[k];
          if (d < CURB - 0.5 || d > CURB + maxWidth + 0.5) continue;
          let best = band;
          for (const s of selected) {
            const corridor = linesDistance(p, s.lines) - CORRIDOR;
            if (corridor > 0.5) continue;
            const clip = s.vergeClip
              ? rectDistance(
                  p[0],
                  p[1],
                  [s.vergeClip[0], s.vergeClip[1]],
                  [s.vergeClip[2], s.vergeClip[3]],
                )
              : -band;
            best = Math.min(best, Math.max(d - CURB - s.verge!, CURB - d, corridor, clip));
          }
          const clear = Math.max(
            RING_KEEP - len(p),
            ...config.crossings.map((c) => CROSSING_CLEAR - len(sub(p, c))),
            ...stops.map((c) => STOP_CLEAR - len(sub(p, c))),
            rectDistance(p[0], p[1], OLD_MIN, OLD_MAX),
          );
          verge.values[k] = Math.max(best, clear);
        }
      const result = fieldPolygons(verge, { tolerance: 0.05, minArea: 1 });
      out.push(...result.polygons);
      dropped += result.dropped;
    }
  return { polygons: out, dropped };
}

// ---------- объекты ----------

function yawOf(e: Placed) {
  return 2 * Math.atan2(e.rotation.y, e.rotation.w);
}
function fencePoints(e: Placed, shift = 0): Point2[] {
  const a = yawOf(e);
  const u: Point2 = [Math.cos(a), -Math.sin(a)];
  const n: Point2 = [-u[1], u[0]];
  const c = add([e.position.x, e.position.z], n, shift);
  const half = FENCES[e.assetId] / 2;
  return [-1, -0.5, 0, 0.5, 1].map((t) => add(c, u, t * half * 0.97));
}

interface Plan {
  removed: Set<string>;
  moves: Map<string, { from: Point2; to: Point2 }>;
  lamps: Placed[];
}

function planObjects(
  config: Config,
  items: Placed[],
  road: Surface,
  paved: Surface,
  stops: Point2[],
): Plan {
  const removed = new Set<string>();
  const moves = new Map<string, { from: Point2; to: Point2 }>();
  const area = (p: Point2) => inOld(p) && len(p) > RING_KEEP;
  for (const e of items) {
    const at: Point2 = [e.position.x, e.position.z];
    if (!area(at)) continue;
    if (FENCES[e.assetId] !== undefined) {
      const pts = fencePoints(e);
      if (!pts.some((p) => paved.has(p))) continue;
      // Секция посреди проезжей части — мусор импорта: на фото там ограды нет.
      if (pts.filter((p) => road.has(p)).length >= 3) {
        removed.add(e.entityId);
        continue;
      }
      let best: number | undefined;
      for (let s = 0.05; s <= FENCE_SHIFT_MAX + 1e-9 && best === undefined; s += 0.05)
        for (const sign of [1, -1])
          if (best === undefined && !fencePoints(e, s * sign).some((p) => paved.has(p)))
            best = s * sign;
      if (best === undefined) {
        removed.add(e.entityId);
        continue;
      }
      const a = yawOf(e);
      const n: Point2 = [Math.sin(a), Math.cos(a)];
      moves.set(e.entityId, { from: at, to: round(add(at, n, best)) });
    } else if (POLES.test(e.assetId) && paved.has(at)) {
      let to: Point2 | undefined;
      for (let r = 0.25; r <= 12 && !to; r += 0.25)
        for (let k = 0; k < 72 && !to; k++) {
          const d: Point2 = [Math.cos((k * Math.PI) / 36), Math.sin((k * Math.PI) / 36)];
          const edge = add(at, d, r);
          const q = add(edge, d, POLE_CLEARANCE);
          if (!paved.has(edge) && !paved.has(q)) to = round(q);
        }
      if (!to) throw new Error(`${e.entityId}: no ground off the asphalt within 12 m`);
      moves.set(e.entityId, { from: at, to });
    }
  }

  // Новые фонари: с шагом вдоль оси, на газоне у бордюра, плафоном к дороге.
  const poles: Point2[] = items
    .filter((e) => POLES.test(e.assetId))
    .map((e) => moves.get(e.entityId)?.to ?? [e.position.x, e.position.z]);
  const lamps: Placed[] = [];
  for (const s of config.streets) {
    if (!s.lamps) continue;
    const spacing = s.lampSpacing ?? 35;
    for (const line of s.lines) {
      let carry = spacing / 2;
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i],
          b = line[i + 1],
          d = len(sub(b, a));
        const u = norm(sub(b, a));
        for (let t = carry; t < d; t += spacing) {
          const c = add(a, u, t);
          const sides = s.lamps === 'both' ? [1, -1] : [1];
          for (const side of sides) {
            const n: Point2 = [-u[1] * side, u[0] * side];
            let curb: Point2 | undefined;
            for (let k = 0.25; k <= 25; k += 0.25) {
              const p = add(c, n, k);
              if (!road.has(p) && road.has(add(c, n, k - 0.25))) {
                curb = p;
                break;
              }
            }
            if (!curb) continue;
            const p = round(add(curb, n, LAMP_SETBACK));
            if (
              !area(p) ||
              paved.has(p) ||
              config.crossings.some((x) => len(sub(p, x)) < CROSSING_CLEAR) ||
              stops.some((x) => len(sub(p, x)) < STOP_CLEAR) ||
              [...poles, ...lamps.map((l): Point2 => [l.position.x, l.position.z])].some(
                (x) => len(sub(p, x)) < LAMP_GAP,
              )
            )
              continue;
            // Плафон (+X модели) — к дороге.
            const yaw = Math.atan2(n[1], -n[0]);
            const id = createHash('sha1').update(`${p[0]},${p[1]}`).digest('hex').slice(0, 20);
            lamps.push({
              entityId: `lamp-street-pass-${id}`,
              assetId: 'lamp-street',
              position: { x: p[0], y: 0, z: p[1] },
              rotation: { x: 0, y: r3e(Math.sin(yaw / 2)), z: 0, w: r3e(Math.cos(yaw / 2)) },
            });
          }
        }
        carry = (((carry - d) % spacing) + spacing) % spacing;
      }
    }
  }
  return { removed, moves, lamps };
}
const r3e = (v: number) => Number(v.toFixed(8));

/** Ряд деревьев посередине нового газона, как на фото. */
function planTrees(
  config: Config,
  items: Placed[],
  plan: Plan,
  road: Surface,
  paved: Surface,
  green: Surface,
  stops: Point2[],
): Placed[] {
  const area = (p: Point2) => inOld(p) && len(p) > RING_KEEP;
  const poles: Point2[] = [
    ...items
      .filter((e) => POLES.test(e.assetId))
      .map((e): Point2 => plan.moves.get(e.entityId)?.to ?? [e.position.x, e.position.z]),
    ...plan.lamps.map((l): Point2 => [l.position.x, l.position.z]),
  ];
  const planted: Point2[] = items
    .filter((e) => /^(tree|bush)-/.test(e.assetId))
    .map((e) => [e.position.x, e.position.z]);
  const trees: Placed[] = [];
  for (const s of config.streets) {
    if (!s.trees || s.verge === null) continue;
    for (const line of s.lines) {
      let carry = s.trees / 2;
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i],
          b = line[i + 1],
          d = len(sub(b, a));
        const u = norm(sub(b, a));
        for (let t = carry; t < d; t += s.trees) {
          const c = add(a, u, t);
          for (const side of [1, -1]) {
            const n: Point2 = [-u[1] * side, u[0] * side];
            let curb: Point2 | undefined;
            for (let k = 0.25; k <= 25; k += 0.25) {
              const p = add(c, n, k);
              if (!road.has(p) && road.has(add(c, n, k - 0.25))) {
                curb = p;
                break;
              }
            }
            if (!curb) continue;
            const p = round(add(curb, n, CURB + s.verge / 2));
            if (
              !area(p) ||
              !green.has(p) ||
              paved.has(p) ||
              config.crossings.some((x) => len(sub(p, x)) < CROSSING_CLEAR) ||
              stops.some((x) => len(sub(p, x)) < STOP_CLEAR) ||
              poles.some((x) => len(sub(p, x)) < TREE_POLE_GAP) ||
              planted.some((x) => len(sub(p, x)) < TREE_KEEP) ||
              trees.some((x) => len(sub(p, [x.position.x, x.position.z])) < s.trees! * 0.75)
            )
              continue;
            const hash = createHash('sha1').update(`tree:${p[0]},${p[1]}`).digest();
            const roll = hash.readUInt32BE(0) / 2 ** 32;
            trees.push({
              entityId: `tree-street-pass-${hash.toString('hex').slice(0, 20)}`,
              assetId: TREE_MIX.find(([share]) => roll < share)![1],
              position: { x: p[0], y: 0, z: p[1] },
              rotation: { x: 0, y: 0, z: 0, w: 1 },
            });
          }
        }
        carry = (((carry - d) % s.trees) + s.trees) % s.trees;
      }
    }
  }
  return trees;
}

async function terrain() {
  const release = JSON.parse(await readFile(RELEASE, 'utf8'));
  const ground = release.groundTerrain;
  const gridBytes = await readFile(`${WORLD_DIR}/${ground.grid.file}`);
  if (createHash('sha256').update(gridBytes).digest('hex') !== ground.grid.sha256)
    throw new Error('Terrain grid hash mismatch: restore LF bytes (git show HEAD:<grid> > <grid>)');
  return { release, grid: validateTerrainGrid(JSON.parse(gridBytes.toString())) as TerrainGrid };
}
/** Высота seed на новом месте — как у сборки рельефа (см. seed-height.ts). */
const placedHeight = (ground: any, grid: TerrainGrid, e: Placed, at: Point2) =>
  canonicalHeight(ground, grid, { ...e, position: { x: at[0], y: 0, z: at[1] } } as any);

function svg(recipe: GroundRecipe, green: Polygon[], plan: Plan, items: Placed[], trees: Placed[]) {
  const path = (ring: Point2[]) => 'M' + ring.map(([x, z]) => `${x} ${z}`).join('L') + 'Z';
  let body = '';
  for (const layer of recipe.layers)
    for (const poly of layer.polygons as Polygon[])
      if (poly[0].some(inOld))
        body += `<path d="${poly.map(path).join('')}" fill="${layer.color}" fill-rule="evenodd"/>`;
  for (const poly of green)
    body += `<path d="${poly.map(path).join('')}" fill="#1f9e2f" fill-rule="evenodd"/>`;
  for (const e of items) {
    const p: Point2 = [e.position.x, e.position.z];
    if (plan.removed.has(e.entityId))
      body += `<circle cx="${p[0]}" cy="${p[1]}" r="1.2" fill="#ff0000"/>`;
    const m = plan.moves.get(e.entityId);
    if (m)
      body += `<line x1="${m.from[0]}" y1="${m.from[1]}" x2="${m.to[0]}" y2="${m.to[1]}" stroke="#ff00ff" stroke-width="0.4"/>`;
  }
  for (const t of trees)
    body += `<circle cx="${t.position.x}" cy="${t.position.z}" r="1.4" fill="#0b5d1e"/>`;
  for (const l of plan.lamps)
    body += `<circle cx="${l.position.x}" cy="${l.position.z}" r="1" fill="#ffd400" stroke="#000" stroke-width="0.2"/>`;
  const [x0, z0] = OLD_MIN,
    [x1, z1] = OLD_MAX;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${(x1 - x0) * 3}" height="${(z1 - z0) * 3}" viewBox="${x0} ${z0} ${x1 - x0} ${z1 - z0}" style="background:#d9cbb1">${body}</svg>`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--init')) return init();
  const dry = args.includes('--dry');
  const layoutIndex = args.indexOf('--layout');
  const sourceText = await readFile(GROUND, 'utf8');
  const sha = createHash('sha256').update(sourceText).digest('hex');
  if (sha !== ORIGINAL_SHA256 && layoutIndex < 0 && !dry)
    throw new Error(`Ground source ${sha} is not the pre-pass version; already applied?`);
  const recipe = JSON.parse(sourceText) as GroundRecipe;
  const layer = (id: string) => {
    const found = recipe.layers.find((l) => l.id === id);
    if (!found) throw new Error(`No ground layer ${id}`);
    return found.polygons as Polygon[];
  };
  const config = JSON.parse(await readFile(CONFIG, 'utf8')) as Config;
  const road = new Surface(layer('road'));
  const paved = new Surface([...layer('road'), ...layer('service'), ...layer('parking')]);

  if (layoutIndex >= 0) {
    const outIndex = args.indexOf('--out');
    if (outIndex < 0) throw new Error('--layout requires --out <edited.json>');
    const exported = JSON.parse(await readFile(args[layoutIndex + 1], 'utf8'));
    const items: Placed[] = exported.instances;
    if (!Array.isArray(items)) throw new Error('Export has no instances');
    const stops = items
      .filter((e) => e.assetId.startsWith('bus-stop'))
      .map((e): Point2 => [e.position.x, e.position.z]);
    const plan = planObjects(config, items, road, paved, stops);
    const verge = verges(config, layer('road'), stops);
    const trees = planTrees(config, items, plan, road, paved, new Surface(verge.polygons), stops);
    const { release, grid } = await terrain();
    const ground = release.groundTerrain;
    for (const e of items) {
      const m = plan.moves.get(e.entityId);
      if (!m) continue;
      e.position.y = placedHeight(ground, grid, e, m.to);
      e.position.x = m.to[0];
      e.position.z = m.to[1];
    }
    const ids = new Set(items.map((e) => e.entityId));
    const added = [...plan.lamps, ...trees].filter((l) => !ids.has(l.entityId));
    exported.instances = [
      ...items.filter((e) => !plan.removed.has(e.entityId)),
      ...added.map((l) => ({
        ...l,
        position: { ...l.position, y: placedHeight(ground, grid, l, [l.position.x, l.position.z]) },
        enabled: true,
        instanceRevision: 1,
      })),
    ];
    await writeFile(args[outIndex + 1], JSON.stringify(exported, null, 2) + '\n');
    console.log(
      `layout: removed ${plan.removed.size} fences, moved ${plan.moves.size}, added ${added.length} lamps and trees`,
    );
    return;
  }

  const seedText = await readFile(SEED, 'utf8');
  const seed = JSON.parse(seedText);
  if (JSON.stringify(seed, null, 2) + '\n' !== seedText.replace(/\r\n/g, '\n'))
    throw new Error('Seed formatting is not JSON.stringify(…, 2); refusing to rewrite');
  const items = seed.buildings as Placed[];
  const stops = items
    .filter((e) => e.assetId.startsWith('bus-stop'))
    .map((e): Point2 => [e.position.x, e.position.z]);
  const plan = planObjects(config, items, road, paved, stops);
  const green = verges(config, layer('road'), stops);
  const trees = planTrees(config, items, plan, road, paved, new Surface(green.polygons), stops);
  const kinds = (ids: Iterable<string>) => {
    const out: Record<string, number> = {};
    for (const id of ids) {
      const e = items.find((x) => x.entityId === id)!;
      out[e.assetId] = (out[e.assetId] ?? 0) + 1;
    }
    return JSON.stringify(out);
  };
  console.log(
    `verge: ${green.polygons.length} polygons (${green.dropped} dropped), ` +
      `${Math.round(green.polygons.reduce((s, p) => s + area(p), 0))} m²\n` +
      `removed: ${kinds(plan.removed)}\nmoved: ${kinds(plan.moves.keys())}\nnew lamps: ${plan.lamps.length}` +
      `
new trees: ${trees.length} ${JSON.stringify(Object.fromEntries(TREE_MIX.map(([, id]) => [id, trees.filter((t) => t.assetId === id).length])))}`,
  );
  await mkdir('dist/preview', { recursive: true });
  await writeFile('dist/preview/street-pass.svg', svg(recipe, green.polygons, plan, items, trees));
  if (dry) return;

  layer('green').push(...green.polygons);
  await writeFile(GROUND, JSON.stringify(recipe) + '\n');

  const { release, grid } = await terrain();
  const seedY: Record<string, number> = release.groundTerrain.seedY;
  for (const id of plan.removed) delete seedY[id];
  for (const e of items) {
    const m = plan.moves.get(e.entityId);
    if (!m) continue;
    const y = placedHeight(release.groundTerrain, grid, e, m.to);
    if (Object.hasOwn(seedY, e.entityId)) seedY[e.entityId] = y;
    else e.position.y = y;
    e.position.x = m.to[0];
    e.position.z = m.to[1];
  }
  for (const l of [...plan.lamps, ...trees])
    seedY[l.entityId] = placedHeight(release.groundTerrain, grid, l, [l.position.x, l.position.z]);
  seed.buildings = [...items.filter((e) => !plan.removed.has(e.entityId)), ...plan.lamps, ...trees];
  await writeFile(SEED, JSON.stringify(seed, null, 2) + '\n');
  await writeFile(RELEASE, JSON.stringify(release, null, 2) + '\n');
  console.log(`written ${GROUND}, ${SEED}, ${RELEASE}`);
}

function area([outer, ...holes]: Polygon) {
  const a = (ring: Point2[]) =>
    Math.abs(
      ring.reduce((s, p, i) => {
        const q = ring[(i + 1) % ring.length];
        return s + p[0] * q[1] - q[0] * p[1];
      }, 0) / 2,
    );
  return a(outer) - holes.reduce((s, h) => s + a(h), 0);
}

await main();
