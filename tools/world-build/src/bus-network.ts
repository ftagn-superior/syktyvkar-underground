/**
 * Автобусная сеть ring-block: маршруты «Транспорт 11», координаты, отношения и дороги
 * OpenStreetMap плюс ручные правки `content/worlds/ring-block/bus-network/overrides.json`.
 *
 *   pnpm world:bus:network -- --fetch      # скачать transport11 + OSM в output/bus-network/
 *   pnpm world:bus:network -- --fetch-osm  # обновить только OSM
 *   pnpm world:bus:network                 # пересчитать сеть из сохранённых снимков
 *
 * Пишет `content/worlds/ring-block/bus-network/network.json` и `provenance.json`.
 * Сборка мира эти данные не читает.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type {
  BusNetwork,
  BusPlatform,
  BusPoint as Point2,
  BusRoute,
  BusRouteDirection,
  BusSequenceEntry,
  BusStop,
} from '@su/contracts';

export type { BusNetwork, BusPlatform, BusRoute, BusRouteDirection, BusSequenceEntry, BusStop };

const TERRAIN_SOURCE = 'content/worlds/ring-block/terrain-expansion/source.json';
const OUT_DIR = 'content/worlds/ring-block/bus-network';
const OVERRIDES_FILE = `${OUT_DIR}/overrides.json`;
const CACHE_DIR = 'output/bus-network';
const OSM_CACHE = `${CACHE_DIR}/osm.json`;
const T11_DIR = `${CACHE_DIR}/transport11`;
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const T11 = 'https://transport11.ru/timetable/syktyvkar';
/** Запас вокруг мира для дорог и остановок, м: пути за краем нужны для выездов и возвратов. */
const FETCH_MARGIN = 1500;
/** Часть пути за краем мира, которая ещё хранится, м. */
const KEEP_MARGIN = 300;
/** Платформы одного имени ближе этого расстояния — одна остановка. */
const CLUSTER_RADIUS = 350;
/** Шаг дробления рёбер графа, м: ближайшая вершина лежит не дальше половины шага от точки дороги. */
const DENSIFY = 15;

type Tags = Record<string, string>;
interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}
interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Tags;
}
interface OsmRelation {
  type: 'relation';
  id: number;
  tags?: Tags;
  members?: { type: string; ref: number; role: string }[];
}
type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface CustomStopOverride {
  id: string;
  name: string;
  matchNames: string[];
  routeRefs?: string[];
  osmNodeIds: number[];
  excludeFromOtherStops?: boolean;
}

export interface ExtraPlatformOverride {
  id: string;
  stopKey: string;
  position: Point2;
  sideHint?: string;
  source?: 'osm' | 'override';
}

export interface RouteDirectionOverride {
  towards?: string;
  circular?: boolean;
  stops?: string[];
}

export interface BusNetworkOverrides {
  formatVersion?: number;
  aliases?: Record<string, string>;
  customStops?: CustomStopOverride[];
  extraPlatforms?: ExtraPlatformOverride[];
  routes?: Record<string, { directions?: RouteDirectionOverride[] }>;
}

// ---------- имена ----------

/** Нормализованное имя «Транспорт 11» или OSM-синоним → каноническое нормализованное имя OSM. */
export const ALIASES: Record<string, string> = {
  драмтеатр: 'театр драмы',
  'жд вокзал': 'вокзал',
  'торговый центр аврора': 'аврора',
  педколледж: 'педучилище',
  'школа искусства': 'школа искусств',
  интернациональная: 'интернациональная-пушкина',
  'сыктывкарский государственный университет': 'сгу',
  пединститут: 'музтеатр',
};

export function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"]/g, '')
    .replace(/(^|\s)(улица|ул\.)(?=\s|$)/g, ' ')
    .replace(/№\s+/g, '№')
    .replace(/,?\s*(конечная|сыктывкар)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
}

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

export const slug = (name: string) =>
  [...name.toLowerCase()]
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const compareRef = (a: string, b: string) =>
  Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const dist = (a: Point2, b: Point2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------- «Транспорт 11» ----------

export interface T11Route {
  uri: string;
  ref: string;
  name: string;
  stops: string[];
}

const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

export function parseT11(page: string): T11Route {
  const attr = (name: string) =>
    unescape(new RegExp(`data-${name}="([^"]*)"`).exec(page)?.[1] ?? '');
  const stops = [...page.matchAll(/data-stop-id="\d+".*?trip-label[^>]*>\s*([^<]*?)\s*</gs)].map(
    (m) => unescape(m[1]!).replace(/\s+/g, ' ').trim(),
  );
  return { uri: attr('uri'), ref: attr('number').toUpperCase(), name: attr('longname'), stops };
}

// ---------- дорожный граф ----------

const DRIVE: Record<string, number> = {
  motorway: 1,
  motorway_link: 1,
  trunk: 1,
  trunk_link: 1,
  primary: 1,
  primary_link: 1,
  secondary: 1,
  secondary_link: 1,
  busway: 0.9,
  tertiary: 1.15,
  tertiary_link: 1.15,
  unclassified: 1.4,
  residential: 1.8,
  living_street: 3,
  service: 3.5,
};
const NO_SERVICE = new Set(['parking_aisle', 'driveway', 'drive-through']);

interface Graph {
  pos: Point2[];
  /** Смежность: [вершина, стоимость, длина]. */
  out: [number, number, number][][];
  /** Вершины не служебных дорог — для привязки остановок. */
  main: boolean[];
  /** Путь OSM, на котором вершина появилась первой: разные проезжие части разделённой улицы. */
  way: number[];
}

function deduplicateOsm(raw: OsmElement[]): {
  nodesById: Map<number, OsmNode>;
  ways: OsmWay[];
} {
  const nodesById = new Map<number, OsmNode>();
  const waysById = new Map<number, OsmWay>();
  for (const el of raw) {
    if (el.type === 'node') {
      const prev = nodesById.get(el.id);
      if (!prev) nodesById.set(el.id, { ...el, tags: el.tags ? { ...el.tags } : undefined });
      else {
        // Overpass `>;out skel qt;` повторно отдаёт уже встреченные узлы без тегов — не теряем их.
        if (el.tags) prev.tags = { ...prev.tags, ...el.tags };
        if (el.lat != null && el.lon != null) {
          prev.lat = el.lat;
          prev.lon = el.lon;
        }
      }
    } else if (el.type === 'way') {
      const prev = waysById.get(el.id);
      if (!prev) waysById.set(el.id, { ...el, tags: el.tags ? { ...el.tags } : undefined });
      else {
        if (el.tags) prev.tags = { ...prev.tags, ...el.tags };
        if (el.nodes?.length) prev.nodes = el.nodes;
      }
    }
  }
  return { nodesById, ways: [...waysById.values()] };
}

function buildGraph(ways: OsmWay[], nodes: Map<number, Point2>): Graph {
  const pos: Point2[] = [];
  const out: [number, number, number][][] = [];
  const main: boolean[] = [];
  const way: number[] = [];
  const ids = new Map<string, number>();
  let wayId = 0;
  const vertex = (key: string, p: Point2, isMain: boolean) => {
    let i = ids.get(key);
    if (i === undefined) {
      i = pos.length;
      ids.set(key, i);
      pos.push(p);
      out.push([]);
      main.push(isMain);
      way.push(wayId);
    } else if (isMain && !main[i]) {
      main[i] = true;
      way[i] = wayId;
    }
    return i;
  };
  for (const w of ways) {
    const t = w.tags ?? {};
    const k = DRIVE[t.highway ?? ''];
    if (!k || t.area === 'yes') continue;
    if (t.highway === 'service' && NO_SERVICE.has(t.service ?? '')) continue;
    const psv =
      t.bus === 'yes' || t.psv === 'yes' || t.bus === 'designated' || t.psv === 'designated';
    if ((t.access === 'no' || t.access === 'private' || t.motor_vehicle === 'no') && !psv) continue;
    const busTwoWay =
      t['oneway:bus'] === 'no' || t['oneway:psv'] === 'no' || t.highway === 'busway';
    const oneway = busTwoWay
      ? 0
      : t.oneway === '-1'
        ? -1
        : t.oneway === 'yes' ||
            t.oneway === '1' ||
            t.oneway === 'true' ||
            t.junction === 'roundabout'
          ? 1
          : 0;
    const isMain = t.highway !== 'service';
    wayId = w.id;
    for (let i = 1; i < w.nodes.length; i++) {
      const a = w.nodes[i - 1]!,
        b = w.nodes[i]!;
      const pa = nodes.get(a),
        pb = nodes.get(b);
      if (!pa || !pb || a === b) continue;
      // Дробление детерминировано по паре узлов, чтобы общие улицы давали одинаковые вершины.
      const [lo, hi, plo, phi] = a < b ? [a, b, pa, pb] : [b, a, pb, pa];
      const n = Math.max(1, Math.ceil(dist(plo, phi) / DENSIFY));
      const chain = [vertex(`n${lo}`, plo, isMain)];
      for (let j = 1; j < n; j++)
        chain.push(
          vertex(
            `n${lo}-${hi}-${j}`,
            [plo[0] + ((phi[0] - plo[0]) * j) / n, plo[1] + ((phi[1] - plo[1]) * j) / n],
            isMain,
          ),
        );
      chain.push(vertex(`n${hi}`, phi, isMain));
      if (a > b) chain.reverse();
      for (let j = 1; j < chain.length; j++) {
        const u = chain[j - 1]!,
          v = chain[j]!,
          len = dist(pos[u]!, pos[v]!);
        if (oneway >= 0) out[u]!.push([v, len * k, len]);
        if (oneway <= 0) out[v]!.push([u, len * k, len]);
      }
    }
  }
  return { pos, out, main, way };
}

class Heap {
  private a: [number, number][] = [];
  get size() {
    return this.a.length;
  }
  push(item: [number, number]) {
    const a = this.a;
    a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p]![0] <= a[i]![0]) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a,
      top = a[0]!,
      last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

let reverseCache: { g: Graph; back: [number, number, number][][] } | undefined;
function reverseAdjacency(g: Graph) {
  if (reverseCache?.g === g) return reverseCache.back;
  const back: [number, number, number][][] = g.pos.map(() => []);
  g.out.forEach((edges, u) => edges.forEach(([v, c, l]) => back[v]!.push([u, c, l])));
  reverseCache = { g, back };
  return back;
}

/**
 * Кратчайшие пути от `from` до каждой из `targets` (Дейкстра до последней цели или `limit`).
 * `ignoreOneway` — запасной вариант, если по правилам проезда пути нет.
 */
function routeAll(g: Graph, from: number, targets: number[], limit: number, ignoreOneway = false) {
  const left = new Set(targets);
  const cost = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const found = new Map<number, { cost: number; path: number[] }>();
  const heap = new Heap();
  heap.push([0, from]);
  const back = ignoreOneway ? reverseAdjacency(g) : undefined;
  while (heap.size && left.size) {
    const [c, u] = heap.pop();
    if (c > (cost.get(u) ?? Infinity)) continue;
    if (c > limit) break;
    if (left.delete(u)) {
      const path = [u];
      for (let x = u; prev.has(x);) path.push((x = prev.get(x)!));
      found.set(u, { cost: c, path: path.reverse() });
      if (!left.size) break;
    }
    const edges = back ? [...g.out[u]!, ...back[u]!] : g.out[u]!;
    for (const [v, edge] of edges) {
      const nc = c + edge;
      if (nc < (cost.get(v) ?? Infinity)) {
        cost.set(v, nc);
        prev.set(v, u);
        heap.push([nc, v]);
      }
    }
  }
  return found;
}

function snapper(g: Graph) {
  const CELL = 50;
  const grid = new Map<string, number[]>();
  g.pos.forEach(([x, z], v) => {
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(v);
  });
  return (p: Point2, maxDist = 80) => {
    let best = -1,
      bestD = Infinity,
      bestMain = -1,
      bestMainD = Infinity;
    const r = Math.ceil(maxDist / CELL),
      cx = Math.floor(p[0] / CELL),
      cz = Math.floor(p[1] / CELL);
    for (let i = cx - r; i <= cx + r; i++)
      for (let j = cz - r; j <= cz + r; j++)
        for (const v of grid.get(`${i},${j}`) ?? []) {
          const d = dist(p, g.pos[v]!);
          if (d < bestD) [best, bestD] = [v, d];
          if (g.main[v] && d < bestMainD) [bestMain, bestMainD] = [v, d];
        }
    // Служебный проезд — только если улица заметно дальше (автостанции, аэропорт).
    if (bestMain >= 0 && bestMainD <= Math.min(maxDist, bestD + 25)) return bestMain;
    return bestD <= maxDist ? best : -1;
  };
}

function snapperMany(g: Graph, one: (p: Point2, maxDist?: number) => number) {
  const CELL = 50;
  const grid = new Map<string, number[]>();
  g.pos.forEach(([x, z], v) => {
    if (!g.main[v]) return;
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(v);
  });
  return (p: Point2, maxDist = 40, max = 4): number[] => {
    const near: [number, number][] = [];
    const cx = Math.floor(p[0] / CELL),
      cz = Math.floor(p[1] / CELL);
    for (let i = cx - 1; i <= cx + 1; i++)
      for (let j = cz - 1; j <= cz + 1; j++)
        for (const v of grid.get(`${i},${j}`) ?? []) {
          const d = dist(p, g.pos[v]!);
          if (d <= maxDist) near.push([v, d]);
        }
    near.sort((a, b) => a[1] - b[1]);
    const picked: number[] = [];
    const ways = new Set<number>();
    for (const [v] of near) {
      if (picked.length >= max) break;
      if (!ways.has(g.way[v]!)) (ways.add(g.way[v]!), picked.push(v));
    }
    if (!picked.length) {
      const v = one(p);
      if (v >= 0) picked.push(v);
    }
    return picked;
  };
}

/**
 * Штраф за выбор платформы на левой (встречной) стороне проезжей части при правостороннем движении.
 * В системе (X = восток, Z = юг) правая нормаль к вектору хода `(tx, tz)` — `(-tz, tx)`.
 */
function wrongSidePenalty(platform: Point2, roadAnchor: Point2, ahead: Point2): number {
  const dx = ahead[0] - roadAnchor[0];
  const dz = ahead[1] - roadAnchor[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return 0;
  const tx = dx / len;
  const tz = dz / len;
  const signedRight = (platform[0] - roadAnchor[0]) * -tz + (platform[1] - roadAnchor[1]) * tx;
  return signedRight < -2.5 ? 500 : 0;
}

function endpointTangent(
  path: readonly number[],
  pos: readonly Point2[],
  atEnd: boolean,
): [Point2, Point2] | undefined {
  if (path.length < 2) return undefined;
  const anchorIdx = atEnd ? path.length - 1 : 0;
  const anchor = pos[path[anchorIdx]!]!;
  if (!atEnd) {
    for (let i = 1; i < path.length; i++) {
      const pt = pos[path[i]!]!;
      if (dist(anchor, pt) >= 4 || i === path.length - 1) return [anchor, pt];
    }
  } else {
    for (let i = path.length - 2; i >= 0; i--) {
      const pt = pos[path[i]!]!;
      if (dist(pt, anchor) >= 4 || i === 0) return [pt, anchor];
    }
  }
  return undefined;
}

// ---------- сборка сети ----------

interface CandidatePlatform {
  id: string;
  position: Point2;
  sideHint?: string;
  source: 'osm' | 'interpolated' | 'override';
}

interface Cluster {
  key: string;
  idHint?: string;
  customName?: string;
  osmName: string;
  routeRefs?: Set<string>;
  platforms: CandidatePlatform[];
}

export function buildNetwork(
  t11: T11Route[],
  osm: OsmElement[],
  toGame: (p: { lat: number; lon: number }) => Point2,
  bounds: { west: number; east: number; north: number; south: number },
  overrides: BusNetworkOverrides = {},
) {
  const { nodesById, ways } = deduplicateOsm(osm);
  const aliases = { ...ALIASES, ...overrides.aliases };
  const inWorld = ([x, z]: Point2, m = 0) =>
    x > bounds.west - m && x < bounds.east + m && z > bounds.north - m && z < bounds.south + m;
  const centre = (pts: readonly Point2[]): Point2 => [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
  ];

  const nodes = new Map<number, Point2>();
  for (const e of nodesById.values()) nodes.set(e.id, toGame(e));

  const excludedOsmIds = new Set<number>();
  const customClusters: { matchKeys: Set<string>; cluster: Cluster }[] = [];
  for (const cs of overrides.customStops ?? []) {
    const platforms: CandidatePlatform[] = [];
    for (const osmId of cs.osmNodeIds) {
      if (cs.excludeFromOtherStops) excludedOsmIds.add(osmId);
      const p = nodes.get(osmId);
      if (p) platforms.push({ id: `osm-${osmId}`, position: p, source: 'osm' });
    }
    if (!platforms.length) continue;
    customClusters.push({
      matchKeys: new Set(cs.matchNames.map((n) => normName(n))),
      cluster: {
        key: normName(cs.name),
        idHint: cs.id,
        customName: cs.name,
        osmName: cs.name,
        routeRefs: cs.routeRefs ? new Set(cs.routeRefs) : undefined,
        platforms,
      },
    });
  }

  const clusters: Cluster[] = [];
  for (const e of nodesById.values()) {
    if (excludedOsmIds.has(e.id)) continue;
    const t = e.tags ?? {};
    if (!t.name || (t.highway !== 'bus_stop' && t.public_transport !== 'platform')) continue;
    const p = nodes.get(e.id)!;
    const rawKey = normName(t.name);
    const key = aliases[rawKey] ?? rawKey;
    const c = clusters.find(
      (cl) =>
        cl.key === key &&
        dist(centre(cl.platforms.map((pl) => pl.position)), p) < CLUSTER_RADIUS / 2,
    );
    const plat: CandidatePlatform = { id: `osm-${e.id}`, position: p, source: 'osm' };
    if (c) c.platforms.push(plat);
    else clusters.push({ key, osmName: t.name, platforms: [plat] });
  }

  const byKey = new Map<string, Cluster[]>();
  for (const c of clusters) (byKey.get(c.key) ?? byKey.set(c.key, []).get(c.key)!).push(c);

  for (const ep of overrides.extraPlatforms ?? []) {
    const k = aliases[normName(ep.stopKey)] ?? normName(ep.stopKey);
    const list = byKey.get(k);
    const plat: CandidatePlatform = {
      id: ep.id,
      position: ep.position,
      sideHint: ep.sideHint,
      source: ep.source ?? 'override',
    };
    if (list?.length) {
      const target = list.sort(
        (a, b) =>
          dist(centre(a.platforms.map((pl) => pl.position)), ep.position) -
          dist(centre(b.platforms.map((pl) => pl.position)), ep.position),
      )[0]!;
      target.platforms.push(plat);
    } else {
      const cl: Cluster = { key: k, osmName: ep.stopKey, platforms: [plat] };
      clusters.push(cl);
      byKey.set(k, [cl]);
    }
  }

  const g = buildGraph(ways, nodes);
  const snap = snapper(g);
  const snapMany = snapperMany(g, snap);

  type Resolved = { name: string; cluster?: Cluster; pos?: Point2 };
  const resolveStops = (stopNames: readonly string[], routeRef: string): Resolved[] => {
    const res: Resolved[] = stopNames.map((name) => ({ name }));
    const candidates = (name: string): Cluster[] => {
      const key = normName(name);
      const custom = customClusters.filter(
        (c) => c.matchKeys.has(key) && (!c.cluster.routeRefs || c.cluster.routeRefs.has(routeRef)),
      );
      if (custom.length) return custom.map((c) => c.cluster);
      return byKey.get(aliases[key] ?? key) ?? [];
    };
    const clCenter = (cl: Cluster) => centre(cl.platforms.map((p) => p.position));
    for (const s of res) {
      const c = candidates(s.name);
      if (c.length === 1) [s.cluster, s.pos] = [c[0], clCenter(c[0]!)];
    }
    for (let pass = 0; pass < 2; pass++)
      res.forEach((s, i) => {
        if (s.cluster) return;
        const c = candidates(s.name);
        const near = [res[i - 1]?.pos, res[i + 1]?.pos].filter((p): p is Point2 => !!p);
        if (!c.length || !near.length) return;
        const ranked = c
          .map((cl) => ({ cl, d: Math.min(...near.map((p) => dist(p, clCenter(cl)))) }))
          .sort((a, b) => a.d - b.d);
        const best = ranked[0]!;
        if (best.d < 3000) {
          const nearby = ranked.filter((x) => x.d <= best.d + CLUSTER_RADIUS);
          s.cluster =
            nearby.length > 1
              ? {
                  ...best.cl,
                  platforms: nearby.flatMap((x) => x.cl.platforms),
                }
              : best.cl;
          s.pos = clCenter(best.cl);
        }
      });
    return res;
  };

  interface WorkingPlatform {
    id: string;
    position: Point2;
    bearingSum: [number, number];
    bearingCount: number;
    sideHint?: string;
    nextStopHints: string[];
    source: 'osm' | 'interpolated' | 'override';
  }
  interface WorkingStop {
    id: string;
    name: string;
    platforms: Map<string, WorkingPlatform>;
    routes: Set<string>;
    source: 'osm' | 'interpolated';
  }

  const stopsById = new Map<string, WorkingStop>();
  const ensureStop = (
    name: string,
    cluster: Cluster | undefined,
    chosenPlat: CandidatePlatform,
  ): { stop: WorkingStop; platform: WorkingPlatform } => {
    let stop: WorkingStop | undefined;
    if (cluster?.idHint && stopsById.has(cluster.idHint)) {
      stop = stopsById.get(cluster.idHint)!;
    } else {
      for (const s of stopsById.values()) {
        if (s.platforms.has(chosenPlat.id)) {
          stop = s;
          break;
        }
        if (
          normName(s.name) === normName(cluster?.customName ?? name) &&
          [...s.platforms.values()].some(
            (p) => dist(p.position, chosenPlat.position) < CLUSTER_RADIUS,
          )
        ) {
          stop = s;
          break;
        }
      }
    }
    if (!stop) {
      const baseName = cluster?.customName ?? name;
      let id = cluster?.idHint ?? slug(baseName);
      if (!cluster?.idHint) {
        for (let n = 2; stopsById.has(id); n++) id = `${slug(baseName)}-${n}`;
      }
      stop = {
        id,
        name: baseName,
        platforms: new Map(),
        routes: new Set(),
        source: cluster ? 'osm' : 'interpolated',
      };
      stopsById.set(id, stop);
    }
    let plat = stop.platforms.get(chosenPlat.id);
    if (!plat) {
      // Переиспользуем интерполированную платформу, если она совпала по координатам на встречном рейсе
      for (const existing of stop.platforms.values()) {
        if (
          chosenPlat.source === 'interpolated' &&
          existing.source === 'interpolated' &&
          dist(existing.position, chosenPlat.position) < 25
        ) {
          plat = existing;
          break;
        }
      }
    }
    if (!plat) {
      plat = {
        id: chosenPlat.id,
        position: [r1(chosenPlat.position[0]), r1(chosenPlat.position[1])],
        bearingSum: [0, 0],
        bearingCount: 0,
        sideHint: chosenPlat.sideHint,
        nextStopHints: [],
        source: chosenPlat.source,
      };
      stop.platforms.set(plat.id, plat);
    }
    return { stop, platform: plat };
  };

  const routes: BusRoute[] = [];
  const stats = { routed: 0, onewayFallback: 0, failed: 0, interpolated: 0 };

  for (const r of t11) {
    if (Number.parseInt(r.ref, 10) >= 500) continue;
    const baseCircular = normName(r.stops[0] ?? '') === normName(r.stops.at(-1) ?? '');
    const [from, to] =
      r.name.split(/\s+—\s+/).length > 1
        ? [r.name.split(/\s+—\s+/)[0]!, r.name.split(/\s+—\s+/).at(-1)!]
        : [r.stops[0] ?? '', r.stops.at(-1) ?? ''];
    const ovr = overrides.routes?.[r.ref];
    const dirSpecs: { towards: string; circular: boolean; stops: string[] }[] = ovr?.directions
      ?.length
      ? ovr.directions.map((d, idx) => ({
          towards: d.towards ?? (idx === 0 ? to : from),
          circular: d.circular ?? baseCircular,
          stops: d.stops ?? (idx === 0 ? r.stops : [...r.stops].reverse()),
        }))
      : baseCircular
        ? [{ towards: to, circular: true, stops: r.stops }]
        : [
            { towards: to, circular: false, stops: r.stops },
            { towards: from, circular: false, stops: [...r.stops].reverse() },
          ];

    const builtDirs: {
      towards: string;
      circular: boolean;
      res: Resolved[];
      chosenPlat: (CandidatePlatform | undefined)[];
      pieces: Map<number, Point2[]>;
      bearings: Map<number, Point2>;
    }[] = [];

    for (const spec of dirSpecs) {
      const res = resolveStops(spec.stops, r.ref);
      const known = res.flatMap((s, i) => (s.cluster ? [i] : []));
      if (!known.length) continue;

      // На каждом известном узле перебираем пары (платформа, вершина графа)
      interface NodeCand {
        plat: CandidatePlatform;
        v: number;
        pen: number;
      }
      const cands: NodeCand[][] = known.map((i) => {
        const list: NodeCand[] = [];
        for (const plat of res[i]!.cluster!.platforms) {
          for (const v of snapMany(plat.position)) {
            list.push({ plat, v, pen: dist(plat.position, g.pos[v]!) * 2 });
          }
        }
        return list;
      });

      type StateKey = string; // `${plat.id}@${v}`
      type DPState = {
        cost: number;
        cand: NodeCand;
        back?: { key: StateKey; path: number[] };
      };
      const skey = (c: NodeCand): StateKey => `${c.plat.id}@${c.v}`;
      const fresh = (k: number) => {
        const m = new Map<StateKey, DPState>();
        for (const cand of cands[k]!) m.set(skey(cand), { cost: cand.pen, cand });
        return m;
      };
      const bestKey = (layer: Map<StateKey, DPState>) =>
        [...layer].sort((x, y) => x[1].cost - y[1].cost)[0]?.[0];

      const layers: Map<StateKey, DPState>[] = [];
      for (let k = 0; k < known.length; k++) {
        const prevLayer = layers[k - 1];
        const a = res[known[k - 1]!],
          b = res[known[k]!]!;
        const near = a && (inWorld(a.pos!, FETCH_MARGIN / 2) || inWorld(b.pos!, FETCH_MARGIN / 2));
        if (!prevLayer || !prevLayer.size || !cands[k]!.length || !near) {
          layers.push(fresh(k));
          continue;
        }
        const targets = [...new Set(cands[k]!.map((c) => c.v))];
        const straight = dist(a!.pos!, b.pos!);
        const limit = straight * 6 + 2500;

        const solve = (loose: boolean) => {
          const layer = new Map<StateKey, DPState>();
          let best = Infinity;
          // Кэшируем routeAll по стартовой вершине u
          const byStartVertex = new Map<number, Map<number, { cost: number; path: number[] }>>();
          for (const [, st] of prevLayer) {
            let paths = byStartVertex.get(st.cand.v);
            if (!paths) {
              paths = routeAll(g, st.cand.v, targets, limit, loose);
              byStartVertex.set(st.cand.v, paths);
            }
            for (const nextCand of cands[k]!) {
              const leg = paths.get(nextCand.v);
              if (!leg) continue;
              const startSeg = endpointTangent(leg.path, g.pos, false);
              const endSeg = endpointTangent(leg.path, g.pos, true);
              const rhtStart = startSeg
                ? wrongSidePenalty(st.cand.plat.position, startSeg[0], startSeg[1])
                : 0;
              const rhtEnd = endSeg
                ? wrongSidePenalty(nextCand.plat.position, endSeg[0], endSeg[1])
                : 0;
              const totalCost = st.cost + leg.cost + nextCand.pen + rhtStart + rhtEnd;
              best = Math.min(best, leg.cost);
              const nk = skey(nextCand);
              if (totalCost < (layer.get(nk)?.cost ?? Infinity)) {
                layer.set(nk, {
                  cost: totalCost,
                  cand: nextCand,
                  back: { key: skey(st.cand), path: leg.path },
                });
              }
            }
          }
          return { layer, best };
        };

        let { layer, best } = solve(false);
        if (!layer.size || best > straight * 4 + 1500) {
          const loose = solve(true);
          if (loose.layer.size && (!layer.size || loose.best < best * 0.6)) {
            layer = loose.layer;
            stats.onewayFallback++;
          }
        }
        if (!layer.size) {
          stats.failed++;
          layers.push(fresh(k));
          continue;
        }
        stats.routed++;
        layers.push(layer);
      }

      const pieces = new Map<number, Point2[]>();
      const chosenPlat: (CandidatePlatform | undefined)[] = res.map(() => undefined);
      const bearings = new Map<number, Point2>();

      let curKey = layers.length ? bestKey(layers.at(-1)!) : undefined;
      for (let k = layers.length - 1; k >= 0 && curKey !== undefined; k--) {
        const st = layers[k]!.get(curKey)!;
        const stopIdx = known[k]!;
        chosenPlat[stopIdx] = st.cand.plat;
        if (st.back) {
          const pathPts = st.back.path.map((x) => g.pos[x]!);
          pieces.set(known[k - 1]!, pathPts);
          if (pathPts.length >= 2) {
            const p0 = pathPts[0]!,
              p1 = pathPts.find((p, j) => j > 0 && (dist(p0, p) >= 4 || j === pathPts.length - 1))!;
            const d0 = dist(p0, p1);
            if (d0 > 0.1 && !bearings.has(known[k - 1]!)) {
              bearings.set(known[k - 1]!, [(p1[0] - p0[0]) / d0, (p1[1] - p0[1]) / d0]);
            }
            const q1 = pathPts.at(-1)!,
              q0 = [...pathPts]
                .reverse()
                .find((p, j) => j > 0 && (dist(p, q1) >= 4 || j === pathPts.length - 1))!;
            const d1 = dist(q0, q1);
            if (d1 > 0.1 && !bearings.has(stopIdx)) {
              bearings.set(stopIdx, [(q1[0] - q0[0]) / d1, (q1[1] - q0[1]) / d1]);
            }
          }
          curKey = st.back.key;
        } else {
          curKey = k > 0 ? bestKey(layers[k - 1]!) : undefined;
        }
      }

      // Неизвестные промежуточные остановки внутри мира — интерполяция на путь автобуса.
      for (let k = 1; k < known.length; k++) {
        const a = known[k - 1]!,
          b = known[k]!;
        const path = pieces.get(a);
        const pA = chosenPlat[a]?.position ?? res[a]!.pos;
        const pB = chosenPlat[b]?.position ?? res[b]!.pos;
        if (b - a < 2 || !path || path.length < 2 || !pA || !pB || !inWorld(pA) || !inWorld(pB))
          continue;
        const cum = [0];
        for (let j = 1; j < path.length; j++) cum.push(cum[j - 1]! + dist(path[j - 1]!, path[j]!));
        let rest = path,
          restStart = 0;
        for (let i = a + 1; i < b; i++) {
          const target = (cum.at(-1)! * (i - a)) / (b - a);
          const foundIdx = cum.findIndex((c) => c >= target);
          const j = foundIdx < 1 ? (foundIdx === 0 ? 1 : path.length - 1) : foundIdx;
          const t = (target - cum[j - 1]!) / Math.max(1e-9, cum[j]! - cum[j - 1]!);
          const p: Point2 = [
            path[j - 1]![0] + (path[j]![0] - path[j - 1]![0]) * t,
            path[j - 1]![1] + (path[j]![1] - path[j - 1]![1]) * t,
          ];
          res[i]!.pos = p;
          chosenPlat[i] = {
            id: `int-${slug(res[i]!.name)}-${Math.round(p[0])}x${Math.round(p[1])}`.replace(
              /--+/g,
              '-',
            ),
            position: p,
            source: 'interpolated',
          };
          const segLen = dist(path[j - 1]!, path[j]!);
          if (segLen > 0.1) {
            bearings.set(i, [
              (path[j]![0] - path[j - 1]![0]) / segLen,
              (path[j]![1] - path[j - 1]![1]) / segLen,
            ]);
          }
          pieces.set(i - 1, [...rest.slice(0, j - restStart), p]);
          rest = [p, ...path.slice(j)];
          restStart = j - 1;
          stats.interpolated++;
        }
        pieces.set(b - 1, rest);
      }

      const worldDistinct = new Set(
        res
          .map((s, idx) =>
            chosenPlat[idx] && inWorld(chosenPlat[idx]!.position) ? normName(s.name) : '',
          )
          .filter(Boolean),
      );
      if (worldDistinct.size < 2) continue;

      builtDirs.push({
        towards: spec.towards,
        circular: spec.circular,
        res,
        chosenPlat,
        pieces,
        bearings,
      });
    }

    if (!builtDirs.length) continue;

    const directions: BusRouteDirection[] = [];
    for (const bd of builtDirs) {
      const refs = bd.res.map((s, idx) => {
        const cp = bd.chosenPlat[idx];
        if (!cp || !inWorld(cp.position)) return undefined;
        const { stop, platform } = ensureStop(s.name, s.cluster, cp);
        stop.routes.add(r.ref);
        const bvec = bd.bearings.get(idx);
        if (bvec) {
          platform.bearingSum[0] += bvec[0];
          platform.bearingSum[1] += bvec[1];
          platform.bearingCount++;
        }
        return { stopId: stop.id, platformId: platform.id, stopName: stop.name, platform };
      });

      // Подсказка стороны: ближайшая следующая остановка мира или конечная направления
      refs.forEach((cur, idx) => {
        if (!cur) return;
        let hintName: string | undefined;
        for (let k = idx + 1; k < bd.res.length; k++) {
          if (refs[k] && refs[k]!.stopId !== cur.stopId) {
            hintName = refs[k]!.stopName;
            break;
          }
          if (!refs[k]) {
            hintName = bd.res[k]!.name;
            break;
          }
        }
        if (hintName && !cur.platform.nextStopHints.includes(hintName)) {
          cur.platform.nextStopHints.push(hintName);
        }
      });

      const sequence: BusSequenceEntry[] = [];
      const legs: Point2[][][] = [];
      let leg: Point2[] = [];
      const flush = (into: Point2[][], line: Point2[]) => {
        const clean: Point2[] = [];
        for (const p of line) {
          const back = clean[clean.length - 2];
          if (back && back[0] === p[0] && back[1] === p[1]) clean.pop();
          else if (!(clean.length && clean.at(-1)![0] === p[0] && clean.at(-1)![1] === p[1]))
            clean.push(p);
        }
        let cur: Point2[] = [];
        for (const p of clean) {
          if (inWorld(p, KEEP_MARGIN)) cur.push([r1(p[0]), r1(p[1])]);
          else if (cur.length) (into.push(cur), (cur = []));
        }
        if (cur.length > 1) into.push(cur);
      };

      let started = false;
      for (let i = 0; i < bd.res.length; i++) {
        const refEntry = refs[i];
        if (refEntry) {
          if (started) {
            const parts: Point2[][] = [];
            flush(parts, leg);
            legs.push(parts);
          }
          const last = sequence.at(-1);
          if (!last || !('stopId' in last) || last.stopId !== refEntry.stopId) {
            sequence.push({ stopId: refEntry.stopId, platformId: refEntry.platformId });
          } else if (started) {
            legs.pop();
          }
          started = true;
          leg = [];
        } else {
          const last = sequence.at(-1);
          if (last && 'offWorld' in last) last.offWorld.push(bd.res[i]!.name);
          else sequence.push({ offWorld: [bd.res[i]!.name] });
        }
        const piece = bd.pieces.get(i);
        if (piece) leg.push(...piece);
        else if (bd.res[i]!.pos && bd.chosenPlat[i]) {
          leg.push([NaN, NaN]);
        }
      }

      directions.push({
        towards: bd.towards,
        circular: bd.circular,
        sequence,
        legs,
      });
    }

    if (!directions.length) continue;
    routes.push({
      id: slug(r.uri.replace(/^bus_/, '')),
      ref: r.ref,
      name: r.name,
      from,
      to,
      circular: directions.some((d) => d.circular),
      transport11: `${T11}/${r.uri}`,
      directions,
    });
  }

  const stops: BusStop[] = [...stopsById.values()]
    .filter((s) => s.routes.size > 0 && s.platforms.size > 0)
    .map((s) => {
      const platforms: BusPlatform[] = [...s.platforms.values()].map((p) => {
        const blen = Math.hypot(p.bearingSum[0], p.bearingSum[1]);
        const bearing: Point2 | undefined =
          p.bearingCount > 0 && blen > 1e-3
            ? [r3(p.bearingSum[0] / blen), r3(p.bearingSum[1] / blen)]
            : undefined;
        const sideHint =
          p.sideHint ??
          (p.nextStopHints.length ? `→ ${p.nextStopHints.slice(0, 2).join(', ')}` : undefined);
        const out: BusPlatform = { id: p.id, position: p.position, source: p.source };
        if (bearing) out.bearing = bearing;
        if (sideHint) out.sideHint = sideHint;
        return out;
      });
      const center = centre(platforms.map((p) => p.position));
      return {
        id: s.id,
        name: s.name,
        position: [r1(center[0]), r1(center[1])] as Point2,
        platforms,
        routes: [...s.routes].sort(compareRef),
        source: s.source,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  routes.sort((a, b) => compareRef(a.ref, b.ref));
  return {
    network: { formatVersion: 3 as const, stops, routes } satisfies BusNetwork,
    stats,
    graphVertices: g.pos.length,
  };
}

// ---------- подложка карты ----------

export interface BusMapBackground {
  formatVersion: 1;
  /** Проезжие улицы: класс OSM без `_link` и ломаная X/Z. */
  roads: { k: string; p: Point2[] }[];
  /** Контуры домов в границах мира, без замыкающей точки. */
  buildings: Point2[][];
}

function simplifyLine(pts: Point2[], eps: number): Point2[] {
  if (pts.length < 3) return pts;
  const a = pts[0]!,
    b = pts.at(-1)!;
  const length = dist(a, b) || 1e-9;
  let best = 0,
    index = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const d = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / length;
    if (d > best) [best, index] = [d, i];
  }
  if (best <= eps) return [a, b];
  return [
    ...simplifyLine(pts.slice(0, index + 1), eps).slice(0, -1),
    ...simplifyLine(pts.slice(index), eps),
  ];
}

/** Улицы и дома для карты автобусов: упрощены до долей метра, координаты с шагом 0,1 м. */
export function mapBackground(
  elements: OsmElement[],
  toGame: (p: { lat: number; lon: number }) => Point2,
  bounds: { west: number; east: number; north: number; south: number },
): BusMapBackground {
  const { nodesById, ways } = deduplicateOsm(elements);
  const near = ([x, z]: Point2, m: number) =>
    x >= bounds.west - m && x <= bounds.east + m && z >= bounds.north - m && z <= bounds.south + m;
  const nodes = new Map<number, Point2>();
  for (const e of nodesById.values()) nodes.set(e.id, toGame(e));
  const round = (p: Point2): Point2 => [r1(p[0]), r1(p[1])];
  const roads: BusMapBackground['roads'] = [];
  const buildings: Point2[][] = [];
  for (const e of ways) {
    const t = e.tags ?? {};
    const pts = e.nodes.map((n) => nodes.get(n)).filter((p): p is Point2 => !!p);
    if (pts.length < 2) continue;
    if (t.building) {
      if (!pts.some((p) => near(p, 0))) continue;
      const ring = dist(pts[0]!, pts.at(-1)!) < 0.01 ? pts.slice(0, -1) : pts;
      if (ring.length < 3) continue;
      let far = 0;
      ring.forEach((p, i) => {
        if (dist(p, ring[0]!) > dist(ring[far]!, ring[0]!)) far = i;
      });
      const outline = [
        ...simplifyLine(ring.slice(0, far + 1), 0.7).slice(0, -1),
        ...simplifyLine([...ring.slice(far), ring[0]!], 0.7).slice(0, -1),
      ];
      if (outline.length >= 3) buildings.push(outline.map(round));
      continue;
    }
    const kind = t.highway ?? '';
    if (!DRIVE[kind] || t.area === 'yes' || (kind === 'service' && NO_SERVICE.has(t.service ?? '')))
      continue;
    if (!pts.some((p) => near(p, KEEP_MARGIN))) continue;
    roads.push({
      k: kind.replace('_link', '').replace('trunk', 'primary').replace('motorway', 'primary'),
      p: simplifyLine(pts, 0.8).map(round),
    });
  }
  return { formatVersion: 1, roads, buildings };
}

// ---------- загрузка и запись ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(url: string, init: RequestInit, label: string): Promise<Buffer> {
  for (let attempt = 0, wait = 10_000; ; attempt++, wait *= 2) {
    const response = await fetch(url, init);
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (attempt >= 5 || ![429, 502, 503, 504].includes(response.status))
      throw new Error(`${label}: HTTP ${response.status}`);
    console.log(`${label}: HTTP ${response.status}, retry in ${wait / 1000}s`);
    await sleep(wait);
  }
}

async function main() {
  const terrain = JSON.parse(await readFile(TERRAIN_SOURCE, 'utf8'));
  const bounds = terrain.worldBoundsXZ as {
    west: number;
    east: number;
    north: number;
    south: number;
  };
  const origin = terrain.originWgs84 as { lon: number; lat: number };
  const mpd = terrain.metresPerDegree as { lon: number; lat: number };
  const s = origin.lat - (bounds.south + FETCH_MARGIN) / mpd.lat,
    n = origin.lat - (bounds.north - FETCH_MARGIN) / mpd.lat,
    w = origin.lon + (bounds.west - FETCH_MARGIN) / mpd.lon,
    e = origin.lon + (bounds.east + FETCH_MARGIN) / mpd.lon;
  const b = [s, w, n, e].map((v) => v.toFixed(5)).join(',');
  const bw = [
    origin.lat - bounds.south / mpd.lat,
    origin.lon + bounds.west / mpd.lon,
    origin.lat - bounds.north / mpd.lat,
    origin.lon + bounds.east / mpd.lon,
  ]
    .map((v) => v.toFixed(5))
    .join(',');
  const query =
    `[out:json][timeout:180];(way[highway~"^(${Object.keys(DRIVE).join('|')})$"](${b});way[building](${bw});` +
    `node[highway=bus_stop](${b});node[public_transport=platform](${b});rel[type=route][route=bus](${b}););out body;>;out skel qt;`;
  const headers = { 'user-agent': 'su-world-build' };
  if (process.argv.includes('--fetch')) {
    await mkdir(T11_DIR, { recursive: true });
    const index = (await fetchRetry(T11, { headers }, 'transport11 index')).toString();
    const uris = [
      ...new Set(
        [...index.matchAll(/\/timetable\/syktyvkar\/(bus_[a-z0-9]+)"/g)].map((m) => m[1]!),
      ),
    ];
    for (const uri of uris) {
      await writeFile(
        `${T11_DIR}/${uri}.html`,
        await fetchRetry(`${T11}/${uri}`, { headers }, uri),
      );
      await sleep(2000);
    }
  }
  if (process.argv.includes('--fetch') || process.argv.includes('--fetch-osm')) {
    await mkdir(CACHE_DIR, { recursive: true });
    const osm = await fetchRetry(
      OVERPASS,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
      },
      'Overpass',
    );
    await writeFile(OSM_CACHE, osm);
  }
  const osmBytes = await readFile(OSM_CACHE).catch(() => {
    throw new Error(`${OSM_CACHE} is missing; run with --fetch`);
  });
  const snapshot = JSON.parse(osmBytes.toString()) as {
    osm3s?: { timestamp_osm_base?: string };
    elements: OsmElement[];
  };
  const overridesRaw = await readFile(OVERRIDES_FILE, 'utf8').catch(() => '');
  const overrides: BusNetworkOverrides = overridesRaw
    ? (JSON.parse(overridesRaw) as BusNetworkOverrides)
    : {};
  const files = (await readdir(T11_DIR)).filter((f) => f.endsWith('.html')).sort();
  const t11Hash = createHash('sha256');
  const t11: T11Route[] = [];
  for (const f of files) {
    const page = await readFile(`${T11_DIR}/${f}`, 'utf8');
    t11Hash.update(f).update(page);
    const r = parseT11(page);
    if (r.stops.length >= 2) t11.push(r);
  }
  const toGame = (p: { lat: number; lon: number }): Point2 => [
    (p.lon - origin.lon) * mpd.lon,
    -(p.lat - origin.lat) * mpd.lat,
  ];
  const { network, stats, graphVertices } = buildNetwork(
    t11,
    snapshot.elements,
    toGame,
    bounds,
    overrides,
  );

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}/network.json`, `${JSON.stringify(network)}\n`);
  const map = mapBackground(snapshot.elements, toGame, bounds);
  await writeFile(`${OUT_DIR}/map.json`, `${JSON.stringify(map)}\n`);
  const interpolated = network.stops.filter((s) => s.source === 'interpolated').map((s) => s.name);
  await writeFile(
    `${OUT_DIR}/provenance.json`,
    `${JSON.stringify(
      {
        formatVersion: 3,
        sources: {
          routes: {
            source: 'transport11.ru, main route pages (direction 0)',
            pages: files.length,
            sha256: t11Hash.digest('hex'),
          },
          geometry: {
            source: 'OpenStreetMap via Overpass API',
            license: 'ODbL 1.0, © OpenStreetMap contributors',
            osmTimestamp: snapshot.osm3s?.timestamp_osm_base,
            snapshotSha256: createHash('sha256').update(osmBytes).digest('hex'),
            query,
          },
          overrides: overridesRaw
            ? {
                file: OVERRIDES_FILE,
                sha256: createHash('sha256').update(overridesRaw).digest('hex'),
              }
            : undefined,
        },
        aliases: { ...ALIASES, ...overrides.aliases },
        clusterRadiusMetres: CLUSTER_RADIUS,
        graphVertices,
        legsRouted: stats.routed,
        legsOnewayFallback: stats.onewayFallback,
        legsUnrouted: stats.failed,
        routesInWorld: network.routes.length,
        stopsInWorld: network.stops.length,
        platformsInWorld: network.stops.reduce((n, s) => n + s.platforms.length, 0),
        interpolatedStops: interpolated,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `bus network: ${network.stops.length} stops (${network.stops.reduce((n, s) => n + s.platforms.length, 0)} platforms, ${interpolated.length} interpolated), ` +
      `${network.routes.length} routes; legs routed ${stats.routed}, oneway fallback ${stats.onewayFallback}, unrouted ${stats.failed}`,
  );
}

if (process.argv[1]?.endsWith('bus-network.ts')) await main();
