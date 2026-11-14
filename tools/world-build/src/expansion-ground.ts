/**
 * Основание новой территории ring-block из разового снимка OpenStreetMap.
 *
 *   pnpm world:ground:expansion -- --fetch   # скачать снимок Overpass в output/expansion-ground/
 *   pnpm world:ground:expansion              # пересчитать слои из сохранённого снимка
 *
 * Пишет полигоны в обычный рецепт `ring-block-ground/source.json` и происхождение в
 * `content/worlds/ring-block/ground-expansion/provenance.json`. Сборка мира OSM не читает.
 * Полигоны строго вне старой области X −269…331, Z −745…131 (её ведут вручную) и внутри
 * мира; при повторном запуске прежние сгенерированные полигоны заменяются. Каждый слой
 * режется по ячейкам 125 м: буфер линий, объединение и обрезка — через поле расстояний
 * (`ground-contour.ts`). Ширины улиц согласованы с расширенной старой областью
 * (`widen-roads.ts`): полосы × 2,75 м + 3 м.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Point2 } from '@su/terrain-build/triangulate';
import type { GroundLayer, GroundRecipe } from './city.js';
import { Field, fieldPolygons, rectDistance } from './ground-contour.js';
import { OLD_MAX, OLD_MIN } from './widen-roads.js';

const GROUND = 'content/buildings/ring-block/ring-block-ground/source.json';
const TERRAIN_SOURCE = 'content/worlds/ring-block/terrain-expansion/source.json';
const PROVENANCE = 'content/worlds/ring-block/ground-expansion/provenance.json';
const CACHE = 'output/expansion-ground/osm.json';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
/** Сторона расчётной плитки, м (ячейка публикации). Дробление мельче (25 м) проверено 14.11: больше поверхностей и байтов, сборка медленнее. */
const TILE = Number(process.env.SU_GROUND_TILE ?? 125);
/** Решётка высот мира: рецепт основания должен совпадать с ней по фазе. */
const RECIPE_MIN: Point2 = [-1501, -853];
const RECIPE_MAX: Point2 = [2003, 851];
const FETCH_MARGIN = 60;

const WATER: GroundLayer = { id: 'water', color: '#6f9cb0', elevation: 0.003, polygons: [] };
/** Слои в порядке рецепта; `h` — шаг поля, м. */
const LAYERS: Record<string, { h: number; tolerance: number; minArea: number }> = {
  water: { h: 0.5, tolerance: 0.1, minArea: 2 },
  green: { h: 0.5, tolerance: 0.1, minArea: 2 },
  park: { h: 0.5, tolerance: 0.1, minArea: 2 },
  pitch: { h: 0.5, tolerance: 0.08, minArea: 2 },
  playground: { h: 0.5, tolerance: 0.08, minArea: 2 },
  footway: { h: 0.25, tolerance: 0.05, minArea: 0.5 },
  parking: { h: 0.5, tolerance: 0.08, minArea: 2 },
  service: { h: 0.25, tolerance: 0.05, minArea: 0.5 },
  road: { h: 0.25, tolerance: 0.04, minArea: 0.5 },
};

type Tags = Record<string, string>;
interface Feature {
  layer: string;
  /** Линия с полушириной r или площадь (чётно-нечётные контуры). */
  line?: Point2[];
  r?: number;
  rings?: Point2[][];
  min: Point2;
  max: Point2;
}

const CAR_LANES: Record<string, number> = {
  motorway: 4,
  trunk: 4,
  primary: 4,
  secondary: 2,
  tertiary: 2,
  unclassified: 2,
  residential: 2,
  living_street: 2,
  busway: 1,
};
export const LANE_WIDTH = 2.75;
export const ROAD_EXTRA = 3;
const number = (value: string | undefined) => {
  const n = Number.parseFloat((value ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function lineLayer(tags: Tags): { layer: string; width: number } | undefined {
  if (tags.tunnel && tags.tunnel !== 'no' && tags.tunnel !== 'building_passage') return;
  if (tags.area === 'yes') return;
  const highway = tags.highway;
  if (highway) {
    const base = highway.replace(/_link$/, '');
    if (Object.hasOwn(CAR_LANES, base)) {
      const lanes = number(tags.lanes) ?? (highway.endsWith('_link') ? 1 : CAR_LANES[base]);
      return {
        layer: 'road',
        width: Math.max(number(tags.width) ?? 0, lanes * LANE_WIDTH) + ROAD_EXTRA,
      };
    }
    if (highway === 'service') return { layer: 'service', width: 5 };
    if (highway === 'track') return { layer: 'service', width: 4 };
    if (highway === 'pedestrian') return { layer: 'footway', width: 4 };
    if (highway === 'steps') return { layer: 'footway', width: 2 };
    if (['footway', 'path', 'cycleway', 'bridleway'].includes(highway))
      return { layer: 'footway', width: 1.8 };
    return;
  }
  const waterway = tags.waterway;
  if (waterway && !(tags.tunnel && tags.tunnel !== 'no')) {
    const width = number(tags.width);
    if (waterway === 'river') return width ? { layer: 'water', width } : undefined;
    if (waterway === 'canal') return { layer: 'water', width: width ?? 6 };
    if (waterway === 'stream') return { layer: 'water', width: width ?? 2.5 };
    if (waterway === 'ditch' || waterway === 'drain')
      return { layer: 'water', width: width ?? 1.2 };
  }
}

function areaLayer(tags: Tags): string | undefined {
  if (
    tags.natural === 'water' ||
    tags.waterway === 'riverbank' ||
    ['reservoir', 'basin'].includes(tags.landuse)
  )
    return 'water';
  if (
    tags.amenity === 'parking' &&
    !['underground', 'multi-storey', 'rooftop'].includes(tags.parking)
  )
    return 'parking';
  if (tags.leisure === 'playground') return 'playground';
  if (tags.leisure === 'pitch' || tags.leisure === 'track') return 'pitch';
  if (
    tags.highway === 'pedestrian' ||
    tags['area:highway'] === 'pedestrian' ||
    tags['area:highway'] === 'footway'
  )
    return 'footway';
  if (
    ['park', 'garden'].includes(tags.leisure) ||
    tags.landuse === 'forest' ||
    ['wood', 'scrub'].includes(tags.natural)
  )
    return 'park';
  if (
    [
      'grass',
      'meadow',
      'village_green',
      'recreation_ground',
      'flowerbed',
      'cemetery',
      'orchard',
      'plant_nursery',
      'allotments',
    ].includes(tags.landuse) ||
    ['grassland', 'heath'].includes(tags.natural)
  )
    return 'green';
}

interface OsmGeometry {
  lat: number;
  lon: number;
}
interface OsmElement {
  type: 'way' | 'relation' | 'node';
  id: number;
  tags?: Tags;
  geometry?: OsmGeometry[];
  members?: { type: string; role: string; geometry?: OsmGeometry[] }[];
}

/** Склеить незамкнутые пути мультиполигона в кольца. */
function joinRings(paths: Point2[][]): Point2[][] {
  const key = (p: Point2) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const open = paths.filter((p) => p.length >= 2);
  const rings: Point2[][] = [];
  while (open.length) {
    let ring = open.shift()!;
    let grown = true;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const p = open[i];
        const end = key(ring[ring.length - 1]);
        if (key(p[0]) === end) ring = [...ring, ...p.slice(1)];
        else if (key(p[p.length - 1]) === end) ring = [...ring, ...[...p].reverse().slice(1)];
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (key(ring[0]) === key(ring[ring.length - 1]) && ring.length >= 4)
      rings.push(ring.slice(0, -1));
  }
  return rings;
}

function features(elements: OsmElement[], toGame: (g: OsmGeometry) => Point2) {
  const out: Feature[] = [];
  const bbox = (points: Point2[]) => {
    const min = [Infinity, Infinity],
      max = [-Infinity, -Infinity];
    for (const [x, z] of points) {
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], z);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], z);
    }
    return { min: [min[0], min[1]] as Point2, max: [max[0], max[1]] as Point2 };
  };
  for (const element of elements) {
    const tags = element.tags ?? {};
    if (element.type === 'way' && element.geometry) {
      const points = element.geometry.map(toGame);
      const closed =
        points.length >= 4 &&
        element.geometry[0].lat === element.geometry.at(-1)!.lat &&
        element.geometry[0].lon === element.geometry.at(-1)!.lon;
      const area = closed ? areaLayer(tags) : undefined;
      if (
        area &&
        (tags.highway === undefined ||
          tags.area === 'yes' ||
          tags.highway === 'pedestrian' ||
          tags['area:highway'])
      ) {
        if (tags.highway === 'pedestrian' && tags.area !== 'yes') {
          // Замкнутая пешеходная улица без area=yes — это линия.
        } else {
          out.push({ layer: area, rings: [points.slice(0, -1)], ...bbox(points) });
          continue;
        }
      }
      const line = lineLayer(tags);
      if (line) out.push({ layer: line.layer, line: points, r: line.width / 2, ...bbox(points) });
    } else if (element.type === 'relation' && element.members) {
      const layer = areaLayer(tags);
      if (!layer) continue;
      const rings = joinRings(
        element.members
          .filter(
            (m) => m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === 'inner'),
          )
          .map((m) => m.geometry!.map(toGame)),
      );
      if (rings.length) out.push({ layer, rings, ...bbox(rings.flat()) });
    }
  }
  return out;
}

const isGenerated = (polygon: Point2[][]) =>
  polygon[0].some(
    ([x, z]) =>
      x < OLD_MIN[0] - 1e-6 ||
      x > OLD_MAX[0] + 1e-6 ||
      z < OLD_MIN[1] - 1e-6 ||
      z > OLD_MAX[1] + 1e-6,
  );

async function main() {
  const terrain = JSON.parse(await readFile(TERRAIN_SOURCE, 'utf8'));
  const { west, east, north, south } = terrain.worldBoundsXZ as Record<string, number>;
  const origin = terrain.originWgs84 as { lon: number; lat: number };
  const mpd = terrain.metresPerDegree as { lon: number; lat: number };
  const query = (() => {
    const s = origin.lat - (south + FETCH_MARGIN) / mpd.lat,
      n = origin.lat - (north - FETCH_MARGIN) / mpd.lat,
      w = origin.lon + (west - FETCH_MARGIN) / mpd.lon,
      e = origin.lon + (east + FETCH_MARGIN) / mpd.lon;
    const b = [s, w, n, e].map((v) => v.toFixed(5)).join(',');
    return (
      `[out:json][timeout:120];(way[highway](${b});way[landuse](${b});way[leisure](${b});way[natural](${b});` +
      `way[amenity=parking](${b});way[waterway](${b});way["area:highway"](${b});` +
      `relation[type=multipolygon][~"^(landuse|leisure|natural|amenity|waterway)$"~"."](${b}););out geom;`
    );
  })();
  if (process.argv.includes('--fetch')) {
    const response = await fetch(OVERPASS, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'su-world-build',
      },
      body: new URLSearchParams({ data: query }),
    });
    if (!response.ok) throw new Error(`Overpass ${response.status}`);
    await mkdir('output/expansion-ground', { recursive: true });
    await writeFile(CACHE, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = await readFile(CACHE).catch(() => {
    throw new Error(`${CACHE} is missing; run with --fetch`);
  });
  const snapshot = JSON.parse(bytes.toString()) as {
    osm3s?: { timestamp_osm_base?: string };
    elements: OsmElement[];
  };
  const toGame = (g: OsmGeometry): Point2 => [
    (g.lon - origin.lon) * mpd.lon,
    -(g.lat - origin.lat) * mpd.lat,
  ];
  const all = features(snapshot.elements, toGame);

  const recipe = JSON.parse(await readFile(GROUND, 'utf8')) as GroundRecipe;
  if (!recipe.layers.some((l) => l.id === 'water')) recipe.layers.unshift(structuredClone(WATER));
  for (const layer of recipe.layers)
    layer.polygons = layer.polygons.filter((p) => !isGenerated(p as Point2[][]));
  recipe.min = RECIPE_MIN;
  recipe.max = RECIPE_MAX;

  const counts: Record<
    string,
    { features: number; polygons: number; vertices: number; dropped: number }
  > = {};
  const outside = (x: number, z: number) => -rectDistance(x, z, OLD_MIN, OLD_MAX);
  for (const [id, settings] of Object.entries(LAYERS)) {
    const layer = recipe.layers.find((l) => l.id === id);
    if (!layer) throw new Error(`Ground layer ${id} is missing`);
    const own = all.filter((f) => f.layer === id);
    const count = (counts[id] = { features: own.length, polygons: 0, vertices: 0, dropped: 0 });
    for (let x0 = west; x0 < east; x0 += TILE)
      for (let z0 = north; z0 < south; z0 += TILE) {
        const tile = {
          x0,
          z0,
          x1: Math.min(x0 + TILE, east),
          z1: Math.min(z0 + TILE, south),
          h: settings.h,
        };
        if (
          tile.x0 >= OLD_MIN[0] &&
          tile.x1 <= OLD_MAX[0] &&
          tile.z0 >= OLD_MIN[1] &&
          tile.z1 <= OLD_MAX[1]
        )
          continue;
        const near = own.filter((f) => {
          const m = (f.r ?? 0) + 2;
          return (
            f.max[0] + m > tile.x0 &&
            f.min[0] - m < tile.x1 &&
            f.max[1] + m > tile.z0 &&
            f.min[1] - m < tile.z1
          );
        });
        if (!near.length) continue;
        const field = new Field(tile, Math.max(1, 2 * settings.h));
        for (const f of near) {
          if (f.line) field.polyline(f.line, f.r!);
          else field.polygon(f.rings!);
        }
        field.intersect(outside);
        const result = fieldPolygons(field, settings);
        for (const polygon of result.polygons) {
          layer.polygons.push(polygon);
          count.polygons++;
          count.vertices += polygon.reduce((sum, ring) => sum + ring.length, 0);
        }
        count.dropped += result.dropped;
      }
    console.log(
      `${id}: ${count.features} features → ${count.polygons} polygons, ${count.vertices} vertices, dropped ${count.dropped}`,
    );
  }
  await writeFile(GROUND, JSON.stringify(recipe));
  await mkdir('content/worlds/ring-block/ground-expansion', { recursive: true });
  await writeFile(
    PROVENANCE,
    JSON.stringify(
      {
        formatVersion: 1,
        source: 'OpenStreetMap via Overpass API',
        license: 'ODbL 1.0, © OpenStreetMap contributors',
        osmTimestamp: snapshot.osm3s?.timestamp_osm_base,
        snapshotSha256: createHash('sha256').update(bytes).digest('hex'),
        query,
        excludedRectangle: { min: OLD_MIN, max: OLD_MAX },
        roadWidth: `max(width, lanes × ${LANE_WIDTH}) + ${ROAD_EXTRA} m; service 5 m, track 4 m, footway 1.8 m, steps 2 m, pedestrian 4 m`,
        layers: counts,
      },
      null,
      2,
    ) + '\n',
  );
}

await main();
