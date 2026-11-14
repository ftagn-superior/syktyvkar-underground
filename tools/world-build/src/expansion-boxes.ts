/**
 * Дома-коробки новой территории ring-block из разового снимка OpenStreetMap (этап B плана
 * `docs/plans/city-expansion.md`: проверка нагрузки до детализации).
 *
 *   pnpm world:boxes:expansion -- --fetch   # скачать снимок Overpass в output/expansion-buildings/
 *   pnpm world:boxes:expansion              # пересчитать коробки из сохранённого снимка
 *   pnpm world:boxes:expansion -- --layout <export.json> --out <edited.json>
 *                                           # добавить коробки в экспорт размещений действующей БД
 *
 * Каждый контур OSM вне старой области X −269…331, Z −745…131 становится обычной моделью
 * `footprint` без окон и деталей в `content/buildings/ring-block/expansion/<id>/`:
 * высота = `building:levels` × 3 м (иначе по типу `building`) плюс цоколь до самой низкой
 * точки рельефа под контуром. Экземпляры пишутся в отдельную исходную ячейку
 * `cells/expansion-buildings.json`, высоты seed — в `terrain-release.json` → `seedY`.
 * Правил фундамента и политик размещения у коробок нет (см. комментарий в цикле).
 * Здания, чей охват задевает старую область или край мира, пропускаются. Повторный
 * запуск заменяет все прежние коробки. Сборка мира OSM не читает.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { validateTerrainGrid, type BuildingInstance } from '@su/contracts';
import {
  validateFoundationSupportRule,
  type FoundationSupportRuleV2,
} from '@su/terrain-build/private-data';
import { planSupportPlacement } from '@su/terrain-build/supports';
import type { Point2 } from '@su/terrain-build/triangulate';
import type { FootprintRecipe } from './city.js';
import { OLD_MAX, OLD_MIN } from './widen-roads.js';

const WORLD_DIR = 'content/worlds/ring-block';
const WORLD = `${WORLD_DIR}/world.json`;
const RELEASE = `${WORLD_DIR}/terrain-release.json`;
const TERRAIN_SOURCE = `${WORLD_DIR}/terrain-expansion/source.json`;
const CELL_FILE = 'cells/expansion-buildings.json';
const CELL_ID = 'expansion-buildings';
const PROVENANCE = `${WORLD_DIR}/expansion-buildings/provenance.json`;
const BUILDINGS = 'content/buildings/ring-block';
const CATALOG = `${BUILDINGS}/catalog.json`;
const FOLDER = 'expansion';
const CACHE = 'output/expansion-buildings/osm.json';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const FETCH_MARGIN = 60;
/** Отступ от края мира: там стоят граничные стены. */
const EDGE_MARGIN = 4;
const LEVEL_HEIGHT = 3;
const MIN_AREA = 4;
/** Заглубление низа коробки под самой низкой точкой рельефа и зазор пола над высшей, м. */
const SINK = 0.3;
const CLEARANCE = 0.08;
/** Навесы, руины и стадионы коробкой не изображаются. */
const SKIPPED_TYPES = new Set([
  'roof',
  'carport',
  'ruins',
  'no',
  'collapsed',
  'demolished',
  // Контур стадиона охватывает и поле: сплошная коробка его закрывает.
  'stadium',
]);

type Tags = Record<string, string>;
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

/** Тип застройки → этажность по умолчанию, цвет стен и название. */
const KINDS: { match: string[]; levels: number; wall: string; name: string }[] = [
  {
    match: ['apartments', 'residential', 'dormitory', 'terrace'],
    levels: 5,
    wall: '#c9c2b4',
    name: 'жилой дом',
  },
  {
    match: ['house', 'detached', 'semidetached_house', 'cabin', 'bungalow', 'farm'],
    levels: 2,
    wall: '#a99b84',
    name: 'частный дом',
  },
  {
    match: ['garage', 'garages', 'shed', 'hut', 'kiosk', 'toilets', 'greenhouse', 'barn'],
    levels: 1,
    wall: '#8f8c88',
    name: 'гараж или сарай',
  },
  {
    match: [
      'industrial',
      'warehouse',
      'service',
      'transformer_tower',
      'storage_tank',
      'boiler_house',
      'manufacture',
      'hangar',
    ],
    levels: 2,
    wall: '#9a9ea2',
    name: 'служебное здание',
  },
  {
    match: [
      'school',
      'kindergarten',
      'university',
      'college',
      'hospital',
      'public',
      'civic',
      'government',
      'office',
      'commercial',
      'retail',
      'supermarket',
      'church',
      'train_station',
      'sports_hall',
      'hotel',
    ],
    levels: 3,
    wall: '#d2c6ad',
    name: 'общественное здание',
  },
];
const OTHER = { levels: 2, wall: '#bdb6aa', name: 'здание' };

const number = (value: string | undefined) => {
  const n = Number.parseFloat((value ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const round = (v: number) => Math.round(v * 100) / 100;

function signedArea(ring: Point2[]) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i],
      [bx, bz] = ring[(i + 1) % ring.length];
    s += ax * bz - bx * az;
  }
  return s / 2;
}

/** Убрать повторы, почти совпадающие и почти коллинеарные вершины. */
function cleanRing(points: Point2[]): Point2[] {
  let ring = points.map(([x, z]) => [round(x), round(z)] as Point2);
  for (let changed = true; changed && ring.length >= 3;) {
    changed = false;
    for (let i = 0; i < ring.length && ring.length >= 3; i++) {
      const a = ring[(i + ring.length - 1) % ring.length],
        b = ring[i],
        c = ring[(i + 1) % ring.length];
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const ac = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (ab < 0.05 || (ac > 0 && Math.abs(cross) / ac < 0.03)) {
        ring.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return ring;
}

function segmentsCross(a: Point2, b: Point2, c: Point2, d: Point2) {
  const o = (p: Point2, q: Point2, r: Point2) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a),
    d2 = o(c, d, b),
    d3 = o(a, b, c),
    d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function selfIntersects(ring: Point2[]) {
  const n = ring.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  return false;
}

/** Склеить незамкнутые пути мультиполигона в кольца (как в expansion-ground.ts). */
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

interface Box {
  id: string;
  osm: { type: 'way' | 'relation'; id: number };
  /** Мировой контур без повтора первой точки, обход против часовой (площадь > 0 в XZ). */
  ring: Point2[];
  levels: number;
  kind: { wall: string; name: string };
  tagged: boolean;
}

function boxes(
  elements: OsmElement[],
  toGame: (g: OsmGeometry) => Point2,
  world: { west: number; east: number; north: number; south: number },
) {
  const skipped = { oldArea: 0, edge: 0, type: 0, small: 0, invalid: 0 };
  const out: Box[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const type = tags.building;
    if (!type) continue;
    if (SKIPPED_TYPES.has(type)) {
      skipped.type++;
      continue;
    }
    let outers: Point2[][] = [];
    if (element.type === 'way' && element.geometry) {
      const g = element.geometry;
      if (g.length >= 4 && g[0].lat === g.at(-1)!.lat && g[0].lon === g.at(-1)!.lon)
        outers = [g.slice(0, -1).map(toGame)];
    } else if (element.type === 'relation' && element.members)
      outers = joinRings(
        element.members
          .filter((m) => m.type === 'way' && m.geometry && m.role === 'outer')
          .map((m) => m.geometry!.map(toGame)),
      );
    if (!outers.length) {
      skipped.invalid++;
      continue;
    }
    const kind = KINDS.find((k) => k.match.includes(type)) ?? OTHER;
    const levelsTag = number(tags['building:levels']);
    const heightTag = number(tags.height);
    const levels = Math.min(
      30,
      Math.max(
        1,
        Math.round(levelsTag ?? (heightTag ? heightTag / LEVEL_HEIGHT : undefined) ?? kind.levels),
      ),
    );
    outers.forEach((points, k) => {
      const xs = points.map((p) => p[0]),
        zs = points.map((p) => p[1]);
      const min = [Math.min(...xs), Math.min(...zs)],
        max = [Math.max(...xs), Math.max(...zs)];
      if (
        max[0] >= OLD_MIN[0] &&
        min[0] <= OLD_MAX[0] &&
        max[1] >= OLD_MIN[1] &&
        min[1] <= OLD_MAX[1]
      ) {
        skipped.oldArea++;
        return;
      }
      if (
        min[0] < world.west + EDGE_MARGIN ||
        max[0] > world.east - EDGE_MARGIN ||
        min[1] < world.north + EDGE_MARGIN ||
        max[1] > world.south - EDGE_MARGIN
      ) {
        skipped.edge++;
        return;
      }
      let ring = cleanRing(points);
      if (ring.length < 3 || selfIntersects(ring)) {
        skipped.invalid++;
        return;
      }
      const area = signedArea(ring);
      if (Math.abs(area) < MIN_AREA) {
        skipped.small++;
        return;
      }
      if (area < 0) ring = ring.reverse();
      const suffix = outers.length > 1 ? `-${k + 1}` : '';
      out.push({
        id: `osm-${element.type}-${element.id}${suffix}`,
        osm: { type: element.type as 'way' | 'relation', id: element.id },
        ring,
        levels,
        kind,
        tagged: levelsTag !== undefined,
      });
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return { boxes: out, skipped };
}

/** Начало модели — центр охвата контура, округлённый до сантиметра. */
function localise(ring: Point2[]) {
  const xs = ring.map((p) => p[0]),
    zs = ring.map((p) => p[1]);
  const cx = round((Math.min(...xs) + Math.max(...xs)) / 2),
    cz = round((Math.min(...zs) + Math.max(...zs)) / 2);
  return {
    position: { x: cx, y: 0, z: cz },
    outline: ring.map(([x, z]) => [round(x - cx), round(z - cz)] as Point2),
  };
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const isGenerated = (path: string) => path.startsWith(`${FOLDER}/`);

async function layoutMode(args: string[]) {
  const input = args[args.indexOf('--layout') + 1];
  const outIndex = args.indexOf('--out');
  if (!input || outIndex < 0)
    throw new Error('--layout requires <export.json> --out <edited.json>');
  const cell = JSON.parse(await readFile(`${WORLD_DIR}/${CELL_FILE}`, 'utf8'));
  const release = JSON.parse(await readFile(RELEASE, 'utf8'));
  const seedY: Record<string, number> = release.groundTerrain.seedY;
  const exported = JSON.parse(await readFile(input, 'utf8'));
  if (!Array.isArray(exported.instances)) throw new Error('Not a layout export');
  const present = new Set(exported.instances.map((i: { entityId: string }) => i.entityId));
  let added = 0;
  for (const b of cell.buildings as BuildingInstance[]) {
    if (present.has(b.entityId)) continue;
    exported.instances.push({
      ...b,
      position: { ...b.position, y: seedY[b.entityId] },
      enabled: true,
      instanceRevision: 1,
    });
    added++;
  }
  await writeFile(args[outIndex + 1], json(exported));
  console.log(`layout: added ${added}, already present ${cell.buildings.length - added}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--layout')) return layoutMode(args);
  const terrain = JSON.parse(await readFile(TERRAIN_SOURCE, 'utf8'));
  const world = terrain.worldBoundsXZ as {
    west: number;
    east: number;
    north: number;
    south: number;
  };
  const origin = terrain.originWgs84 as { lon: number; lat: number };
  const mpd = terrain.metresPerDegree as { lon: number; lat: number };
  const query = (() => {
    const s = origin.lat - (world.south + FETCH_MARGIN) / mpd.lat,
      n = origin.lat - (world.north - FETCH_MARGIN) / mpd.lat,
      w = origin.lon + (world.west - FETCH_MARGIN) / mpd.lon,
      e = origin.lon + (world.east + FETCH_MARGIN) / mpd.lon;
    const b = [s, w, n, e].map((v) => v.toFixed(5)).join(',');
    return `[out:json][timeout:120];(way[building](${b});relation[building][type=multipolygon](${b}););out geom;`;
  })();
  if (args.includes('--fetch')) {
    const response = await fetch(OVERPASS, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'su-world-build',
      },
      body: new URLSearchParams({ data: query }),
    });
    if (!response.ok) throw new Error(`Overpass ${response.status}`);
    await mkdir('output/expansion-buildings', { recursive: true });
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
  const result = boxes(snapshot.elements, toGame, world);

  // Каталог: прежние коробки удаляются, ручные модели не трогаются.
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  for (const [id, path] of Object.entries(catalog.assets as Record<string, string>))
    if (isGenerated(path)) delete catalog.assets[id];
  for (const b of result.boxes)
    if (Object.hasOwn(catalog.assets, b.id)) throw new Error(`Catalog already has ${b.id}`);
  await rm(`${BUILDINGS}/${FOLDER}`, { recursive: true, force: true });

  const release = JSON.parse(await readFile(RELEASE, 'utf8'));
  const ground = release.groundTerrain;
  const gridBytes = await readFile(`${WORLD_DIR}/${ground.grid.file}`);
  if (createHash('sha256').update(gridBytes).digest('hex') !== ground.grid.sha256)
    throw new Error('Terrain grid hash mismatch: restore LF bytes (git show HEAD:<grid> > <grid>)');
  const grid = validateTerrainGrid(JSON.parse(gridBytes.toString()));
  // Прежние коробки: их фундаменты, политики и высоты seed заменяются целиком.
  const oldCell = JSON.parse(
    await readFile(`${WORLD_DIR}/${CELL_FILE}`, 'utf8').catch(() => '{"buildings":[]}'),
  ) as { buildings: BuildingInstance[] };
  const previous = new Set(oldCell.buildings.map((b) => b.assetId));
  ground.supports = ground.supports.filter((r: { assetId: string }) => !previous.has(r.assetId));
  ground.placementModels = ground.placementModels.filter(
    (m: { assetId: string }) => !previous.has(m.assetId),
  );
  for (const b of oldCell.buildings) delete ground.seedY[b.entityId];

  const instances: BuildingInstance[] = [];
  let top = ground.header.bounds.max.y as number;
  const levelCounts: Record<number, number> = {};
  for (const b of result.boxes) {
    const { position, outline } = localise(b.ring);
    const instance: BuildingInstance = {
      entityId: b.id,
      assetId: b.id,
      position,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      sourceRef: { provider: 'osm', type: b.osm.type, id: String(b.osm.id) },
    };
    // Рельеф под контуром — через расчёт фундамента; само правило не сохраняется:
    // каждое правило даёт при публикации отдельную модель фундамента на экземпляр,
    // а 1830 таких моделей выводят мир за предел 10 000 ссылок на здания.
    const probe = validateFoundationSupportRule({
      assetId: b.id,
      burial: SINK,
      clearance: CLEARANCE,
      color: '#8b8580',
      components: [{ outline }],
      jointY: 0,
      kind: 'foundation-v2',
    });
    const plan = planSupportPlacement(grid, probe as FoundationSupportRuleV2, instance);
    // Цоколь — часть той же призмы: низ ниже самой низкой точки рельефа, пол первого
    // этажа там же, где был бы у фундамента.
    const base = Math.floor((plan.terrainMin - SINK) * 100) / 100;
    const plinth = round(plan.minimumY - base);
    const height = round(plinth + b.levels * LEVEL_HEIGHT);
    const recipe: FootprintRecipe = {
      formatVersion: 1,
      outline,
      height,
      floors: b.levels,
      windows: false,
      wallColor: b.kind.wall,
      roofColor: '#5d5a57',
      windowColor: '#29343c',
      merge: true,
      windowGlow: 'none',
    };
    const dir = `${BUILDINGS}/${FOLDER}/${b.id}`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/source.json`, JSON.stringify(recipe) + '\n');
    await writeFile(
      `${dir}/asset.json`,
      json({
        formatVersion: 1,
        assetId: b.id,
        source: { kind: 'footprint', file: 'source.json' },
        metadata: {
          name: `Болванка: ${b.kind.name}, ${b.levels} эт.`,
          description: `Временная коробка по контуру OSM ${b.osm.type}/${b.osm.id} без окон и деталей (этап B расширения). ${b.levels} эт. × ${LEVEL_HEIGHT} м${b.tagged ? ' по building:levels' : ' по типу здания'} и цоколь ${plinth} м до рельефа.`,
          category: 'buildings',
          tags: ['building', 'placeholder', `floors-${b.levels}`],
        },
      }),
    );
    catalog.assets[b.id] = `${FOLDER}/${b.id}/asset.json`;
    ground.seedY[b.id] = base;
    top = Math.max(top, Math.ceil(base + height + 2));
    instances.push(instance);
    levelCounts[b.levels] = (levelCounts[b.levels] ?? 0) + 1;
  }
  ground.header.bounds.max.y = top;
  catalog.assets = Object.fromEntries(
    Object.entries(catalog.assets).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(CATALOG, json(catalog));
  await writeFile(RELEASE, json(release));
  await writeFile(
    `${WORLD_DIR}/${CELL_FILE}`,
    json({ formatVersion: 2, cellId: CELL_ID, statics: [], buildings: instances }),
  );
  const worldDefinition = JSON.parse(await readFile(WORLD, 'utf8'));
  if (!worldDefinition.cells.includes(CELL_FILE)) {
    worldDefinition.cells.push(CELL_FILE);
    await writeFile(WORLD, json(worldDefinition));
  }
  const tagged = result.boxes.filter((b) => b.tagged).length;
  await mkdir(`${WORLD_DIR}/expansion-buildings`, { recursive: true });
  await writeFile(
    PROVENANCE,
    json({
      formatVersion: 1,
      source: 'OpenStreetMap via Overpass API',
      license: 'ODbL 1.0, © OpenStreetMap contributors',
      osmTimestamp: snapshot.osm3s?.timestamp_osm_base,
      snapshotSha256: createHash('sha256').update(bytes).digest('hex'),
      query,
      excludedRectangle: { min: OLD_MIN, max: OLD_MAX },
      height: `building:levels × ${LEVEL_HEIGHT} m; иначе height / ${LEVEL_HEIGHT}; иначе по типу building`,
      buildings: result.boxes.length,
      withLevels: tagged,
      levels: levelCounts,
      skipped: result.skipped,
    }),
  );
  console.log(
    `boxes: ${result.boxes.length} (${tagged} with building:levels), skipped ${JSON.stringify(result.skipped)}, header max.y ${top}`,
  );
}

await main();
