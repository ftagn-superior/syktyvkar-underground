/**
 * Разметка проезжей части и места светофоров по снимку OSM.
 *
 * Оси дорог берутся из OSM (`highway`, `lanes`, `oneway`), а ширина — из видимого
 * асфальта: лучи от оси до краёв многоугольников проезжей части. Поэтому полосы
 * всегда помещаются на нарисованную дорогу, даже если она уже реальной.
 * Разметка белая, как принято в России: двойная сплошная на широких дорогах,
 * прерывистые линии между полосами, «зебра» на переходах.
 */
import type { OsmElement, OsmSettings, OsmSnapshot } from './fetch-osm.js';
import { toGame } from './fetch-osm.js';
import type { Point2 } from './triangulate.js';

const CAR = /^(primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$/;
const MARKED = /^(primary|secondary|tertiary)(_link)?$/;
const LINE = 0.15;
const LANE = 2.75;

export interface RoadInput {
  settings: OsmSettings;
  snapshot: OsmSnapshot;
  /** Многоугольники проезжей части в игровых координатах. */
  roads: Point2[][];
}
interface Way {
  id: number;
  tags: Record<string, string>;
  points: Point2[];
  nodes: number[];
}
export interface SignalSpot {
  position: Point2;
  /** Направление, куда смотрит светофор: навстречу подъезжающим машинам. */
  facing: Point2;
}

const sub = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
const len = (v: Point2) => Math.hypot(v[0], v[1]);
const unit = (v: Point2): Point2 => {
  const l = len(v) || 1;
  return [v[0] / l, v[1] / l];
};
/** Левая нормаль направления в осях (x, z). */
const leftOf = (d: Point2): Point2 => [d[1], -d[0]];

/** Расстояние по лучу до ближайшего края проезжей части. */
function rayToEdge(origin: Point2, direction: Point2, roads: Point2[][], limit = 20): number {
  let best = limit;
  for (const ring of roads)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const e = sub(b, a);
      const den = direction[0] * e[1] - direction[1] * e[0];
      if (Math.abs(den) < 1e-9) continue;
      const w = sub(a, origin);
      const t = (w[0] * e[1] - w[1] * e[0]) / den;
      const u = (w[0] * direction[1] - w[1] * direction[0]) / den;
      if (t > 0.05 && t < best && u >= 0 && u <= 1) best = t;
    }
  return best;
}

export function roadNetwork({ settings, snapshot }: RoadInput) {
  const ways: Way[] = [];
  const position = new Map<number, Point2>();
  // Степень узла: сколько отрезков дорог к нему примыкает. Перекрёсток — от трёх.
  const degree = new Map<number, number>();
  for (const e of snapshot.elements as OsmElement[]) {
    if (e.type !== 'way' || !CAR.test(e.tags.highway ?? '') || !e.geometry || !e.nodes) continue;
    if (e.tags.area === 'yes') continue;
    const points = e.geometry.map(([lat, lon]) => toGame(settings, lat, lon));
    ways.push({ id: e.id, tags: e.tags, points, nodes: e.nodes });
    e.nodes.forEach((id, i) => {
      position.set(id, points[i]);
      const ends = (i > 0 ? 1 : 0) + (i < e.nodes!.length - 1 ? 1 : 0);
      degree.set(id, (degree.get(id) ?? 0) + ends);
    });
  }
  const nodes = new Map(
    (snapshot.elements as OsmElement[])
      .filter((e) => e.type === 'node')
      .map((e) => [e.id, e] as const),
  );
  return { ways, position, degree, nodes };
}

/** Полуширина видимой дороги в точке: среднее расстояний до краёв по обе стороны. */
function halfWidth(point: Point2, direction: Point2, roads: Point2[][], fallback: number) {
  const n = leftOf(direction);
  const left = rayToEdge(point, n, roads),
    right = rayToEdge(point, [-n[0], -n[1]], roads);
  if (left >= 20 || right >= 20) return fallback;
  return Math.min(fallback * 1.6, (left + right) / 2);
}

/** Прямоугольник шириной `width` вдоль отрезка [a, b], сдвинутый влево на `offset`. */
function strip(a: Point2, b: Point2, offset: number, width: number): Point2[] {
  const d = unit(sub(b, a)),
    n = leftOf(d);
  const o = (p: Point2, s: number): Point2 => [p[0] + n[0] * s, p[1] + n[1] * s];
  return [
    o(a, offset - width / 2),
    o(b, offset - width / 2),
    o(b, offset + width / 2),
    o(a, offset + width / 2),
  ];
}

export function roadMarkings(input: RoadInput) {
  const { ways, position, degree, nodes } = roadNetwork(input);
  const polygons: Point2[][][] = [];
  const stats = { lines: 0, crosswalks: 0 };
  const junctions = [...degree]
    .filter(([, d]) => d >= 3)
    .map(([id]) => position.get(id)!)
    .filter(Boolean);
  const crossingIds = new Set(
    [...nodes.values()]
      .filter(
        (n) => n.tags.highway === 'crossing' || n.tags.crossing || n.tags['crossing:markings'],
      )
      .map((n) => n.id),
  );
  const crossings = [...crossingIds].map((id) => position.get(id)).filter(Boolean) as Point2[];
  // Линии не заходят на перекрёстки и переходы.
  const clear = (p: Point2) =>
    junctions.every((j) => len(sub(p, j)) > 11) && crossings.every((c) => len(sub(p, c)) > 3.5);

  for (const way of ways) {
    if (!MARKED.test(way.tags.highway)) continue;
    const oneway =
      way.tags.oneway === 'yes' || way.tags.oneway === '-1' || way.tags.junction === 'roundabout';
    const tagged = parseInt(way.tags.lanes ?? '', 10);
    for (let i = 0; i + 1 < way.points.length; i++) {
      const a = way.points[i],
        b = way.points[i + 1];
      const length = len(sub(b, a));
      if (length < 1) continue;
      const d = unit(sub(b, a));
      const hw = halfWidth(
        [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        d,
        input.roads,
        (tagged || 2) * 1.6,
      );
      // Столько полос, сколько помещается на видимый асфальт, но не больше, чем в OSM.
      const fit = Math.max(1, Math.floor((2 * hw) / LANE));
      const lanes = Math.max(1, Math.min(Number.isFinite(tagged) ? tagged : fit, fit));
      const lines: { offset: number; dash: number; gap: number }[] = [];
      if (oneway) {
        const w = (2 * hw) / lanes;
        for (let k = 1; k < lanes; k++) lines.push({ offset: -hw + k * w, dash: 3, gap: 6 });
      } else {
        const perSide = Math.max(1, Math.floor(lanes / 2));
        const w = hw / perSide;
        if ((tagged || lanes) >= 4) {
          // Двойная сплошная между встречными потоками.
          lines.push(
            { offset: 0.12, dash: Infinity, gap: 0 },
            { offset: -0.12, dash: Infinity, gap: 0 },
          );
        } else lines.push({ offset: 0, dash: 4, gap: 4 });
        for (let k = 1; k < perSide; k++)
          lines.push({ offset: k * w, dash: 3, gap: 6 }, { offset: -k * w, dash: 3, gap: 6 });
      }
      for (const line of lines) {
        // Сплошные линии режутся на куски по 1,5 м, чтобы обрезка у перекрёстков была ровной.
        const piece = Number.isFinite(line.dash) ? line.dash : 1.5;
        const step = piece + line.gap;
        for (let s = 0; s + piece <= length + 1e-6; s += step) {
          const p0: Point2 = [a[0] + d[0] * s, a[1] + d[1] * s];
          const p1: Point2 = [a[0] + d[0] * (s + piece), a[1] + d[1] * (s + piece)];
          if (!clear([(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2])) continue;
          polygons.push([strip(p0, p1, line.offset, LINE)]);
          stats.lines++;
        }
      }
    }
  }

  // «Зебра»: полосы вдоль дороги, уложенные поперёк проезжей части.
  for (const id of crossingIds) {
    const node = nodes.get(id)!;
    const kind = node.tags.crossing ?? '';
    const markings = node.tags['crossing:markings'] ?? '';
    if (kind === 'unmarked' || kind === 'no' || markings === 'no') continue;
    const way = ways.find((w) => w.nodes.includes(id) && w.tags.highway !== 'service');
    if (!way) continue;
    const i = way.nodes.indexOf(id);
    const p = way.points[i];
    const prev = way.points[Math.max(0, i - 1)],
      next = way.points[Math.min(way.points.length - 1, i + 1)];
    const d = unit(sub(next, prev));
    const hw = halfWidth(p, d, input.roads, 4);
    const n = leftOf(d);
    const span = 2 * hw - 0.6;
    const count = Math.max(2, Math.floor((span + 0.6) / 1.1));
    for (let k = 0; k < count; k++) {
      const o = -span / 2 + 0.25 + (k * (span - 0.5)) / Math.max(1, count - 1);
      const c: Point2 = [p[0] + n[0] * o, p[1] + n[1] * o];
      polygons.push([
        strip(
          [c[0] - d[0] * 1.5, c[1] - d[1] * 1.5],
          [c[0] + d[0] * 1.5, c[1] + d[1] * 1.5],
          0,
          0.5,
        ),
      ]);
    }
    stats.crosswalks++;
  }
  return { polygons, stats };
}

/** Светофоры: по одному на каждое направление подъезда, справа от потока. */
export function trafficSignals(input: RoadInput): SignalSpot[] {
  const { ways, degree, nodes } = roadNetwork(input);
  const spots: SignalSpot[] = [];
  for (const node of nodes.values()) {
    if (node.tags.highway !== 'traffic_signals') continue;
    const junction = (degree.get(node.id) ?? 0) >= 3;
    for (const way of ways) {
      const i = way.nodes.indexOf(node.id);
      if (i < 0) continue;
      const p = way.points[i];
      const reverse = way.tags.oneway === '-1';
      const oneway = way.tags.oneway === 'yes' || reverse || way.tags.junction === 'roundabout';
      // Подъезд — соседняя точка, откуда едут к светофору; на односторонней — только встречная по ходу.
      const neighbours = [i - 1, i + 1].filter(
        (j) => j >= 0 && j < way.points.length && (!oneway || (reverse ? j > i : j < i)),
      );
      for (const j of neighbours) {
        const a = unit(sub(way.points[j], p));
        const hw = halfWidth(p, a, input.roads, 4);
        // Водитель едет в направлении −a; его правая сторона — (a.z, −a.x).
        const right: Point2 = [a[1], -a[0]];
        const back = junction ? 7 : 2.5;
        const at: Point2 = [
          p[0] + a[0] * back + right[0] * (hw + 0.8),
          p[1] + a[1] * back + right[1] * (hw + 0.8),
        ];
        if (spots.some((s) => len(sub(s.position, at)) < 2)) continue;
        spots.push({ position: at, facing: a });
      }
    }
  }
  return spots;
}
