/**
 * Автобусная сеть ring-block: маршруты «Транспорт 11», координаты и дороги OpenStreetMap.
 *
 *   pnpm world:bus:network -- --fetch   # скачать снимки в output/bus-network/
 *   pnpm world:bus:network              # пересчитать сеть из сохранённых снимков
 *
 * Пишет `content/worlds/ring-block/bus-network/network.json` и `provenance.json`.
 * Сборка мира эти данные не читает.
 *
 * Источники и их роль:
 * - transport11.ru — какие маршруты ходят и порядок остановок. Берутся только основные
 *   страницы маршрутов (направление 0): обратное направление и карта закрыты robots.txt.
 * - OSM, остановки (`highway=bus_stop`, `public_transport=platform`) — координаты. Имена
 *   сопоставляются после нормализации и по таблице {@link ALIASES}.
 * - OSM, автомобильные дороги — путь автобуса между остановками (Дейкстра с учётом
 *   одностороннего движения), чтобы линии на карте шли по улицам, а не сквозь дома.
 *
 * Остановка без точки в OSM между двумя известными остановками мира ставится на путь
 * автобуса пропорционально порядку (`source: "interpolated"`) — её нужно проверить вручную.
 * Маршрут с одним направлением на сайте считается двусторонним (`twoWay`): автобус
 * возвращается тем же путём, хотя на односторонних улицах фактический путь другой.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const TERRAIN_SOURCE = 'content/worlds/ring-block/terrain-expansion/source.json';
const OUT_DIR = 'content/worlds/ring-block/bus-network';
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

type Point2 = [number, number];
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
type OsmElement = OsmNode | OsmWay | { type: 'relation' };

export interface BusStop {
  id: string;
  name: string;
  /** Мировые X/Z, м: среднее платформ или точка на пути автобуса. */
  position: Point2;
  platforms: Point2[];
  routes: string[];
  source: 'osm' | 'interpolated';
}
export type BusSequenceEntry = string | { offWorld: string[] };
export interface BusRoute {
  id: string;
  ref: string;
  name: string;
  from: string;
  to: string;
  /** Кольцевой рейс: из любой остановки можно доехать до любой другой. */
  circular: boolean;
  /** Известно одно направление; автобус возвращается тем же путём. */
  twoWay: boolean;
  transport11: string;
  /** Остановки мира (id) и свёрнутые участки вне мира в порядке следования. */
  sequence: BusSequenceEntry[];
  /** Путь по дорогам между соседними остановками мира в `sequence`: legs[i] — куски ломаной. */
  legs: Point2[][][];
}
export interface BusNetwork {
  formatVersion: 2;
  stops: BusStop[];
  routes: BusRoute[];
}

// ---------- имена ----------

/** Нормализованное имя «Транспорт 11» → нормализованное имя OSM. */
export const ALIASES: Record<string, string> = {
  драмтеатр: 'театр драмы',
  'жд вокзал': 'вокзал',
  'торговый центр аврора': 'аврора',
  педколледж: 'педучилище',
  'школа искусства': 'школа искусств',
  интернациональная: 'интернациональная-пушкина',
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
function buildGraph(ways: OsmWay[], nodes: Map<number, Point2>): Graph {
  const pos: Point2[] = [];
  const out: [number, number, number][][] = [];
  const main: boolean[] = [];
  const way: number[] = [];
  const index = new Map<string, number>();
  let wayId = 0;
  const vertex = (key: string, p: Point2, isMain: boolean) => {
    let v = index.get(key);
    if (v === undefined) {
      index.set(key, (v = pos.length));
      pos.push(p);
      out.push([]);
      main.push(false);
      way.push(wayId);
    }
    if (isMain) main[v] = true;
    return v;
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
      for (let v = u; prev.has(v);) path.push((v = prev.get(v)!));
      found.set(u, { cost: c, path: path.reverse() });
    }
    const edges = back ? [...g.out[u]!, ...back[u]!] : g.out[u]!;
    for (const [v, w] of edges) {
      const nc = c + w;
      if (nc < (cost.get(v) ?? Infinity)) {
        cost.set(v, nc);
        prev.set(v, u);
        heap.push([nc, v]);
      }
    }
  }
  return found;
}
let reverseCache: { g: Graph; back: [number, number, number][][] } | undefined;
function reverseAdjacency(g: Graph) {
  if (reverseCache?.g === g) return reverseCache.back;
  const back: [number, number, number][][] = g.pos.map(() => []);
  g.out.forEach((edges, u) => edges.forEach(([v, c, l]) => back[v]!.push([u, c, l])));
  reverseCache = { g, back };
  return back;
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
/**
 * Вершины всех проезжих частей рядом с платформой: у разделённой улицы в OSM часто есть
 * платформа только одной стороны, а автобус этого направления едет по другой.
 */
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
    // Ближайшая вершина каждого пути OSM: обе проезжие части попадают в кандидаты.
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

// ---------- сборка сети ----------

interface Cluster {
  key: string;
  osmName: string;
  pts: Point2[];
}
export function buildNetwork(
  t11: T11Route[],
  osm: OsmElement[],
  toGame: (p: { lat: number; lon: number }) => Point2,
  bounds: { west: number; east: number; north: number; south: number },
) {
  const inWorld = ([x, z]: Point2, m = 0) =>
    x >= bounds.west - m && x <= bounds.east + m && z >= bounds.north - m && z <= bounds.south + m;
  const centre = (c: Cluster): Point2 => [
    c.pts.reduce((s, p) => s + p[0], 0) / c.pts.length,
    c.pts.reduce((s, p) => s + p[1], 0) / c.pts.length,
  ];
  const nodes = new Map<number, Point2>();
  const clusters: Cluster[] = [];
  for (const e of osm) {
    if (e.type !== 'node') continue;
    const p = toGame(e);
    nodes.set(e.id, p);
    const t = e.tags ?? {};
    if (!t.name || (t.highway !== 'bus_stop' && t.public_transport !== 'platform')) continue;
    const key = normName(t.name);
    // По расстоянию до центра, а не до любой платформы: цепочка платформ одного имени
    // (у «Рынка» четыре на 450 м) иначе слипается в одну остановку посреди квартала.
    const c = clusters.find((c) => c.key === key && dist(centre(c), p) < CLUSTER_RADIUS / 2);
    if (c) c.pts.push(p);
    else clusters.push({ key, osmName: t.name, pts: [p] });
  }
  const byKey = new Map<string, Cluster[]>();
  for (const c of clusters) (byKey.get(c.key) ?? byKey.set(c.key, []).get(c.key)!).push(c);

  const g = buildGraph(
    osm.filter((e): e is OsmWay => e.type === 'way'),
    nodes,
  );
  const snap = snapper(g);
  const snapMany = snapperMany(g, snap);

  // Сопоставление: одно имя может встречаться в разных местах — берём ближайшее к соседям.
  type Resolved = { name: string; cluster?: Cluster; pos?: Point2 };
  const resolve = (r: T11Route): Resolved[] => {
    const res: Resolved[] = r.stops.map((name) => ({ name }));
    const candidates = (name: string) => {
      const key = normName(name);
      return byKey.get(ALIASES[key] ?? key) ?? [];
    };
    for (const s of res) {
      const c = candidates(s.name);
      if (c.length === 1) [s.cluster, s.pos] = [c[0], centre(c[0]!)];
    }
    for (let pass = 0; pass < 2; pass++)
      res.forEach((s, i) => {
        if (s.cluster) return;
        const c = candidates(s.name);
        const near = [res[i - 1]?.pos, res[i + 1]?.pos].filter((p): p is Point2 => !!p);
        if (!c.length || !near.length) return;
        const best = c
          .map((cl) => ({ cl, d: Math.min(...near.map((p) => dist(p, centre(cl)))) }))
          .sort((a, b) => a.d - b.d)[0]!;
        if (best.d < 3000) [s.cluster, s.pos] = [best.cl, centre(best.cl)];
      });
    return res;
  };

  const stopsById = new Map<string, BusStop>();
  const stopFor = (name: string, cluster: Cluster | undefined, pos: Point2): string => {
    for (const s of stopsById.values())
      if (normName(s.name) === normName(name) && dist(s.position, pos) < CLUSTER_RADIUS)
        return s.id;
    let id = slug(name);
    for (let n = 2; stopsById.has(id); n++) id = `${slug(name)}-${n}`;
    stopsById.set(id, {
      id,
      name,
      position: [r1(pos[0]), r1(pos[1])],
      platforms: (cluster?.pts ?? [pos]).map((p) => [r1(p[0]), r1(p[1])] as Point2),
      routes: [],
      source: cluster ? 'osm' : 'interpolated',
    });
    return id;
  };

  const routes: BusRoute[] = [];
  const stats = { routed: 0, onewayFallback: 0, failed: 0, interpolated: 0 };
  for (const r of t11) {
    const res = resolve(r);
    if (!res.some((s) => s.pos && inWorld(s.pos))) continue;
    // Путь между соседними известными остановками, если хоть одна из них близко к миру.
    // Платформу каждой остановки выбираем для всего маршрута сразу (динамика по цепочке):
    // жадный выбор ставит автобус на платформу не той стороны, и к следующей остановке он
    // разворачивается через кольцо — на карте лишний круг.
    const known = res.flatMap((s, i) => (s.pos ? [i] : []));
    const pieces = new Map<number, Point2[]>(); // индекс начала → путь до следующей известной
    const cands = known.map((i) => {
      const pts = res[i]!.cluster!.pts;
      const vs = new Map<number, number>(); // вершина → штраф за удаление от платформы
      for (const p of pts)
        for (const v of snapMany(p))
          vs.set(v, Math.min(vs.get(v) ?? Infinity, dist(p, g.pos[v]!) * 2));
      return vs;
    });
    type State = { cost: number; back?: { v: number; path: number[] } };
    const layers: Map<number, State>[] = [];
    const fresh = (k: number) =>
      new Map([...cands[k]!].map(([v, pen]) => [v, { cost: pen } as State]));
    const argmin = (layer: Map<number, State>) =>
      [...layer].sort((x, y) => x[1].cost - y[1].cost)[0]?.[0];
    for (let k = 0; k < known.length; k++) {
      const prevLayer = layers[k - 1];
      const a = res[known[k - 1]!],
        b = res[known[k]!]!;
      const near = a && (inWorld(a.pos!, FETCH_MARGIN / 2) || inWorld(b.pos!, FETCH_MARGIN / 2));
      if (!prevLayer || !prevLayer.size || !cands[k]!.size || !near) {
        layers.push(fresh(k));
        continue;
      }
      const targets = [...cands[k]!.keys()];
      const straight = dist(a!.pos!, b.pos!);
      const limit = straight * 6 + 2500;
      const solve = (loose: boolean) => {
        const layer = new Map<number, State>();
        let best = Infinity;
        for (const [u, st] of prevLayer) {
          for (const [v, leg] of routeAll(g, u, targets, limit, loose)) {
            best = Math.min(best, leg.cost);
            const c = st.cost + leg.cost + cands[k]!.get(v)!;
            if (c < (layer.get(v)?.cost ?? Infinity))
              layer.set(v, { cost: c, back: { v: u, path: leg.path } });
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
    // Обратный проход: по лучшей цепочке, через разрывы — от лучшего состояния слоя.
    let v = layers.length ? argmin(layers.at(-1)!) : undefined;
    for (let k = layers.length - 1; k >= 0 && v !== undefined; k--) {
      const st = layers[k]!.get(v)!;
      if (st.back) {
        pieces.set(
          known[k - 1]!,
          st.back.path.map((x) => g.pos[x]!),
        );
        v = st.back.v;
      } else v = k > 0 ? argmin(layers[k - 1]!) : undefined;
    }
    // Неизвестные остановки между двумя известными остановками мира — на путь пропорционально.
    for (let k = 1; k < known.length; k++) {
      const a = known[k - 1]!,
        b = known[k]!;
      const path = pieces.get(a);
      if (b - a < 2 || !path || path.length < 2 || !inWorld(res[a]!.pos!) || !inWorld(res[b]!.pos!))
        continue;
      const cum = [0];
      for (let j = 1; j < path.length; j++) cum.push(cum[j - 1]! + dist(path[j - 1]!, path[j]!));
      // Путь режется в точках новых остановок: каждой достаётся свой кусок до следующей.
      let rest = path,
        restStart = 0;
      for (let i = a + 1; i < b; i++) {
        const target = (cum.at(-1)! * (i - a)) / (b - a);
        const found = cum.findIndex((c) => c >= target);
        const j = found < 1 ? (found === 0 ? 1 : path.length - 1) : found;
        const t = (target - cum[j - 1]!) / Math.max(1e-9, cum[j]! - cum[j - 1]!);
        const p: Point2 = [
          path[j - 1]![0] + (path[j]![0] - path[j - 1]![0]) * t,
          path[j - 1]![1] + (path[j]![1] - path[j - 1]![1]) * t,
        ];
        res[i]!.pos = p;
        pieces.set(i - 1, [...rest.slice(0, j - restStart), p]);
        rest = [p, ...path.slice(j)];
        restStart = j - 1;
        stats.interpolated++;
      }
      pieces.set(b - 1, rest);
    }
    // Порядок остановок мира и пути между ними.
    // Для быстрых поездок нужны хотя бы две остановки мира; междугородние (5xx) не берём.
    const worldNames = new Set(
      res.filter((s) => s.pos && inWorld(s.pos)).map((s) => normName(s.name)),
    );
    if (worldNames.size < 2 || Number.parseInt(r.ref, 10) >= 500) continue;
    const ids = res.map((s) =>
      s.pos && inWorld(s.pos) ? stopFor(s.name, s.cluster, s.pos) : undefined,
    );
    const sequence: BusSequenceEntry[] = [];
    const legs: Point2[][][] = [];
    let leg: Point2[] = [];
    const flush = (into: Point2[][], line: Point2[]) => {
      // Храним только части пути рядом с миром; вершины не упрощаются — общие улицы совпадают.
      // Заезд в тупик и обратно (карман остановки, проезд к платформе) — «зубец» на карте:
      // вершина, после которой путь возвращается в предыдущую, удаляется вместе с повтором.
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
    for (let i = 0; i < res.length; i++) {
      const id = ids[i];
      if (id) {
        if (started) {
          const parts: Point2[][] = [];
          flush(parts, leg);
          legs.push(parts);
        }
        if (sequence.at(-1) !== id) sequence.push(id);
        else if (started) legs.pop();
        started = true;
        leg = [];
      } else {
        const last = sequence.at(-1);
        if (last && typeof last === 'object') last.offWorld.push(res[i]!.name);
        else sequence.push({ offWorld: [res[i]!.name] });
      }
      const piece = pieces.get(i);
      if (piece) leg.push(...piece);
      else if (res[i]!.pos && known.includes(i)) {
        // Нет пути (за краем графа): разрыв в геометрии, карта покажет пунктир.
        leg.push([NaN, NaN]);
      }
    }
    const ref = r.ref;
    const circular = normName(r.stops[0] ?? '') === normName(r.stops.at(-1) ?? '');
    const [from, to] =
      r.name.split(/\s+—\s+/).length > 1
        ? [r.name.split(/\s+—\s+/)[0]!, r.name.split(/\s+—\s+/).at(-1)!]
        : [r.stops[0] ?? '', r.stops.at(-1) ?? ''];
    for (const e of sequence) if (typeof e === 'string') stopsById.get(e)!.routes.push(ref);
    routes.push({
      id: slug(r.uri.replace(/^bus_/, '')),
      ref,
      name: r.name,
      from,
      to,
      circular,
      twoWay: !circular,
      transport11: `${T11}/${r.uri}`,
      sequence,
      legs,
    });
  }
  const stops = [...stopsById.values()]
    .map((s) => ({ ...s, routes: [...new Set(s.routes)].sort(compareRef) }))
    .filter((s) => s.routes.length)
    .sort((a, b) => a.id.localeCompare(b.id));
  routes.sort((a, b) => compareRef(a.ref, b.ref));
  return {
    network: { formatVersion: 2 as const, stops, routes },
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
  const near = ([x, z]: Point2, m: number) =>
    x >= bounds.west - m && x <= bounds.east + m && z >= bounds.north - m && z <= bounds.south + m;
  const nodes = new Map<number, Point2>();
  for (const e of elements) if (e.type === 'node') nodes.set(e.id, toGame(e));
  const round = (p: Point2): Point2 => [r1(p[0]), r1(p[1])];
  const roads: BusMapBackground['roads'] = [];
  const buildings: Point2[][] = [];
  for (const e of elements) {
    if (e.type !== 'way') continue;
    const t = e.tags ?? {};
    const pts = e.nodes.map((n) => nodes.get(n)).filter((p): p is Point2 => !!p);
    if (pts.length < 2) continue;
    if (t.building) {
      if (!pts.some((p) => near(p, 0))) continue;
      const ring = dist(pts[0]!, pts.at(-1)!) < 0.01 ? pts.slice(0, -1) : pts;
      if (ring.length < 3) continue;
      // Замкнутый контур делится в самой дальней точке, иначе упрощение схлопнет его.
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
  // Дома нужны только для подложки карты в игре, поэтому — лишь в границах мира.
  const bw = [
    origin.lat - bounds.south / mpd.lat,
    origin.lon + bounds.west / mpd.lon,
    origin.lat - bounds.north / mpd.lat,
    origin.lon + bounds.east / mpd.lon,
  ]
    .map((v) => v.toFixed(5))
    .join(',');
  const query =
    `[out:json][timeout:180];(way[highway~"^(${Object.keys(DRIVE).join('|')})$"](${b});way[building](${bw}););out body;>;out skel qt;` +
    `(node[highway=bus_stop](${b});node[public_transport=platform](${b}););out body;`;
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
      // Только основные страницы маршрутов, по одной в 2 с: направление 1 и карта закрыты robots.txt.
      await writeFile(
        `${T11_DIR}/${uri}.html`,
        await fetchRetry(`${T11}/${uri}`, { headers }, uri),
      );
      await sleep(2000);
    }
  }
  // `--fetch-osm` обновляет только снимок OSM, не трогая страницы «Транспорт 11».
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
  const { network, stats, graphVertices } = buildNetwork(t11, snapshot.elements, toGame, bounds);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}/network.json`, `${JSON.stringify(network)}\n`);
  const map = mapBackground(snapshot.elements, toGame, bounds);
  await writeFile(`${OUT_DIR}/map.json`, `${JSON.stringify(map)}\n`);
  const interpolated = network.stops.filter((s) => s.source === 'interpolated').map((s) => s.name);
  await writeFile(
    `${OUT_DIR}/provenance.json`,
    `${JSON.stringify(
      {
        formatVersion: 2,
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
        },
        aliases: ALIASES,
        clusterRadiusMetres: CLUSTER_RADIUS,
        graphVertices,
        legsRouted: stats.routed,
        legsOnewayFallback: stats.onewayFallback,
        legsUnrouted: stats.failed,
        routesInWorld: network.routes.length,
        stopsInWorld: network.stops.length,
        interpolatedStops: interpolated,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `bus network: ${network.stops.length} stops (${interpolated.length} interpolated), ` +
      `${network.routes.length} routes; legs routed ${stats.routed}, oneway fallback ${stats.onewayFallback}, unrouted ${stats.failed}`,
  );
}

if (process.argv[1]?.endsWith('bus-network.ts')) await main();
