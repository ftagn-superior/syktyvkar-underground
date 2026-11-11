/**
 * Мелкие объекты города из снимка OSM: ограды и стены, деревья, кусты, скамейки,
 * фонари, остановки, детские площадки. Объекты собираются в квадраты по 64 м:
 * каждый квадрат — одна модель вида `kit`, поэтому число вызовов отрисовки
 * растёт умеренно, а невидимые квадраты отсекаются камерой.
 */
import type { KitRecipe, KitShape } from './kit.js';
import type { OsmElement, OsmSettings, OsmSnapshot } from './fetch-osm.js';
import { toGame } from './fetch-osm.js';
import type { Point2 } from './triangulate.js';

export const CHUNK_SIZE = 64;

export interface DetailsInput {
  settings: OsmSettings;
  snapshot: OsmSnapshot;
  /** Прямоугольник мира в игровых координатах. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Контуры домов и проезжей части в игровых координатах. */
  footprints: Point2[][];
  roads: Point2[][];
  /** Точки, вокруг которых не ставятся деревья и кусты (старт, ящик, памятники). */
  clear: { x: number; z: number; radius: number }[];
}
export interface DetailsResult {
  chunks: { id: string; center: [number, number]; recipe: KitRecipe }[];
  /** Плоские слои земли для сборщика поверхности. */
  ground: { playground: Point2[][][]; parking: Point2[][][] };
  stats: Record<string, number>;
}

type Triple = [number, number, number];
type Part = { role: 'wall' | 'roof' | 'detail'; fade: boolean; color: string };
const PARTS: Record<string, Part> = {
  fence: { role: 'detail', fade: false, color: '#3d4248' },
  wall: { role: 'detail', fade: false, color: '#9b8f84' },
  retaining: { role: 'detail', fade: false, color: '#8f8b84' },
  hedge: { role: 'detail', fade: false, color: '#3f6b3c' },
  metal: { role: 'detail', fade: false, color: '#3a3d40' },
  wood: { role: 'detail', fade: false, color: '#80603f' },
  light: { role: 'detail', fade: false, color: '#f4f1e6' },
  glass: { role: 'detail', fade: false, color: '#9cc0cf' },
  sign: { role: 'detail', fade: false, color: '#2f6db5' },
  'play-red': { role: 'detail', fade: false, color: '#cf4a3a' },
  'play-yellow': { role: 'detail', fade: false, color: '#e2b13c' },
  bush: { role: 'detail', fade: false, color: '#4b7a3e' },
  'trunk-birch': { role: 'detail', fade: true, color: '#e2ddd2' },
  trunk: { role: 'detail', fade: true, color: '#6b5a49' },
  'crown-birch': { role: 'detail', fade: true, color: '#7aa457' },
  'crown-leaf': { role: 'detail', fade: true, color: '#55813f' },
  'crown-spruce': { role: 'detail', fade: true, color: '#3f6844' },
};

/** Детерминированное число 0…1 из строки. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}
const round = (n: number) => Math.round(n * 1000) / 1000;
const yawOf = (dx: number, dz: number) => (Math.atan2(-dz, dx) * 180) / Math.PI;
function inside([x, z]: Point2, ring: readonly Point2[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i],
      [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}
/** Ближайшая точка на рёбрах набора контуров и направление этого ребра. */
function nearestEdge(point: Point2, rings: Point2[][]) {
  let best = { distance: Infinity, at: point, direction: [1, 0] as Point2 };
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0],
        dz = b[1] - a[1];
      const length2 = dx * dx + dz * dz;
      if (length2 < 1e-6) continue;
      const t = Math.max(
        0,
        Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length2),
      );
      const at: Point2 = [a[0] + dx * t, a[1] + dz * t];
      const distance = Math.hypot(point[0] - at[0], point[1] - at[1]);
      if (distance < best.distance) {
        const length = Math.sqrt(length2);
        best = { distance, at, direction: [dx / length, dz / length] };
      }
    }
  return best;
}
/** Отсекает отрезок прямоугольником (Лян — Барски); возвращает доли [t0, t1] или null. */
function clipSegment(a: Point2, b: Point2, box: DetailsInput['bounds']): [number, number] | null {
  let t0 = 0,
    t1 = 1;
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - box.minX],
    [dx, box.maxX - a[0]],
    [-dz, a[1] - box.minZ],
    [dz, box.maxZ - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

export function buildDetails(input: DetailsInput): DetailsResult {
  const { settings, snapshot, bounds, footprints, roads, clear } = input;
  const project = (lat: number, lon: number): Point2 => toGame(settings, lat, lon);
  // Объекты держим на метр внутри границ: их модели должны целиком помещаться в мир.
  const inner = {
    minX: bounds.minX + 1,
    maxX: bounds.maxX - 1,
    minZ: bounds.minZ + 1,
    maxZ: bounds.maxZ - 1,
  };
  const within = ([x, z]: Point2, margin = 0) =>
    x - margin >= inner.minX &&
    x + margin <= inner.maxX &&
    z - margin >= inner.minZ &&
    z + margin <= inner.maxZ;
  const blocked = (p: Point2, radius = 0) =>
    footprints.some((ring) => inside(p, ring)) ||
    roads.some((ring) => inside(p, ring)) ||
    clear.some((c) => Math.hypot(c.x - p[0], c.z - p[1]) < c.radius + radius);

  const chunks = new Map<
    string,
    { center: [number, number]; parts: Map<string, KitShape[]>; colliders: KitRecipe['colliders'] }
  >();
  const stats: Record<string, number> = {};
  const count = (key: string, n = 1) => (stats[key] = (stats[key] ?? 0) + n);
  const chunkOf = ([x, z]: Point2) => {
    const ix = Math.floor(x / CHUNK_SIZE),
      iz = Math.floor(z / CHUNK_SIZE);
    const id = `details-${ix}-${iz}`.replace(/-(-)/g, '-m');
    let chunk = chunks.get(id);
    if (!chunk) {
      chunk = {
        center: [(ix + 0.5) * CHUNK_SIZE, (iz + 0.5) * CHUNK_SIZE],
        parts: new Map(),
        colliders: [],
      };
      chunks.set(id, chunk);
    }
    return chunk;
  };
  /** Объект кладётся в квадрат своей опорной точки; координаты переводятся в локальные. */
  const place = (anchor: Point2) => {
    const chunk = chunkOf(anchor);
    const local = (c: Triple): Triple => [
      round(c[0] - chunk.center[0]),
      round(c[1]),
      round(c[2] - chunk.center[1]),
    ];
    return {
      box(part: string, center: Triple, size: Triple, yaw = 0, collide = false) {
        const shape: KitShape = {
          box: { center: local(center), size: size.map(round) as Triple, yaw: round(yaw) },
        };
        (chunk.parts.get(part) ?? chunk.parts.set(part, []).get(part)!).push(shape);
        if (collide)
          chunk.colliders.push({
            id: `c${chunk.colliders.length}`,
            center: local(center),
            size: size.map(round) as Triple,
            yaw: round(yaw),
          });
      },
      cone(part: string, base: Triple, bottom: number, top: number, height: number, sides = 7) {
        const shape: KitShape = {
          cone: {
            center: local(base),
            radiusBottom: round(bottom),
            radiusTop: round(top),
            height: round(height),
            sides,
          },
        };
        (chunk.parts.get(part) ?? chunk.parts.set(part, []).get(part)!).push(shape);
      },
      cylinder(part: string, center: Triple, radius: number, length: number, sides = 8) {
        const shape: KitShape = {
          cylinder: {
            center: local(center),
            radius: round(radius),
            length: round(length),
            axis: 'y',
            sides,
          },
        };
        (chunk.parts.get(part) ?? chunk.parts.set(part, []).get(part)!).push(shape);
      },
      wedge(part: string, center: Triple, size: Triple, low: number, yaw: number) {
        const shape: KitShape = {
          wedge: {
            center: local(center),
            size: size.map(round) as Triple,
            low: round(low),
            yaw: round(yaw),
          },
        };
        (chunk.parts.get(part) ?? chunk.parts.set(part, []).get(part)!).push(shape);
      },
      collider(center: Triple, size: Triple, yaw = 0) {
        chunk.colliders.push({
          id: `c${chunk.colliders.length}`,
          center: local(center),
          size: size.map(round) as Triple,
          yaw: round(yaw),
        });
      },
    };
  };

  const elements = snapshot.elements;
  const nodesById = new Map(elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const height = (tags: Record<string, string>, fallback: number) => {
    const value = parseFloat(tags.height ?? '');
    return Number.isFinite(value) && value > 0.3 && value < 6 ? value : fallback;
  };

  // 1. Ограды, стены, живые изгороди. Калитки и ворота оставляют проход.
  const GATE_WIDTH: Record<string, number> = {
    gate: 3,
    lift_gate: 3.5,
    wicket_gate: 1.2,
    swing_gate: 3,
  };
  const BARRIERS: Record<string, { part: string; height: number; thickness: number }> = {
    fence: { part: 'fence', height: 1.6, thickness: 0.12 },
    wall: { part: 'wall', height: 2, thickness: 0.35 },
    retaining_wall: { part: 'retaining', height: 1, thickness: 0.4 },
    hedge: { part: 'hedge', height: 1.2, thickness: 0.9 },
  };
  for (const way of elements) {
    const spec = way.type === 'way' ? BARRIERS[way.tags.barrier] : undefined;
    if (!spec || !way.geometry) continue;
    const h = height(way.tags, spec.height);
    const points = way.geometry.map(([lat, lon]) => project(lat, lon));
    const gaps = points.map(
      (_, i) => GATE_WIDTH[nodesById.get(way.nodes?.[i] ?? -1)?.tags.barrier ?? ''] ?? 0,
    );
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i],
        b = points[i + 1];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 0.2) continue;
      const clipped = clipSegment(a, b, inner);
      if (!clipped) continue;
      // Проход у ворот на любом конце отрезка.
      let s0 = Math.max(clipped[0] * length, gaps[i] / 2);
      let s1 = Math.min(clipped[1] * length, length - gaps[i + 1] / 2);
      if (s1 - s0 < 0.3) continue;
      const d: Point2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
      const at = (s: number): Point2 => [a[0] + d[0] * s, a[1] + d[1] * s];
      const middle = at((s0 + s1) / 2);
      const span = s1 - s0,
        yaw = yawOf(d[0], d[1]);
      const put = place(middle);
      if (spec.part === 'fence') {
        // Прозрачная на вид ограда: две перекладины и столбы; столкновение — сплошное.
        put.box('fence', [middle[0], h - 0.04, middle[1]], [span, 0.08, spec.thickness], yaw);
        put.box('fence', [middle[0], h * 0.45, middle[1]], [span, 0.08, spec.thickness], yaw);
        const posts = Math.max(1, Math.round(span / 2.5));
        for (let k = 0; k <= posts; k++) {
          const p = at(s0 + (span * k) / posts);
          put.box('fence', [p[0], h / 2, p[1]], [spec.thickness, h, spec.thickness], yaw);
        }
        put.collider([middle[0], h / 2, middle[1]], [span, h, spec.thickness], yaw);
      } else {
        put.box(spec.part, [middle[0], h / 2, middle[1]], [span, h, spec.thickness], yaw, true);
      }
      count(way.tags.barrier);
    }
  }
  for (const node of elements) {
    if (node.type !== 'node' || node.tags.barrier !== 'bollard' || !node.point) continue;
    const p = project(...node.point);
    if (!within(p, 0.2)) continue;
    const put = place(p);
    put.cylinder('metal', [p[0], 0.45, p[1]], 0.1, 0.9);
    put.collider([p[0], 0.45, p[1]], [0.14, 0.9, 0.14]);
    count('bollard');
  }

  // 2. Деревья: отдельные, ряды, леса и кустарник.
  const addTree = (p: Point2, seed: string, tags: Record<string, string>) => {
    const needle = tags.leaf_type === 'needleleaved';
    const birch =
      !needle && (/betula/i.test(tags.genus ?? tags.species ?? '') || hash(seed + ':kind') < 0.7);
    const h =
      height({ height: tags.height ?? '' }, 0) ||
      (needle ? 8 : birch ? 9 : 8) + hash(seed + ':h') * 5;
    const radius = h * (needle ? 0.24 : birch ? 0.22 : 0.3);
    if (!within(p, radius * 1.5) || blocked(p, 1)) return false;
    const put = place(p);
    const trunkTop = h * (needle ? 0.25 : 0.38);
    put.box(
      birch ? 'trunk-birch' : 'trunk',
      [p[0], trunkTop / 2, p[1]],
      [0.3, trunkTop, 0.3],
      hash(seed) * 90,
    );
    put.collider([p[0], trunkTop / 2, p[1]], [0.4, trunkTop, 0.4]);
    if (needle) {
      put.cone('crown-spruce', [p[0], trunkTop * 0.7, p[1]], radius, 0, h * 0.6);
      put.cone('crown-spruce', [p[0], h * 0.5, p[1]], radius * 0.7, 0, h * 0.5);
    } else {
      const bottom = trunkTop * 0.85,
        span = h - bottom;
      const part = birch ? 'crown-birch' : 'crown-leaf';
      put.cone(part, [p[0], bottom, p[1]], radius * 0.55, radius, span * 0.4);
      put.cone(part, [p[0], bottom + span * 0.4, p[1]], radius, radius * 0.35, span * 0.6);
    }
    count(needle ? 'tree-spruce' : birch ? 'tree-birch' : 'tree-leaf');
    return true;
  };
  for (const node of elements)
    if (node.type === 'node' && node.tags.natural === 'tree' && node.point)
      addTree(project(...node.point), `tree:${node.id}`, node.tags);
  const scatter = (
    way: OsmElement,
    spacing: number,
    cap: number,
    add: (p: Point2, seed: string) => boolean,
  ) => {
    if (!way.geometry) return;
    const ring = way.geometry.map(([lat, lon]) => project(lat, lon));
    const xs = ring.map((p) => p[0]),
      zs = ring.map((p) => p[1]);
    let placed = 0;
    for (
      let x = Math.floor(Math.min(...xs) / spacing) * spacing;
      x <= Math.max(...xs);
      x += spacing
    )
      for (
        let z = Math.floor(Math.min(...zs) / spacing) * spacing;
        z <= Math.max(...zs);
        z += spacing
      ) {
        if (placed >= cap) return;
        const seed = `${way.id}:${x}:${z}`;
        const p: Point2 = [
          x + (hash(seed + 'x') - 0.5) * spacing * 0.7,
          z + (hash(seed + 'z') - 0.5) * spacing * 0.7,
        ];
        if (inside(p, ring) && add(p, seed)) placed++;
      }
  };
  for (const way of elements) {
    if (way.type !== 'way') continue;
    if (way.tags.natural === 'tree_row' && way.geometry) {
      const points = way.geometry.map(([lat, lon]) => project(lat, lon));
      for (let i = 0; i + 1 < points.length; i++) {
        const [a, b] = [points[i], points[i + 1]];
        const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 7));
        for (let k = 0; k < n; k++)
          addTree(
            [a[0] + ((b[0] - a[0]) * (k + 0.5)) / n, a[1] + ((b[1] - a[1]) * (k + 0.5)) / n],
            `row:${way.id}:${i}:${k}`,
            way.tags,
          );
      }
    } else if (way.tags.natural === 'wood' || way.tags.landuse === 'forest')
      scatter(way, 9, 80, (p, seed) => addTree(p, `wood:${seed}`, way.tags));
    else if (way.tags.natural === 'scrub')
      scatter(way, 5, 60, (p, seed) => {
        if (!within(p, 1.5) || blocked(p, 0.8)) return false;
        const r = 0.8 + hash(seed) * 0.5;
        const put = place(p);
        put.cone('bush', [p[0], 0, p[1]], r, r * 0.6, 1.1 + hash(seed + 'h') * 0.5);
        put.collider([p[0], 0.5, p[1]], [r * 1.2, 1, r * 1.2]);
        count('bush');
        return true;
      });
  }

  // 3. Скамейки, фонари, остановки: ориентируются по ближайшей дорожке или дороге.
  for (const node of elements) {
    if (node.type !== 'node' || !node.point) continue;
    const p = project(...node.point);
    if (!within(p, 2)) continue;
    if (node.tags.amenity === 'bench') {
      const { direction } = nearestEdge(p, roads);
      const yaw = yawOf(...direction);
      const back: Point2 = [direction[1] * 0.2, -direction[0] * 0.2];
      const put = place(p);
      put.box('wood', [p[0], 0.45, p[1]], [1.8, 0.08, 0.44], yaw);
      put.box('wood', [p[0] + back[0], 0.75, p[1] + back[1]], [1.8, 0.4, 0.06], yaw);
      for (const side of [-0.8, 0.8])
        put.box(
          'metal',
          [p[0] + direction[0] * side, 0.22, p[1] + direction[1] * side],
          [0.08, 0.44, 0.4],
          yaw,
        );
      put.collider([p[0], 0.45, p[1]], [1.8, 0.9, 0.4], yaw);
      count('bench');
    } else if (node.tags.highway === 'street_lamp') {
      const near = nearestEdge(p, roads);
      const toward: Point2 =
        near.distance > 0.1
          ? [(near.at[0] - p[0]) / near.distance, (near.at[1] - p[1]) / near.distance]
          : [1, 0];
      const yaw = yawOf(...toward);
      const put = place(p);
      put.box('metal', [p[0], 3.25, p[1]], [0.16, 6.5, 0.16]);
      put.box('metal', [p[0] + toward[0] * 0.6, 6.4, p[1] + toward[1] * 0.6], [1.3, 0.1, 0.1], yaw);
      put.box(
        'light',
        [p[0] + toward[0] * 1.2, 6.28, p[1] + toward[1] * 1.2],
        [0.55, 0.16, 0.3],
        yaw,
      );
      put.collider([p[0], 3.25, p[1]], [0.16, 6.5, 0.16]);
      count('lamp');
    } else if (node.tags.highway === 'bus_stop') {
      const near = nearestEdge(p, roads);
      const yaw = yawOf(...near.direction);
      // Локальная ось z направлена к дороге: задняя стенка павильона — от неё.
      const away: Point2 =
        near.distance > 0.1
          ? [(p[0] - near.at[0]) / near.distance, (p[1] - near.at[1]) / near.distance]
          : [0, 1];
      const at = (s: number, o: number, y: number): Triple => [
        p[0] + near.direction[0] * s + away[0] * o,
        y,
        p[1] + near.direction[1] * s + away[1] * o,
      ];
      const put = place(p);
      if (node.tags.shelter !== 'no') {
        put.box('metal', at(0, 0.7, 2.5), [3.6, 0.12, 1.6], yaw);
        put.box('glass', at(0, 1.45, 1.2), [3.6, 2.2, 0.06], yaw, true);
        for (const side of [-1.77, 1.77])
          put.box('glass', at(side, 0.7, 1.2), [0.06, 2.2, 1.5], yaw, true);
        put.box('wood', at(0, 1.2, 0.45), [2.4, 0.08, 0.4], yaw);
        count('bus-shelter');
      }
      put.box('metal', at(2.4, 0, 1.3), [0.1, 2.6, 0.1], yaw, true);
      put.box('sign', at(2.4, 0, 2.45), [0.6, 0.4, 0.05], yaw);
      count('bus-stop');
    }
  }

  // 4. Детские площадки и парковки: слои земли и простой игровой комплекс.
  const ground: DetailsResult['ground'] = { playground: [], parking: [] };
  for (const way of elements) {
    if (way.type !== 'way' || !way.geometry) continue;
    const ring = way.geometry.slice(0, -1).map(([lat, lon]) => project(lat, lon));
    if (ring.length < 3) continue;
    if (way.tags.amenity === 'parking') {
      ground.parking.push([ring]);
      count('parking');
    } else if (way.tags.leisure === 'playground') {
      ground.playground.push([ring]);
      const c: Point2 = [
        ring.reduce((s, q) => s + q[0], 0) / ring.length,
        ring.reduce((s, q) => s + q[1], 0) / ring.length,
      ];
      if (!within(c, 4) || blocked(c, 2) || !inside(c, ring)) continue;
      const yaw = hash(`play:${way.id}`) * 360;
      const u: Point2 = [Math.cos((yaw * Math.PI) / 180), -Math.sin((yaw * Math.PI) / 180)];
      const v: Point2 = [-u[1], u[0]];
      const at = (a: number, b: number, y: number): Triple => [
        c[0] + u[0] * a + v[0] * b,
        y,
        c[1] + u[1] * a + v[1] * b,
      ];
      const put = place(c);
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ])
        put.box('play-yellow', at(a, b, 1.25), [0.12, 2.5, 0.12], yaw);
      put.box('play-red', at(0, 0, 1.4), [2.2, 0.12, 2.2], yaw, true);
      put.box('play-red', at(0, 0, 2.5), [2.3, 0.6, 2.3], yaw);
      put.wedge('play-yellow', at(2.6, 0, 0), [3, 1.4, 0.8], 0.05, yaw + 180);
      count('playground');
    }
  }

  const result: DetailsResult['chunks'] = [];
  for (const [id, chunk] of [...chunks].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!chunk.colliders.length) continue;
    const parts = [...chunk.parts]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([part, shapes]) => ({ id: part, ...PARTS[part], shapes }));
    result.push({
      id,
      center: chunk.center,
      recipe: { formatVersion: 1, parts, colliders: chunk.colliders, merge: true },
    });
  }
  stats.chunks = result.length;
  return { chunks: result, ground, stats };
}
