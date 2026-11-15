/**
 * Павильоны на остановках автобусной сети ring-block.
 *
 *   pnpm world:bus:stops -- --base output/map-base.json --edited output/map-bus-stops.json
 *
 * Берёт экспорт расстановки (`make map-export`) и добавляет готовый остановочный павильон
 * к каждой платформе из `bus-network/network.json`, у которой его ещё нет. Результат —
 * копия экспорта для обычного `make map-patch` → `map-check` → `map-apply`; БД команда
 * не трогает. Повторный запуск на свежем экспорте ничего не добавляет: ID постоянные.
 *
 * Как выбирается место. Платформа OSM обычно стоит у бордюра, иногда на проезжей части;
 * у интерполированных остановок — на оси дороги. Ближайший участок пути автобуса задаёт
 * направление улицы и сторону: павильон стоит спиной от дороги, лицом к ней. Перебираются
 * сдвиги поперёк и вдоль улицы не дальше {@link MAX_SHIFT} м от платформы, чтобы подсказка
 * «Автобусы» (6 м) срабатывала в павильоне. Место годится, если контур павильона с запасом
 * не задевает дороги, проезды, парковки, воду и коллайдеры уже стоящих объектов, а
 * фундамент по рельефу выпуска не выше допуска модели. Высоту Y выбирает то же правило,
 * что и размещение из игры (`planSupportPlacement`). Из годных мест берётся ближайшее к
 * платформе с низким фундаментом и фасадом в 1–3 м от дороги.
 *
 * Нужен собранный выпуск того же каталога (`make build`): из него берутся габариты и
 * коллайдеры моделей и частный рельеф.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  validateWorldLayoutSnapshot,
  type BusNetwork,
  type BusPoint,
  type StaticObjectInstance,
  type WorldLayoutSnapshot,
} from '@su/contracts';
import {
  validateTerrainPrivateData,
  type TerrainPrivateDataV2,
} from '@su/terrain-build/private-data';
import { planSupportPlacement, selectSupportRule } from '@su/terrain-build/supports';

type Point = [number, number];
type Polygon = Point[];
interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}
interface Shape {
  polygon: Polygon;
  box: Box;
}

/** Павильоны каталога (варианты 01, 03, 04, 06, 07, 08); 02 и 05 — только знак. */
export const PAVILION_ASSETS = [
  'bus-stop-32df9c483410f2a3',
  'bus-stop-3fcaa09cb4e354d9',
  'bus-stop-49b992f34893bfa4',
  'bus-stop-b1cdbe7df1c69e9e',
  'bus-stop-ec57d7e82d8c32f8',
  'bus-stop-f7605a5e04c65979',
] as const;
/** Наибольший сдвиг павильона от точки платформы, м: подсказка срабатывает с 6 м. */
export const MAX_SHIFT = 4;
/** Платформа уже обслужена, если ближе стоит любая модель остановки, м. */
const SERVED_RADIUS = 6;
/** Запас вокруг контура павильона до чужих коллайдеров и запретных покрытий, м. */
const CLEARANCE = 0.3;
/** Где павильону стоять нельзя; остальное — газоны, тротуары, парки и голая земля. */
export const BLOCKING_SURFACES = [
  'water',
  'pitch',
  'playground',
  'parking',
  'service',
  'road',
  'islands',
];
/** Дорога, к которой павильон стоит лицом. */
const CARRIAGEWAY = ['road', 'service'];

export interface GroundLayer {
  id: string;
  polygons: Polygon[][];
}
export interface AssetGeometry {
  /** Габариты модели в локальных X/Z. */
  bounds: Box;
  /** Контуры коллайдеров в локальных X/Z (бокс — прямоугольник, сетка — выпуклая оболочка). */
  footprints: Polygon[];
}
export interface StopPlacementInput {
  network: BusNetwork;
  ground: GroundLayer[];
  instances: StaticObjectInstance[];
  assets: Map<string, AssetGeometry>;
  terrain: Pick<TerrainPrivateDataV2, 'grid' | 'supports' | 'placementModels'>;
  bounds: Box;
}
export interface StopPlacementRow {
  stopId: string;
  stopName: string;
  platform: number;
  entityId: string;
  /**
   * `served` — рядом уже стоит модель остановки; `existing` — этот ID уже в расстановке;
   * `off-world` — точка за границей мира; `interpolated` — места нет в OSM, точка на оси
   * дороги, павильон ждёт проверенных координат; `no-room` — свободного места не нашлось.
   */
  status: 'served' | 'existing' | 'placed' | 'off-world' | 'interpolated' | 'no-room';
  /** Сдвиг от точки платформы, м. */
  shift?: number;
  /** Видимая высота фундамента над низом рельефа, м. */
  foundation?: number;
  /** Расстояние от фасада до дороги, м. */
  road?: number;
  instance?: StaticObjectInstance;
}

const box = (polygon: Polygon): Box => {
  const b = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const [x, z] of polygon) {
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minZ = Math.min(b.minZ, z);
    b.maxZ = Math.max(b.maxZ, z);
  }
  return b;
};
const overlaps = (a: Box, b: Box, margin = 0) =>
  a.minX - margin <= b.maxX &&
  b.minX - margin <= a.maxX &&
  a.minZ - margin <= b.maxZ &&
  b.minZ - margin <= a.maxZ;
const rectangle = (b: Box, margin = 0): Polygon => [
  [b.minX - margin, b.minZ - margin],
  [b.maxX + margin, b.minZ - margin],
  [b.maxX + margin, b.maxZ + margin],
  [b.minX - margin, b.maxZ + margin],
];
const yawOf = (q: StaticObjectInstance['rotation']) => 2 * Math.atan2(q.y, q.w);
/** Локальные X/Z модели в мировые при повороте вокруг Y, как у сервера. */
const place = (polygon: Polygon, x: number, z: number, yaw: number): Polygon => {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return polygon.map(([px, pz]) => [x + c * px + s * pz, z - s * px + c * pz]);
};

function hull(points: Point[]): Polygon {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [],
    upper: Point[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, q) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
/** Пересечение выпуклых многоугольников (теорема о разделяющей оси). */
export function convexOverlap(a: Polygon, b: Polygon) {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const [x1, z1] = poly[i],
        [x2, z2] = poly[(i + 1) % poly.length];
      const nx = z2 - z1,
        nz = x1 - x2;
      let minA = Infinity,
        maxA = -Infinity,
        minB = Infinity,
        maxB = -Infinity;
      for (const [x, z] of a) {
        const d = x * nx + z * nz;
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const [x, z] of b) {
        const d = x * nx + z * nz;
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (maxA < minB || maxB < minA) return false;
    }
  return true;
}
function inRing([x, z]: Point, ring: Polygon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[i],
      [bx, bz] = ring[j];
    if (az > z !== bz > z && x < ax + ((z - az) * (bx - ax)) / (bz - az)) inside = !inside;
  }
  return inside;
}
const inPolygon = (p: Point, rings: Polygon[]) =>
  inRing(p, rings[0]) && !rings.slice(1).some((hole) => inRing(p, hole));
function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}
const segmentsCross = (a: Point, b: Point, c: Point, d: Point) => {
  const o = (p: Point, q: Point, r: Point) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
};

/** Простая сетка корзин 32 м для быстрого поиска соседей. */
class Buckets<T extends { box: Box }> {
  private readonly cells = new Map<string, T[]>();
  constructor(private readonly size = 32) {}
  add(item: T) {
    for (const key of this.keys(item.box)) {
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(item);
    }
  }
  near(b: Box, margin = 0) {
    const out = new Set<T>();
    for (const key of this.keys(b, margin))
      for (const item of this.cells.get(key) ?? [])
        if (overlaps(item.box, b, margin)) out.add(item);
    return out;
  }
  private *keys(b: Box, margin = 0) {
    for (let i = Math.floor((b.minX - margin) / this.size); i <= (b.maxX + margin) / this.size; i++)
      for (
        let j = Math.floor((b.minZ - margin) / this.size);
        j <= (b.maxZ + margin) / this.size;
        j++
      )
        yield `${i}:${j}`;
  }
}

function nearestOnPath(p: Point, legs: BusPoint[][][]) {
  let best: { distance: number; point: Point; direction: Point } | undefined;
  for (const leg of legs)
    for (const piece of leg)
      for (let i = 1; i < piece.length; i++) {
        const a = piece[i - 1],
          b = piece[i];
        const dx = b[0] - a[0],
          dz = b[1] - a[1],
          l2 = dx * dx + dz * dz;
        if (!l2) continue;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
        const q: Point = [a[0] + t * dx, a[1] + t * dz];
        const distance = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (!best || distance < best.distance) {
          const l = Math.sqrt(l2);
          best = { distance, point: q, direction: [dx / l, dz / l] };
        }
      }
  return best;
}

const pavilionFor = (stopId: string, platform: number) =>
  PAVILION_ASSETS[
    createHash('sha256').update(`${stopId}#${platform}`).digest().readUInt32BE(0) %
      PAVILION_ASSETS.length
  ];
export const stopEntityId = (stopId: string, platform: number) =>
  `bus-stop-${stopId}-${platform + 1}`;

export function planBusStopPlacements(input: StopPlacementInput): StopPlacementRow[] {
  const { network, terrain, bounds } = input;
  const surfaces = new Buckets<Shape & { layer: string; rings: Polygon[] }>();
  for (const layer of input.ground)
    if (BLOCKING_SURFACES.includes(layer.id))
      for (const rings of layer.polygons)
        surfaces.add({ layer: layer.id, rings, polygon: rings[0], box: box(rings[0]) });
  const obstacles = new Buckets<Shape & { entityId: string }>();
  const stopModels: StaticObjectInstance[] = [];
  const byId = new Map(input.instances.map((i) => [i.entityId, i]));
  const addObstacle = (instance: StaticObjectInstance) => {
    const geometry = input.assets.get(instance.assetId);
    if (!geometry) throw new Error(`Model ${instance.assetId} is missing from the release`);
    const yaw = yawOf(instance.rotation);
    for (const footprint of geometry.footprints) {
      const polygon = place(footprint, instance.position.x, instance.position.z, yaw);
      obstacles.add({ entityId: instance.entityId, polygon, box: box(polygon) });
    }
  };
  for (const instance of input.instances) {
    if (!instance.enabled) continue;
    if (instance.assetId.startsWith('bus-stop-')) stopModels.push(instance);
    addObstacle(instance);
  }
  const routes = new Map(network.routes.map((r) => [r.ref, r]));

  const rows: StopPlacementRow[] = [];
  for (const stop of network.stops)
    stop.platforms.forEach((platformObj, index) => {
      const platform = platformObj.position;
      const entityId = stopEntityId(stop.id, index);
      const row: StopPlacementRow = {
        stopId: stop.id,
        stopName: stop.name,
        platform: index,
        entityId,
        status: 'no-room',
      };
      rows.push(row);
      if (byId.has(entityId)) {
        row.status = 'existing';
        return;
      }
      if (
        platform[0] < bounds.minX + 2 ||
        platform[0] > bounds.maxX - 2 ||
        platform[1] < bounds.minZ + 2 ||
        platform[1] > bounds.maxZ - 2
      ) {
        row.status = 'off-world';
        return;
      }
      // Угаданная точка на оси улицы: павильон в стороне от неё не поймал бы подсказку,
      // а переносить платформу — дело сети (README: «Проверить вручную»).
      if (stop.source === 'interpolated') {
        row.status = 'interpolated';
        return;
      }
      if (
        stopModels.some(
          (s) =>
            Math.hypot(s.position.x - platform[0], s.position.z - platform[1]) <= SERVED_RADIUS,
        )
      ) {
        row.status = 'served';
        return;
      }
      const legs = stop.routes.flatMap(
        (ref) => routes.get(ref)?.directions.flatMap((d) => d.legs) ?? [],
      );
      const path = nearestOnPath(platform, legs);
      if (!path) throw new Error(`Stop ${stop.id} has no bus path`);
      const [tx, tz] = path.direction;
      // Вне оси — сторона платформы; на оси (интерполяция) — правая по ходу автобуса.
      // X — восток, Z — юг: справа от (tx, tz) лежит (−tz, tx).
      let [nx, nz]: Point =
        path.distance > 0.5
          ? [
              (platform[0] - path.point[0]) / path.distance,
              (platform[1] - path.point[1]) / path.distance,
            ]
          : [-tz, tx];
      // Нормаль к пути, а не к точке: на изгибе направление к ближайшей точке косое.
      const side = Math.sign(nx * -tz + nz * tx) || 1;
      [nx, nz] = [-tz * side, tx * side];
      const yaw = Math.atan2(nx, nz);
      const assetId = pavilionFor(stop.id, index);
      const geometry = input.assets.get(assetId);
      if (!geometry) throw new Error(`Model ${assetId} is missing from the release`);
      const rule = selectSupportRule(terrain.supports, {
        entityId,
        assetId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      });
      const policy = terrain.placementModels?.find((m) => m.assetId === assetId)?.policy;
      if (!rule || policy?.kind !== 'foundation')
        throw new Error(`Pavilion ${assetId} has no foundation placement policy`);
      const outline = rectangle(geometry.bounds, CLEARANCE);
      const front: Point = [
        (geometry.bounds.minX + geometry.bounds.maxX) / 2,
        geometry.bounds.minZ,
      ];

      let best: (StopPlacementRow & { score: number }) | undefined;
      for (let across = -MAX_SHIFT; across <= MAX_SHIFT; across += 0.5)
        for (let along = -MAX_SHIFT; along <= MAX_SHIFT; along += 0.5) {
          const shift = Math.hypot(across, along);
          if (shift > MAX_SHIFT || (best && shift > best.score)) continue;
          const x = platform[0] + nx * across + tx * along;
          const z = platform[1] + nz * across + tz * along;
          const footprint = place(outline, x, z, yaw);
          const fb = box(footprint);
          if (
            fb.minX < bounds.minX ||
            fb.maxX > bounds.maxX ||
            fb.minZ < bounds.minZ ||
            fb.maxZ > bounds.maxZ
          )
            continue;
          if ([...obstacles.near(fb)].some((o) => convexOverlap(footprint, o.polygon))) continue;
          const nearSurfaces = [...surfaces.near(fb, 12)];
          if (
            blocked(
              footprint,
              nearSurfaces.filter((s) => overlaps(s.box, fb)),
            )
          )
            continue;
          const [fx, fz] = place([front], x, z, yaw)[0];
          let road = Infinity;
          for (const s of nearSurfaces)
            if (CARRIAGEWAY.includes(s.layer))
              for (const ring of s.rings)
                for (let i = 0; i < ring.length; i++)
                  road = Math.min(
                    road,
                    segmentDistance([fx, fz], ring[i], ring[(i + 1) % ring.length]),
                  );
          let plan: ReturnType<typeof planSupportPlacement>;
          const instance: StaticObjectInstance = {
            entityId,
            assetId,
            position: { x: round(x), y: 0, z: round(z) },
            rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
            enabled: true,
            instanceRevision: 1,
          };
          try {
            plan = planSupportPlacement(terrain.grid, rule, instance);
          } catch {
            continue;
          }
          const foundation = plan.minimumY + rule.jointY - plan.terrainMin;
          if (foundation > policy.maximumVisibleHeight) continue;
          instance.position.y = plan.minimumY;
          // Ближе к платформе, ниже фундамент, фасад в 1–3 м от дороги.
          const score =
            shift +
            2 * foundation +
            (road === Infinity ? 3 : Math.max(0, 1 - road) * 2 + Math.max(0, road - 3) * 0.5);
          if (!best || score < best.score)
            best = { ...row, status: 'placed', shift, foundation, road, instance, score };
        }
      if (!best) return;
      const { score: _score, ...placed } = best;
      Object.assign(row, placed);
      addObstacle(best.instance!);
      stopModels.push(best.instance!);
    });
  return rows;
}

/** Контур задевает запретное покрытие: вершина внутри, покрытие внутри или рёбра пересекаются. */
function blocked(footprint: Polygon, surfaces: { rings: Polygon[] }[]) {
  for (const { rings } of surfaces) {
    if (footprint.some((p) => inPolygon(p, rings))) return true;
    for (const ring of rings) {
      if (ring.some((p) => inRing(p, footprint))) return true;
      for (let i = 0; i < ring.length; i++)
        for (let j = 0; j < footprint.length; j++)
          if (
            segmentsCross(
              ring[i],
              ring[(i + 1) % ring.length],
              footprint[j],
              footprint[(j + 1) % footprint.length],
            )
          )
            return true;
    }
  }
  return false;
}
const round = (v: number) => Math.round(v * 1000) / 1000;

interface ReleaseManifest {
  bounds: { min: { x: number; z: number }; max: { x: number; z: number } };
  assets: Record<
    string,
    {
      bounds: { min: { x: number; z: number }; max: { x: number; z: number } };
      collisionFile?: string;
    }
  >;
}
interface ColliderFile {
  colliders: (
    | {
        kind: 'box';
        position: { x: number; z: number };
        rotation: StaticObjectInstance['rotation'];
        size: { x: number; z: number };
      }
    | {
        kind: 'mesh';
        position: { x: number; z: number };
        rotation: StaticObjectInstance['rotation'];
        vertices: number[];
      }
  )[];
}
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
async function assetGeometry(
  release: string,
  manifest: ReleaseManifest,
  assetId: string,
): Promise<AssetGeometry> {
  const asset = manifest.assets[assetId];
  if (!asset) throw new Error(`Model ${assetId} is missing from the release`);
  const bounds = {
    minX: asset.bounds.min.x,
    minZ: asset.bounds.min.z,
    maxX: asset.bounds.max.x,
    maxZ: asset.bounds.max.z,
  };
  const footprints: Polygon[] = [];
  if (asset.collisionFile) {
    const { colliders } = await readJson<ColliderFile>(resolve(release, asset.collisionFile));
    for (const c of colliders) {
      const yaw = yawOf(c.rotation);
      if (c.kind === 'box') {
        const hx = c.size.x / 2,
          hz = c.size.z / 2;
        footprints.push(
          place(
            [
              [-hx, -hz],
              [hx, -hz],
              [hx, hz],
              [-hx, hz],
            ],
            c.position.x,
            c.position.z,
            yaw,
          ),
        );
      } else if (c.kind === 'mesh') {
        const points: Point[] = [];
        for (let i = 0; i < c.vertices.length; i += 3)
          points.push([c.vertices[i], c.vertices[i + 2]]);
        footprints.push(place(hull(points), c.position.x, c.position.z, yaw));
      }
    }
  }
  // Без коллайдеров (кусты) — видимые габариты: сквозь них павильон тоже не ставим.
  if (!footprints.length) footprints.push(rectangle(bounds));
  return { bounds, footprints };
}

function option(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const baseFile = option(args, '--base'),
    editedFile = option(args, '--edited');
  const release = option(args, '--release') ?? 'dist/worlds/ring-block';
  if (!baseFile || !editedFile)
    throw new Error(
      'Use pnpm world:bus:stops -- --base <export.json> --edited <out.json> [--release <dir>]',
    );
  if (resolve(baseFile) === resolve(editedFile))
    throw new Error('--edited must differ from --base');
  const base: unknown = await readJson(baseFile);
  validateWorldLayoutSnapshot(base);
  const snapshot = base as WorldLayoutSnapshot;
  if (snapshot.worldId !== 'ring-block') throw new Error('Bus stops exist only in ring-block');

  const authoring = await readJson<{
    assetReleaseVersion: string;
    terrain?: { file: string };
  }>(resolve(release, 'authoring.json'));
  if (authoring.assetReleaseVersion !== snapshot.assetReleaseVersion)
    throw new Error(
      `Release ${release} is ${authoring.assetReleaseVersion.slice(0, 12)}, export is ${snapshot.assetReleaseVersion.slice(0, 12)}; run make build from the deployed sources`,
    );
  if (!authoring.terrain) throw new Error('Release has no terrain');
  const terrain = validateTerrainPrivateData(
    await readJson(resolve(release, authoring.terrain.file)),
  );
  if (terrain.formatVersion !== 2) throw new Error('Release terrain is not v2');
  const manifest = await readJson<ReleaseManifest>(resolve(release, 'manifest.json'));
  const assets = new Map<string, AssetGeometry>();
  for (const id of new Set([
    ...PAVILION_ASSETS,
    ...snapshot.instances.filter((i) => i.enabled).map((i) => i.assetId),
  ]))
    assets.set(id, await assetGeometry(release, manifest, id));

  const network = await readJson<BusNetwork>('content/worlds/ring-block/bus-network/network.json');
  const ground = await readJson<{ layers: GroundLayer[] }>(
    'content/buildings/ring-block/ring-block-ground/source.json',
  );
  const rows = planBusStopPlacements({
    network,
    ground: ground.layers,
    instances: snapshot.instances,
    assets,
    terrain: terrain as FoundationTerrain,
    bounds: {
      minX: manifest.bounds.min.x,
      minZ: manifest.bounds.min.z,
      maxX: manifest.bounds.max.x,
      maxZ: manifest.bounds.max.z,
    },
  });
  const added = rows.flatMap((r) => (r.instance ? [r.instance] : []));
  const edited: WorldLayoutSnapshot = {
    ...snapshot,
    instances: [...snapshot.instances, ...added],
  };
  validateWorldLayoutSnapshot(edited);
  await mkdir(dirname(resolve(editedFile)), { recursive: true });
  await writeFile(editedFile, `${JSON.stringify(edited, null, 2)}\n`);

  for (const r of rows)
    console.log(
      [
        r.status.padEnd(8),
        `${r.stopName} (${r.stopId}) #${r.platform + 1}`.padEnd(60),
        r.status === 'placed'
          ? `${r.entityId}  сдвиг ${r.shift!.toFixed(1)} м, фундамент ${r.foundation!.toFixed(2)} м, до дороги ${Number.isFinite(r.road) ? `${r.road!.toFixed(1)} м` : '—'}`
          : '',
      ].join(' '),
    );
  const count = (s: StopPlacementRow['status']) => rows.filter((r) => r.status === s).length;
  console.log(
    `bus stops: ${count('placed')} placed, ${count('served')} already have a stop model, ` +
      `${count('existing')} placed earlier, ${count('off-world')} off-world, ` +
      `${count('interpolated')} interpolated, ${count('no-room')} without room → ${editedFile}`,
  );
  if (count('no-room')) process.exitCode = 2;
}
type FoundationTerrain = Pick<TerrainPrivateDataV2, 'grid' | 'supports' | 'placementModels'>;

if (process.argv[1]?.endsWith('bus-stop-placements.ts')) await main();
