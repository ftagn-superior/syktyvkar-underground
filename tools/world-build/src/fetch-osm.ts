/**
 * Снимок данных OpenStreetMap для участка: ограды, деревья, скамейки, фонари,
 * остановки, площадки, парковки, входы в здания и теги домов.
 *
 *   pnpm world:fetch-osm            # content/worlds/ring-block/import.json
 *
 * Снимок сохраняется в репозиторий, поэтому сборка мира не зависит от сети и повторяема.
 * Проекция совпадает с прототипом: метры от центра кольца, x — восток, y — север
 * (в игре z = −y). Коэффициенты подобраны по 238 домам, расхождение — около 2 см.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OsmSettings {
  snapshot: string;
  origin: { lat: number; lon: number };
  metersPerDegree: { lon: number; lat: number };
  fetchMargin: number;
}
export interface OsmElement {
  type: 'node' | 'way';
  id: number;
  tags: Record<string, string>;
  /** Узел: [lat, lon]. */
  point?: [number, number];
  /** Линия: точки [lat, lon] и ID узлов в том же порядке. */
  geometry?: [number, number][];
  nodes?: number[];
}
export interface OsmSnapshot {
  formatVersion: 1;
  license: string;
  source: string;
  fetchedAt: string;
  bbox: { south: number; west: number; north: number; east: number };
  elements: OsmElement[];
}

const ENDPOINT = 'https://overpass-api.de/api/interpreter';

/** Метры участка (x — восток, y — север) → широта и долгота. */
export function toLatLon(settings: OsmSettings, x: number, y: number): [number, number] {
  return [
    settings.origin.lat + y / settings.metersPerDegree.lat,
    settings.origin.lon + x / settings.metersPerDegree.lon,
  ];
}
/** Широта и долгота → игровые метры [x, z]; север — −Z. */
export function toGame(settings: OsmSettings, lat: number, lon: number): [number, number] {
  return [
    (lon - settings.origin.lon) * settings.metersPerDegree.lon,
    -(lat - settings.origin.lat) * settings.metersPerDegree.lat,
  ];
}

export function overpassQuery(bbox: OsmSnapshot['bbox']): string {
  const b = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  return `[out:json][timeout:120];
(
  way["barrier"]${b};
  node["barrier"]${b};
  node["natural"="tree"]${b};
  way["natural"~"^(tree_row|wood|scrub)$"]${b};
  way["landuse"="forest"]${b};
  node["highway"~"^(street_lamp|bus_stop)$"]${b};
  node["amenity"~"^(bench|waste_basket)$"]${b};
  way["leisure"="playground"]${b};
  way["amenity"="parking"]${b};
  node["entrance"]${b};
);
out body geom;
way["building"]${b};
out tags;`;
}

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

/** Приводит ответ Overpass к стабильному виду: только нужные поля, сортировка по типу и ID. */
export function normalize(raw: { elements: any[] }): OsmElement[] {
  const byKey = new Map<string, OsmElement>();
  for (const e of raw.elements) {
    if ((e.type !== 'node' && e.type !== 'way') || !e.tags) continue;
    const key = `${e.type}/${e.id}`;
    const geometry = e.geometry?.map(
      (g: any) => [round7(g.lat), round7(g.lon)] as [number, number],
    );
    // Объект может прийти дважды: с геометрией (например, здание-ограда) и только с тегами.
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.geometry && geometry) Object.assign(existing, { geometry, nodes: e.nodes });
      continue;
    }
    const tags = Object.fromEntries(
      Object.entries(e.tags as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    const element: OsmElement = { type: e.type, id: e.id, tags };
    if (e.type === 'node') element.point = [round7(e.lat), round7(e.lon)];
    else if (geometry) Object.assign(element, { geometry, nodes: e.nodes });
    byKey.set(key, element);
  }
  return [...byKey.values()].sort((a, b) =>
    a.type === b.type ? a.id - b.id : a.type < b.type ? -1 : 1,
  );
}

export async function fetchOsm(configPath: string, root = process.cwd()) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const settings = config.osm as OsmSettings;
  if (!settings) throw new Error('import.json has no osm section');
  const world = JSON.parse(await readFile(resolve(dirname(configPath), 'world.json'), 'utf8'));
  const { min, max } = world.bounds;
  const m = settings.fetchMargin;
  // Мир задан в игровых осях: север — −Z, поэтому y = −z.
  const [south, west] = toLatLon(settings, min.x - m, -max.z - m);
  const [north, east] = toLatLon(settings, max.x + m, -min.z + m);
  const bbox = {
    south: round7(south),
    west: round7(west),
    north: round7(north),
    east: round7(east),
  };
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'syktyvkar-underground-world-build/1.0',
    },
    body: new URLSearchParams({ data: overpassQuery(bbox) }),
  });
  if (!response.ok) throw new Error(`Overpass responded ${response.status}`);
  const elements = normalize(await response.json());
  const snapshot: OsmSnapshot = {
    formatVersion: 1,
    license: '© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright',
    source: ENDPOINT,
    fetchedAt: new Date().toISOString().slice(0, 10),
    bbox,
    elements,
  };
  const target = resolve(root, settings.snapshot);
  await mkdir(dirname(target), { recursive: true });
  // Один элемент на строку: снимок остаётся читаемым в diff при обновлении.
  const lines = elements.map((element) => '    ' + JSON.stringify(element));
  const { elements: _skip, ...head } = snapshot;
  const header = JSON.stringify(head, null, 2).replace(/\n}$/, ',\n  "elements": [\n');
  await writeFile(target, header + lines.join(',\n') + '\n  ]\n}\n');
  return { target, count: elements.length, bbox };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await fetchOsm(process.argv[2] ?? 'content/worlds/ring-block/import.json');
  console.log(`Снимок OSM: ${result.count} объектов → ${result.target}`);
}
