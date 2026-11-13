/**
 * Съёмка фасадов зданий ring-block через Google Street View Static API.
 *
 * Для каждого фасада (ребра контура длиннее --min-facade) скрипт ищет панорамы
 * перед стеной (metadata-запросы бесплатны), выбирает точку с лучшим обзором
 * без загораживающих зданий, наводит камеру на фасад и скачивает кадр 640×640.
 * Положение камеры известно точно, поэтому контуры зданий проецируются в кадр:
 * разметка лежит в manifest.json и рисуется страницей reference/streetview/index.html.
 *
 * Ключ: GOOGLE_MAPS_KEY в окружении или в .env (файл в .gitignore).
 *
 *   pnpm reference:streetview --building osm-way-1258973447
 *   pnpm reference:streetview --match "Октябрьский" --dry-run
 *   pnpm reference:streetview --all --max-images 600
 *
 * Флаги:
 *   --building <id[,id]>  здания по OSM-ID (можно повторять)
 *   --match <текст>       здания, у которых текст встречается в имени, описании или ID
 *   --all                 все здания ring-block
 *   --dry-run             только план (metadata-запросы бесплатны), без скачивания кадров
 *   --views <n>           сколько разных точек съёмки на фасад (по умолчанию 1)
 *   --min-facade <м>      минимальная длина фасада (по умолчанию 6)
 *   --max-images <n>      предохранитель от расходов (по умолчанию 150)
 *   --force               перекачать уже скачанные кадры
 *   --index-only          только пересобрать index.html из готовых manifest.json
 *   --mark                нарисовать разметку поверх уже скачанных кадров выбранных зданий
 *                         в <osm-id>/marked/ (без сети и ключа; удобно ИИ-агентам)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDINGS_DIR = join(ROOT, 'content/buildings/ring-block');
const CELLS_DIR = join(ROOT, 'content/worlds/ring-block/cells');
const OUT_DIR = join(ROOT, 'reference/streetview');
const CACHE_FILE = join(OUT_DIR, '.cache/metadata.json');

// Та же привязка, что в tools/inspect-ring-elevation.py: x — восток, z — юг, метры.
const ORIGIN = { lat: 61.66386729706631, lon: 50.815951774241576 };
const SCALE = { lon: 52837.29, lat: 110573.15 };

const CAMERA_HEIGHT = 2.5; // высота камеры автомобиля Google над землёй
const IMAGE_SIZE = 640; // максимум бесплатного Static API
const MAX_FOV = 120;
const MERGE_ANGLE = 15; // соседние рёбра с меньшим поворотом считаются одним фасадом
const CANDIDATE_DISTANCES = [14, 24, 38];
const SEARCH_RADIUS = 25;
const MAX_PANO_DISTANCE = 90;
const OTHER_BUILDINGS_RADIUS = 150;
const SIDES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const SEGMENT_MAX = 32; // длинный фасад режется на части, каждая снимается со своей точки
const SEGMENT_TARGET = 30;

type Vec = { x: number; z: number };
type Pixel = [number, number];
type Point3 = [number, number, number]; // x, z, высота

interface Building {
  id: string;
  name: string;
  description: string;
  outline: Vec[];
  normals: Vec[]; // внешняя нормаль ребра i (outline[i] → outline[i+1])
  height: number; // максимальная, для перекрытий
  baseHeight: number;
  sections: Array<{ outline: Vec[]; height: number }>;
  centroid: Vec;
}

interface Facade {
  key: string;
  side: string;
  points: Vec[];
  a: Vec;
  b: Vec;
  mid: Vec;
  normal: Vec;
  length: number;
  height: number;
  edges: number[];
  part?: { index: number; count: number; parent: string; whole: Vec[] };
}

interface Pano {
  id: string;
  date: string | null;
  lat: number;
  lng: number;
  pos: Vec;
}

interface Obstacle {
  a: Vec;
  b: Vec;
  height: number;
  building: string;
  edge: number;
}

interface Overlay {
  kind: 'target' | 'same' | 'other';
  building: string;
  points: Pixel[];
  anchor?: Pixel;
}

interface Shot {
  file: string;
  heading: number;
  pitch: number;
  fov: number;
  overlays: Overlay[];
  error?: string;
}

interface Candidate {
  pano: Pano;
  distance: number;
  incidence: number;
  visibility: number;
  score: number;
}

interface View {
  facade: string;
  panoId: string;
  date: string | null;
  pano: Vec;
  panoLatLng: { lat: number; lng: number };
  distance: number;
  incidence: number;
  visibility: number;
  shots: Shot[];
}

interface Manifest {
  formatVersion: 1;
  id: string;
  name: string;
  description: string;
  height: number;
  outline: Vec[];
  facades: Array<
    Pick<Facade, 'key' | 'side' | 'points' | 'normal' | 'length' | 'height'> & {
      part?: [number, number];
    }
  >;
  views: View[];
  missing: string[];
  generatedAt: string;
}

interface MetadataResult {
  status: string;
  pano_id?: string;
  date?: string;
  location?: { lat: number; lng: number };
}

// ---------- геометрия ----------

const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, z: a.z + b.z });
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, z: a.z - b.z });
const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, z: a.z * k });
const dot = (a: Vec, b: Vec) => a.x * b.x + a.z * b.z;
const cross = (a: Vec, b: Vec) => a.x * b.z - a.z * b.x;
const len = (a: Vec) => Math.hypot(a.x, a.z);
const norm = (a: Vec): Vec => mul(a, 1 / (len(a) || 1));
const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  z: a.z + (b.z - a.z) * t,
});
const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const wrap360 = (a: number) => ((a % 360) + 360) % 360;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits = 2) => Number(v.toFixed(digits));

const toLocal = (lat: number, lng: number): Vec => ({
  x: (lng - ORIGIN.lon) * SCALE.lon,
  z: -(lat - ORIGIN.lat) * SCALE.lat,
});
const toLatLng = (v: Vec) => ({
  lat: ORIGIN.lat - v.z / SCALE.lat,
  lng: ORIGIN.lon + v.x / SCALE.lon,
});

/** Азимут вектора по часовой от севера, градусы. */
const bearingOf = (v: Vec) => wrap360(deg(Math.atan2(v.x, -v.z)));
const sideOf = (normal: Vec) => SIDES[Math.round(bearingOf(normal) / 45) % 8];

function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x)
      inside = !inside;
  }
  return inside;
}

/** Параметр t на отрезке p→q, где он пересекает отрезок a→b, или null. */
function segmentHit(p: Vec, q: Vec, a: Vec, b: Vec): number | null {
  const r = sub(q, p);
  const s = sub(b, a);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9) return null;
  const ap = sub(a, p);
  const t = cross(ap, s) / den;
  const u = cross(ap, r) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / (dot(ab, ab) || 1), 0, 1);
  return len(sub(p, lerp(a, b, t)));
}

/** Луч камеры к точке на высоте endHeight перекрыт зданием, которое выше луча в точке пересечения. */
function isBlocked(
  from: Vec,
  to: Vec,
  endHeight: number,
  obstacles: Obstacle[],
  skip: (o: Obstacle) => boolean,
): boolean {
  for (const o of obstacles) {
    if (skip(o)) continue;
    const t = segmentHit(from, to, o.a, o.b);
    if (t === null || t < 1e-3 || t > 0.999) continue;
    if (o.height > CAMERA_HEIGHT + t * (endHeight - CAMERA_HEIGHT)) return true;
  }
  return false;
}

// ---------- данные мира ----------

function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function loadBuildings(): Building[] {
  const placements = new Map<string, Vec>();
  for (const file of readdirSync(CELLS_DIR).filter((f) => f.endsWith('.json'))) {
    const cell = readJson(join(CELLS_DIR, file));
    for (const entry of cell.buildings ?? []) {
      if (typeof entry.assetId !== 'string' || !entry.assetId.startsWith('osm-way-')) continue;
      const r = entry.rotation;
      if (r && (Math.abs(r.x) > 1e-6 || Math.abs(r.y) > 1e-6 || Math.abs(r.z) > 1e-6)) {
        throw new Error(`${entry.assetId}: повёрнутые здания пока не поддерживаются`);
      }
      placements.set(entry.assetId, { x: entry.position.x, z: entry.position.z });
    }
  }

  const buildings: Building[] = [];
  for (const [id, position] of placements) {
    const dir = join(BUILDINGS_DIR, id);
    if (!existsSync(join(dir, 'source.json'))) continue;
    const source = readJson(join(dir, 'source.json'));
    const asset = readJson(join(dir, 'asset.json'));
    const raw: Vec[] = source.outline.map(([x, z]: [number, number]) => ({
      x: x + position.x,
      z: z + position.z,
    }));
    const outline: Vec[] = [];
    for (const p of raw)
      if (!outline.length || len(sub(p, outline[outline.length - 1])) > 0.05) outline.push(p);
    if (outline.length > 2 && len(sub(outline[0], outline[outline.length - 1])) < 0.05)
      outline.pop();
    if (outline.length < 3) continue;

    // Реальная высота: heightScale — игровое преувеличение, его не учитываем.
    const baseHeight = source.height ?? 6;
    const sections = ((source.sections ?? []) as any[]).map((s) => ({
      outline: s.outline.map(([x, z]: [number, number]) => ({
        x: x + position.x,
        z: z + position.z,
      })),
      height: s.height ?? baseHeight,
    }));
    const height = Math.max(baseHeight, ...sections.map((s) => s.height));
    const normals = outline.map((p, i) => {
      const q = outline[(i + 1) % outline.length];
      let n = norm({ x: -(q.z - p.z), z: q.x - p.x });
      if (pointInPolygon(add(lerp(p, q, 0.5), mul(n, 0.2)), outline)) n = mul(n, -1);
      return n;
    });
    const centroid = mul(outline.reduce(add, { x: 0, z: 0 }), 1 / outline.length);
    buildings.push({
      id,
      name: asset.metadata?.name ?? id,
      description: asset.metadata?.description ?? '',
      outline,
      normals,
      height,
      baseHeight,
      sections,
      centroid,
    });
  }
  return buildings;
}

/** Склеивает почти коллинеарные соседние рёбра в фасады. */
function facadesOf(b: Building, minLength: number): Facade[] {
  const pts = b.outline;
  const n = pts.length;
  const dir = (i: number) => norm(sub(pts[(i + 1) % n], pts[i % n]));
  const turn = (u: Vec, v: Vec) => Math.abs(deg(Math.atan2(cross(u, v), dot(u, v))));

  let start = 0;
  for (let i = 0; i < n; i++) {
    if (turn(dir((i - 1 + n) % n), dir(i)) >= MERGE_ANGLE) {
      start = i;
      break;
    }
  }

  const groups: number[][] = [];
  let groupDir: Vec | null = null;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (!groupDir || turn(groupDir, dir(i)) >= MERGE_ANGLE) {
      groups.push([]);
      groupDir = dir(i);
    }
    groups[groups.length - 1].push(i);
  }

  const facades: Facade[] = [];
  const sideCount = new Map<string, number>();
  for (const edges of groups) {
    const points = [...edges.map((i) => pts[i]), pts[(edges[edges.length - 1] + 1) % n]];
    const a = points[0];
    const b2 = points[points.length - 1];
    const length = len(sub(b2, a));
    if (length < minLength) continue;
    const longest = edges.reduce((best, i) =>
      len(sub(pts[(i + 1) % n], pts[i])) > len(sub(pts[(best + 1) % n], pts[best])) ? i : best,
    );
    let normal = norm({ x: -(b2.z - a.z), z: b2.x - a.x });
    if (dot(normal, b.normals[longest]) < 0) normal = mul(normal, -1);
    const side = sideOf(normal);
    const count = (sideCount.get(side) ?? 0) + 1;
    sideCount.set(side, count);
    const key = count === 1 ? side : `${side}${count}`;
    const dirAB = norm(sub(b2, a));
    if (length <= SEGMENT_MAX) {
      const mid = lerp(a, b2, 0.5);
      facades.push({
        key,
        side,
        points,
        a,
        b: b2,
        mid,
        normal,
        length,
        height: heightAt(b, mid, dirAB),
        edges,
      });
      continue;
    }
    const parts = Math.ceil(length / SEGMENT_TARGET);
    for (let i = 0; i < parts; i++) {
      const pa = lerp(a, b2, i / parts);
      const pb = lerp(a, b2, (i + 1) / parts);
      const mid = lerp(pa, pb, 0.5);
      facades.push({
        key: `${key}.${i + 1}`,
        side,
        points: [pa, pb],
        a: pa,
        b: pb,
        mid,
        normal,
        length: length / parts,
        height: heightAt(b, mid, dirAB),
        edges,
        part: { index: i + 1, count: parts, parent: key, whole: points },
      });
    }
  }
  return facades;
}

/** Высота стены в точке: секция с параллельным ребром рядом, иначе общая высота здания. */
function heightAt(b: Building, p: Vec, dir: Vec): number {
  let best: number | null = null;
  for (const s of b.sections) {
    for (let i = 0; i < s.outline.length; i++) {
      const q1 = s.outline[i];
      const q2 = s.outline[(i + 1) % s.outline.length];
      if (Math.abs(cross(norm(sub(q2, q1)), dir)) > 0.26) continue;
      if (distanceToSegment(p, q1, q2) > 2) continue;
      best = Math.max(best ?? 0, s.height);
    }
  }
  return best ?? b.baseHeight;
}

function obstaclesOf(buildings: Building[]): Obstacle[] {
  return buildings.flatMap((b) =>
    b.outline.map((p, i) => ({
      a: p,
      b: b.outline[(i + 1) % b.outline.length],
      height: b.height,
      building: b.id,
      edge: i,
    })),
  );
}

// ---------- Google API ----------

function loadKey(): string {
  if (process.env.GOOGLE_MAPS_KEY) return process.env.GOOGLE_MAPS_KEY.trim();
  const envFile = join(ROOT, '.env');
  const match = existsSync(envFile)
    ? readFileSync(envFile, 'utf8').match(/^GOOGLE_MAPS_KEY=(.+)$/m)
    : null;
  if (!match) throw new Error('Нет GOOGLE_MAPS_KEY ни в окружении, ни в .env');
  return match[1].trim().replace(/^["']|["']$/g, '');
}

const hideKey = (text: string, key: string) => text.split(key).join('***');

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

async function collectPanos(points: Vec[], key: string): Promise<Map<string, Pano>> {
  const cache: Record<string, MetadataResult> = existsSync(CACHE_FILE) ? readJson(CACHE_FILE) : {};
  const queries = new Map<string, { lat: number; lng: number }>();
  for (const p of points) {
    const { lat, lng } = toLatLng(p);
    queries.set(`${lat.toFixed(5)},${lng.toFixed(5)},r${SEARCH_RADIUS}`, { lat, lng });
  }
  const todo = [...queries].filter(([k]) => !cache[k]);
  if (todo.length)
    console.log(
      `Metadata-запросов: ${todo.length} (бесплатно), из кэша: ${queries.size - todo.length}`,
    );

  let done = 0;
  try {
    await pool(todo, 6, async ([cacheKey, { lat, lng }]) => {
      const url =
        `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat.toFixed(6)},${lng.toFixed(6)}` +
        `&radius=${SEARCH_RADIUS}&source=outdoor&key=${key}`;
      const res = await fetch(url);
      const json = (await res.json()) as MetadataResult & { error_message?: string };
      if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
        throw new Error(
          hideKey(`Street View metadata: ${json.status} ${json.error_message ?? ''}`, key),
        );
      }
      cache[cacheKey] = {
        status: json.status,
        pano_id: json.pano_id,
        date: json.date,
        location: json.location,
      };
      if (++done % 100 === 0) console.log(`  ${done}/${todo.length}`);
    });
  } finally {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  }

  // Пул — все известные панорамы, а не только найденные для выбранных зданий: так выбор точки
  // съёмки не зависит от того, запущен скрипт для одного здания или для всего участка.
  const panos = new Map<string, Pano>();
  for (const r of Object.values(cache)) {
    if (r?.status !== 'OK' || !r.pano_id || !r.location) continue;
    panos.set(r.pano_id, {
      id: r.pano_id,
      date: r.date ?? null,
      lat: r.location.lat,
      lng: r.location.lng,
      pos: toLocal(r.location.lat, r.location.lng),
    });
  }
  return panos;
}

async function downloadImage(shot: Shot, panoId: string, path: string, key: string): Promise<void> {
  const url =
    `https://maps.googleapis.com/maps/api/streetview?size=${IMAGE_SIZE}x${IMAGE_SIZE}&pano=${panoId}` +
    `&heading=${shot.heading}&pitch=${shot.pitch}&fov=${shot.fov}&return_error_code=true&key=${key}`;
  const res = await fetch(url);
  if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) {
    const body = await res.text().catch(() => '');
    throw new Error(hideKey(`HTTP ${res.status} ${body.slice(0, 200)}`, key));
  }
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
}

// ---------- выбор точки съёмки и кадрирование ----------

function candidatePoints(f: Facade): Vec[] {
  const along = f.length > 40 ? [0.25, 0.5, 0.75] : [0.5];
  return along.flatMap((t) =>
    CANDIDATE_DISTANCES.map((d) => add(lerp(f.a, f.b, t), mul(f.normal, d))),
  );
}

function evaluate(pano: Pano, f: Facade, b: Building, obstacles: Obstacle[]): Candidate | null {
  const v = sub(pano.pos, f.mid);
  const distance = len(v);
  if (distance < 4 || distance > MAX_PANO_DISTANCE) return null;
  const cosInc = dot(norm(v), f.normal);
  if (cosInc < Math.cos(rad(75))) return null;

  const samples = [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9];
  // Точка стены видна, если открыта середина или верх: забор или гараж не прячет весь фасад.
  const heights = [Math.max(3, f.height * 0.5), f.height * 0.9];
  const skip = (o: Obstacle) => o.building === b.id && f.edges.includes(o.edge);
  const visible = samples.filter((t) => {
    const point = add(lerp(f.a, f.b, t), mul(f.normal, 0.3));
    return heights.some((h) => !isBlocked(pano.pos, point, h, obstacles, skip));
  }).length;
  const visibility = visible / samples.length;
  if (visibility < 0.34) return null;

  // Слишком близкие панорамы дают «рыбий глаз» на краях кадра.
  const distanceScore =
    distance < 6
      ? 0.2
      : distance < 14
        ? 0.4 + (0.6 * (distance - 6)) / 8
        : distance <= 35
          ? 1
          : 35 / distance;
  const spread = framing(pano, f).spread;
  const score =
    visibility * Math.pow(cosInc, 0.7) * distanceScore * (spread > MAX_FOV - 12 ? 0.85 : 1);
  return { pano, distance, incidence: deg(Math.acos(clamp(cosInc, -1, 1))), visibility, score };
}

function framing(pano: Pano, f: Facade) {
  const midBearing = bearingOf(sub(f.mid, pano.pos));
  const rel = f.points.map((p) => wrap180(bearingOf(sub(p, pano.pos)) - midBearing));
  const lo = Math.min(...rel);
  const hi = Math.max(...rel);
  const near = Math.min(
    ...f.points.slice(1).map((p, i) => distanceToSegment(pano.pos, f.points[i], p)),
  );
  const top = deg(Math.atan2(f.height - CAMERA_HEIGHT, near));
  const bottom = deg(Math.atan2(-CAMERA_HEIGHT, near));
  return { center: wrap360(midBearing + (lo + hi) / 2), spread: hi - lo, top, bottom };
}

function planShots(pano: Pano, f: Facade, baseName: string): Shot[] {
  const { center, spread, top, bottom } = framing(pano, f);
  const hNeeded = spread + 12;
  const vNeeded = top - bottom + 10;
  const pitch = round(clamp((top + bottom) / 2, -10, 40), 1);
  const tiles = hNeeded > MAX_FOV ? Math.min(3, Math.ceil(hNeeded / 105)) : 1;
  const step = hNeeded / tiles;
  const fov = round(clamp(Math.max(tiles > 1 ? step + 12 : hNeeded, vNeeded, 35), 10, MAX_FOV), 1);
  return Array.from({ length: tiles }, (_, i) => ({
    file: tiles > 1 ? `${baseName}-${i + 1}.jpg` : `${baseName}.jpg`,
    heading: round(wrap360(center + (i - (tiles - 1) / 2) * step), 1),
    pitch,
    fov,
    overlays: [],
  }));
}

// ---------- проекция контуров в кадр ----------

interface Camera {
  pos: Vec;
  heading: number;
  pitch: number;
  fov: number;
}

function projectPolygon(poly: Point3[], cam: Camera): Pixel[] | null {
  const h = rad(cam.heading);
  const p = rad(cam.pitch);
  const fwd = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
  const right = [Math.cos(h), -Math.sin(h), 0];
  const up = [-Math.sin(h) * Math.sin(p), -Math.cos(h) * Math.sin(p), Math.cos(p)];
  const d3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // В координаты камеры: восток, север, верх относительно объектива.
  const local = poly.map(([x, z, y]) => {
    const v = [x - cam.pos.x, -(z - cam.pos.z), y - CAMERA_HEIGHT];
    return [d3(v, right), d3(v, up), d3(v, fwd)];
  });

  // Отсечение ближней плоскостью (Сазерленд — Ходжман).
  const NEAR = 0.3;
  const clipped: number[][] = [];
  for (let i = 0; i < local.length; i++) {
    const a = local[i];
    const b = local[(i + 1) % local.length];
    if (a[2] >= NEAR) clipped.push(a);
    if (a[2] >= NEAR !== b[2] >= NEAR) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      clipped.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
    }
  }
  if (clipped.length < 3) return null;

  const focal = IMAGE_SIZE / 2 / Math.tan(rad(cam.fov / 2));
  const px = clipped.map(([cx, cy, cz]): Pixel => [
    round(IMAGE_SIZE / 2 + (focal * cx) / cz, 1),
    round(IMAGE_SIZE / 2 - (focal * cy) / cz, 1),
  ]);
  const xs = px.map((q) => q[0]);
  const ys = px.map((q) => q[1]);
  if (
    Math.max(...xs) < 0 ||
    Math.min(...xs) > IMAGE_SIZE ||
    Math.max(...ys) < 0 ||
    Math.min(...ys) > IMAGE_SIZE
  )
    return null;
  return px;
}

const wallQuad = (points: Vec[], height: number): Point3[] => [
  ...points.map((p): Point3 => [p.x, p.z, 0]),
  ...[...points].reverse().map((p): Point3 => [p.x, p.z, height]),
];

function projectPoint(p: Vec, height: number, cam: Camera): Pixel | undefined {
  const tiny: Point3[] = [
    [p.x, p.z, height],
    [p.x + 0.01, p.z, height],
    [p.x, p.z + 0.01, height],
  ];
  const px = projectPolygon(tiny, cam);
  if (!px) return undefined;
  const [x, y] = px[0];
  return x >= 0 && x <= IMAGE_SIZE && y >= 0 && y <= IMAGE_SIZE ? px[0] : undefined;
}

function overlaysFor(
  cam: Camera,
  target: Building,
  f: Facade,
  buildings: Building[],
  obstacles: Obstacle[],
): Overlay[] {
  const out: Overlay[] = [];
  if (f.part) {
    const whole = projectPolygon(wallQuad(f.part.whole, f.height), cam);
    if (whole) out.push({ kind: 'same', building: target.id, points: whole });
  }
  const quad = projectPolygon(wallQuad(f.points, f.height), cam);
  if (quad) {
    out.push({
      kind: 'target',
      building: target.id,
      points: quad,
      anchor: projectPoint(f.mid, f.height, cam) ?? projectPoint(f.mid, f.height * 0.5, cam),
    });
  }

  for (const b of buildings) {
    if (b.id !== target.id && len(sub(b.centroid, cam.pos)) > OTHER_BUILDINGS_RADIUS) continue;
    let anchor: Pixel | undefined;
    let anchorLength = 0;
    for (let i = 0; i < b.outline.length; i++) {
      if (b.id === target.id && f.edges.includes(i)) continue;
      const p = b.outline[i];
      const q = b.outline[(i + 1) % b.outline.length];
      const edgeLength = len(sub(q, p));
      if (edgeLength < 2.5) continue;
      const mid = lerp(p, q, 0.5);
      if (dot(sub(cam.pos, mid), b.normals[i]) <= 0) continue; // ребро смотрит от камеры
      const skip = (o: Obstacle) => o.building === b.id && o.edge === i;
      if (
        isBlocked(
          cam.pos,
          add(mid, mul(b.normals[i], 0.3)),
          Math.max(3, b.height * 0.5),
          obstacles,
          skip,
        )
      )
        continue;
      const wallHeight = b.id === target.id ? heightAt(b, mid, norm(sub(q, p))) : b.height;
      const px = projectPolygon(wallQuad([p, q], wallHeight), cam);
      if (!px) continue;
      out.push({ kind: b.id === target.id ? 'same' : 'other', building: b.id, points: px });
      if (b.id !== target.id && edgeLength > anchorLength) {
        const a = projectPoint(mid, b.height * 0.6, cam);
        if (a) {
          anchor = a;
          anchorLength = edgeLength;
        }
      }
    }
    if (anchor) out.push({ kind: 'other', building: b.id, points: [], anchor });
  }
  return out;
}

// ---------- index.html ----------

function writeIndex(buildings: Building[]) {
  const manifests: Manifest[] = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(OUT_DIR, d.name, 'manifest.json')))
    .map((d) => readJson<Manifest>(join(OUT_DIR, d.name, 'manifest.json')))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const world = buildings.map((b) => ({
    id: b.id,
    name: b.name,
    outline: b.outline.map((p) => [round(p.x, 1), round(p.z, 1)]),
  }));
  const data = JSON.stringify({ manifests, world, imageSize: IMAGE_SIZE }).replace(/</g, '\\u003c');
  const template = readFileSync(join(ROOT, 'tools/streetview-review.html'), 'utf8');
  writeFileSync(
    join(OUT_DIR, 'index.html'),
    template.replace('__DATA__', () => data),
  );
  return manifests.length;
}

// ---------- размеченные копии кадров ----------

const SIDE_RU: Record<string, string> = {
  N: 'север',
  NE: 'северо-восток',
  E: 'восток',
  SE: 'юго-восток',
  S: 'юг',
  SW: 'юго-запад',
  W: 'запад',
  NW: 'северо-запад',
};
const CAPTION_HEIGHT = 30;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function markedHtml(
  m: Manifest,
  view: View,
  shot: Shot,
  imageBase64: string,
  names: Map<string, string>,
): string {
  const facade = m.facades.find((f) => f.key === view.facade)!;
  const order = { other: 0, same: 1, target: 2 };
  const items = [...shot.overlays].sort((a, b) => order[a.kind] - order[b.kind]);
  const polygons = items
    .filter((o) => o.points.length)
    .map(
      (o) => `<polygon class="${o.kind}" points="${o.points.map((p) => p.join(',')).join(' ')}"/>`,
    )
    .join('');
  const labels = items
    .filter((o) => o.anchor)
    .map((o) => {
      const text =
        o.kind === 'target' ? `фасад ${view.facade}` : (names.get(o.building) ?? o.building);
      const x = clamp(o.anchor![0], 70, IMAGE_SIZE - 70);
      const y = clamp(o.anchor![1] - 8, 18, IMAGE_SIZE - 8);
      return `<text class="${o.kind}" x="${x}" y="${y}">${escapeHtml(text)}</text>`;
    })
    .join('');
  const part = facade.part ? `, часть ${facade.part[0]} из ${facade.part[1]}` : '';
  const caption = `${m.name} · ${m.id} · ${view.facade} (${SIDE_RU[facade.side]}${part}) · ${view.date ?? '?'}`;
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #111; }
    .cap { height: ${CAPTION_HEIGHT}px; padding: 0 10px; color: #fff; font: 600 14px/${CAPTION_HEIGHT}px system-ui, sans-serif;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: #1d1f23; }
    .frame { position: relative; width: ${IMAGE_SIZE}px; height: ${IMAGE_SIZE}px; }
    .frame img, .frame svg { position: absolute; inset: 0; }
    polygon.target { fill: rgba(229, 52, 90, 0.16); stroke: #e5345a; stroke-width: 3; }
    polygon.same { fill: none; stroke: #f08a24; stroke-width: 2; stroke-dasharray: 6 4; }
    polygon.other { fill: none; stroke: #1b9fd6; stroke-width: 1.5; }
    text { font: 600 15px system-ui, sans-serif; text-anchor: middle; paint-order: stroke;
      stroke: rgba(0, 0, 0, 0.75); stroke-width: 4px; fill: #fff; }
    text.other { fill: #bfe9ff; font-size: 12px; }
  </style>
  <div class="cap">${escapeHtml(caption)}</div>
  <div class="frame"><img src="data:image/jpeg;base64,${imageBase64}" width="${IMAGE_SIZE}" height="${IMAGE_SIZE}">
  <svg width="${IMAGE_SIZE}" height="${IMAGE_SIZE}" viewBox="0 0 ${IMAGE_SIZE} ${IMAGE_SIZE}">${polygons}${labels}</svg></div>`;
}

async function writeMarked(ids: string[], buildings: Building[]): Promise<number> {
  const { chromium } = await import('playwright');
  // Как в tests/helpers/browser.ts; без скачанного Chromium берём установленный Chrome.
  const browser = await chromium
    .launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
    .catch(() => chromium.launch({ channel: 'chrome' }));
  const names = new Map(buildings.map((b) => [b.id, b.name]));
  let count = 0;
  try {
    const page = await browser.newPage({
      viewport: { width: IMAGE_SIZE, height: IMAGE_SIZE + CAPTION_HEIGHT },
    });
    for (const id of ids) {
      const dir = join(OUT_DIR, id);
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        console.warn(`${id}: нет manifest.json — сначала скачайте кадры`);
        continue;
      }
      const m = readJson<Manifest>(manifestPath);
      const outDir = join(dir, 'marked');
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      for (const view of m.views) {
        for (const shot of view.shots) {
          const file = join(dir, shot.file);
          if (shot.error || !existsSync(file)) continue;
          await page.setContent(
            markedHtml(m, view, shot, readFileSync(file).toString('base64'), names),
          );
          await page.screenshot({ path: join(outDir, shot.file), type: 'jpeg', quality: 88 });
          count++;
        }
      }
    }
  } finally {
    await browser.close();
  }
  return count;
}

// ---------- main ----------

function parseArgs(argv: string[]) {
  const args = {
    buildings: [] as string[],
    match: [] as string[],
    all: false,
    dryRun: false,
    views: 1,
    minFacade: 6,
    maxImages: 150,
    force: false,
    indexOnly: false,
    mark: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a}: нужно значение`);
      return v;
    };
    if (a === '--building') args.buildings.push(...value().split(','));
    else if (a === '--match') args.match.push(value().toLowerCase());
    else if (a === '--all') args.all = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--views') args.views = Math.max(1, Number(value()));
    else if (a === '--min-facade') args.minFacade = Number(value());
    else if (a === '--max-images') args.maxImages = Number(value());
    else if (a === '--force') args.force = true;
    else if (a === '--index-only') args.indexOnly = true;
    else if (a === '--mark') args.mark = true;
    else throw new Error(`Неизвестный флаг ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const buildings = loadBuildings();
  mkdirSync(OUT_DIR, { recursive: true });

  if (args.indexOnly) {
    console.log(`index.html: ${writeIndex(buildings)} зданий`);
    return;
  }

  const selected = buildings.filter(
    (b) =>
      args.all ||
      args.buildings.includes(b.id) ||
      args.match.some((m) => `${b.id} ${b.name} ${b.description}`.toLowerCase().includes(m)),
  );
  const unknown = args.buildings.filter((id) => !buildings.some((b) => b.id === id));
  if (unknown.length) throw new Error(`Не найдены здания: ${unknown.join(', ')}`);
  if (!selected.length)
    throw new Error('Не выбрано ни одного здания: укажите --building, --match или --all');

  if (args.mark) {
    const count = await writeMarked(
      selected.map((b) => b.id),
      buildings,
    );
    console.log(`Размечено кадров: ${count} → reference/streetview/<osm-id>/marked/`);
    return;
  }

  const key = loadKey();
  const obstacles = obstaclesOf(buildings);
  const work = selected.map((b) => ({ building: b, facades: facadesOf(b, args.minFacade) }));
  const facadeCount = work.reduce((n, w) => n + w.facades.length, 0);
  console.log(`Зданий: ${selected.length}, фасадов: ${facadeCount}`);

  const panos = await collectPanos(
    work.flatMap((w) => w.facades.flatMap(candidatePoints)),
    key,
  );
  console.log(`Найдено панорам: ${panos.size}`);

  const plans: Array<{ building: Building; facades: Facade[]; views: View[]; missing: string[] }> =
    [];
  for (const { building, facades } of work) {
    const views: View[] = [];
    const missing: string[] = [];
    for (const f of facades) {
      const ranked = [...panos.values()]
        .map((p) => evaluate(p, f, building, obstacles))
        .filter((c): c is Candidate => c !== null)
        .sort((a, b) => b.score - a.score);
      const chosen: Candidate[] = [];
      for (const c of ranked) {
        if (chosen.length >= args.views) break;
        const angle = bearingOf(sub(c.pano.pos, f.mid));
        if (chosen.some((o) => Math.abs(wrap180(bearingOf(sub(o.pano.pos, f.mid)) - angle)) < 25))
          continue;
        chosen.push(c);
      }
      if (!chosen.length) missing.push(f.key);
      chosen.forEach((c, i) => {
        const shots = planShots(c.pano, f, i ? `${f.key}-v${i + 1}` : f.key);
        for (const s of shots)
          s.overlays = overlaysFor({ pos: c.pano.pos, ...s }, building, f, buildings, obstacles);
        views.push({
          facade: f.key,
          panoId: c.pano.id,
          date: c.pano.date,
          pano: { x: round(c.pano.pos.x), z: round(c.pano.pos.z) },
          panoLatLng: { lat: c.pano.lat, lng: c.pano.lng },
          distance: round(c.distance, 1),
          incidence: round(c.incidence, 0),
          visibility: round(c.visibility, 2),
          shots,
        });
      });
    }
    plans.push({ building, facades, views, missing });
  }

  // Кадр перекачивается, если файла нет или изменились панорама либо наводка камеры.
  const signature = (panoId: string, s: Shot) => `${panoId}|${s.heading}|${s.pitch}|${s.fov}`;
  const previous = new Map<string, Map<string, string>>();
  for (const p of plans) {
    const path = join(OUT_DIR, p.building.id, 'manifest.json');
    const old = existsSync(path) ? readJson<Manifest>(path) : null;
    previous.set(
      p.building.id,
      new Map(
        (old?.views ?? []).flatMap((v) =>
          v.shots
            .filter((s) => !s.error)
            .map((s): [string, string] => [s.file, signature(v.panoId, s)]),
        ),
      ),
    );
  }
  const pending = plans.flatMap((p) =>
    p.views.flatMap((v) =>
      v.shots
        .filter(
          (s) =>
            args.force ||
            !existsSync(join(OUT_DIR, p.building.id, s.file)) ||
            previous.get(p.building.id)!.get(s.file) !== signature(v.panoId, s),
        )
        .map((s) => ({ plan: p, view: v, shot: s })),
    ),
  );

  for (const p of plans) {
    console.log(`\n${p.building.name} (${p.building.id})`);
    for (const v of p.views) {
      console.log(
        `  ${v.facade.padEnd(6)} панорама ${v.date ?? '?'} · ${v.distance} м · угол ${v.incidence}° · ` +
          `видно ${Math.round(v.visibility * 100)}% · кадров ${v.shots.length}`,
      );
    }
    if (p.missing.length) console.log(`  без панорамы: ${p.missing.join(', ')}`);
  }
  console.log(`\nНовых кадров к скачиванию: ${pending.length}`);

  if (args.dryRun) return;
  if (pending.length > args.maxImages) {
    throw new Error(
      `Это больше --max-images ${args.maxImages}. Поднимите лимит, если расход ожидаем.`,
    );
  }

  let done = 0;
  await pool(pending, 4, async ({ plan, view, shot }) => {
    const dir = join(OUT_DIR, plan.building.id);
    mkdirSync(dir, { recursive: true });
    try {
      await downloadImage(shot, view.panoId, join(dir, shot.file), key);
    } catch (error) {
      shot.error = (error as Error).message;
      console.warn(`  ${plan.building.id}/${shot.file}: ${shot.error}`);
    }
    if (++done % 20 === 0) console.log(`  скачано ${done}/${pending.length}`);
  });

  for (const p of plans) {
    const dir = join(OUT_DIR, p.building.id);
    mkdirSync(dir, { recursive: true });
    // Кадры, которых больше нет в плане, удаляются — это наши же файлы из прошлого запуска.
    const current = new Set(p.views.flatMap((v) => v.shots.map((s) => s.file)));
    let changed = pending.some((x) => x.plan === p);
    for (const file of previous.get(p.building.id)!.keys()) {
      if (!current.has(file) && existsSync(join(dir, file))) {
        rmSync(join(dir, file));
        changed = true;
      }
    }
    // Размеченные копии устарели вместе с кадрами; их пересоздаёт --mark.
    if (changed) rmSync(join(dir, 'marked'), { recursive: true, force: true });
    const manifest: Manifest = {
      formatVersion: 1,
      id: p.building.id,
      name: p.building.name,
      description: p.building.description,
      height: p.building.height,
      outline: p.building.outline.map((q) => ({ x: round(q.x), z: round(q.z) })),
      facades: p.facades.map((f) => ({
        key: f.key,
        side: f.side,
        points: f.points.map((q) => ({ x: round(q.x), z: round(q.z) })),
        normal: { x: round(f.normal.x, 3), z: round(f.normal.z, 3) },
        length: round(f.length, 1),
        height: f.height,
        ...(f.part ? { part: [f.part.index, f.part.count] as [number, number] } : {}),
      })),
      views: p.views,
      missing: p.missing,
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  const total = writeIndex(buildings);
  console.log(`\nГотово. Обзор: ${join(OUT_DIR, 'index.html')} (${total} зданий)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
