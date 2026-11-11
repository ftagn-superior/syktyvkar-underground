/**
 * Импорт городского участка из автономного прототипа `data/syktyvkar-offline.html`.
 *
 * Прототип хранит подготовленные данные OSM в объекте `u3`: метры от центра кольца,
 * x — восток, y — север. В игре север — это −Z, поэтому z = −y.
 * Скрипт выпускает обычный контент мира v2; дальше его собирает `pnpm world:build`.
 *
 *   pnpm world:import            # content/worlds/ring-block/import.json
 *   pnpm world:import -- <путь к import.json>
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { BuildingInstance, EntityDefinition, Vec3, WorldSource } from '@su/contracts';
import type { FootprintRecipe, GroundLayer, GroundRecipe, TreeRecipe } from './city.js';
import { cleanRing, clipRing, signedArea, triangulate, type Point2 } from './triangulate.js';

interface ImportConfig {
  formatVersion: 1;
  worldId: string;
  source: string;
  /** Метры от центра кольца: запад/восток по x, юг/север по y данных прототипа. */
  area: { west: number; east: number; south: number; north: number };
  margin: number;
  /** Радиус вокруг точек появления и ящика, где не ставятся деревья. */
  spawnClearance: number;
  spawnPoints: Vec3[];
  crate: Vec3;
  /** Подпись над зданием по OSM-ID или в точке мира (игровые координаты). */
  landmarks?: { id: string; name: string; osm?: string; position?: Vec3 }[];
  /** Ручные уточнения домов по OSM-ID: цвета, этажность и детали фасада. */
  buildings?: Record<string, BuildingOverride>;
  /** Вертикальное растяжение всех домов из `buildings`, если у дома не задан свой `heightScale`. */
  detailedHeightScale?: number;
  /** Штучные объекты из `content/buildings/<worldId>/manual/<assetId>/`. */
  props?: { entityId: string; assetId: string; position: Vec3; yaw?: number }[];
}
const OVERRIDABLE = [
  'height',
  'floors',
  'windows',
  'wallColor',
  'roofColor',
  'windowColor',
  'details',
  'elevation',
  'sections',
  'heightScale',
] as const;
type BuildingOverride = Partial<Pick<FootprintRecipe, (typeof OVERRIDABLE)[number]>> & {
  /** Пояснение для людей; в модель не попадает. */
  note?: string;
};
/** Каталог ручных моделей внутри папки участка; импорт его не удаляет. */
const MANUAL_DIRECTORY = 'manual';
type Ring = [number, number][];
interface SourceBuilding {
  id: string;
  name: string;
  address: string;
  type: string;
  p: Ring[];
  c: [number, number];
  h: number;
  levels: number | null;
  color: string | null;
  roofColor: string | null;
}
interface SourceData {
  buildings: SourceBuilding[];
  roads: { walk: boolean; kind: string; p: Ring[][] }[];
  grounds: { kind: string; p: Ring[] }[];
  trees: [number, number, number, number][];
}

/** Извлекает литерал `u3={...}` без выполнения остального кода страницы. */
export function extractPrototypeData(html: string): SourceData {
  const start = html.indexOf('u3={');
  if (start < 0) throw new Error('Prototype data object u3 not found');
  let depth = 0,
    quote: string | null = null,
    end = start + 3;
  for (; end < html.length; end++) {
    const c = html[end];
    if (quote) {
      if (c === '\\') end++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) break;
  }
  // Литерал содержит только данные; отдельный контекст без глобальных объектов.
  return runInNewContext(`(${html.slice(start + 3, end + 1)})`, Object.create(null), {
    timeout: 5000,
  });
}

const round = (n: number) => Math.round(n * 100) / 100 || 0;
/** Детерминированный выбор оттенка по OSM-ID. */
function pick<T>(seed: string, values: readonly T[]): T {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return values[(h >>> 0) % values.length];
}
function seeded(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}
const toGame = ([x, y]: [number, number]): Point2 => [x, -y];
function pointInRing([x, z]: Point2, ring: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i],
      [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Палитра близка к исходному прототипу: светлые фасады и приглушённые крыши.
const WALLS = [
  '#ddd9c7',
  '#e7decb',
  '#ccbfaa',
  '#d5c7b2',
  '#b8c2b3',
  '#d9c6af',
  '#e3dcd1',
  '#c3bda9',
];
const ROOFS = ['#a7aaa2', '#a49380', '#8d9b95', '#a2a38b', '#9ca3a1', '#aa8d77'];
const NAMED_COLORS: Record<string, string> = {
  white: '#e8e6df',
  beige: '#dccfb0',
  gold: '#d8b866',
  yellow: '#e2cf86',
  grey: '#9a9d9c',
  gray: '#9a9d9c',
  brown: '#8d6e5a',
  red: '#b0675a',
};
const UTILITY = new Set(['garages', 'garage', 'service', 'shed', 'roof', 'hut', 'kiosk']);
const GROUND = {
  base: '#b5b4a2',
  layers: [
    { id: 'green', color: '#9fb98a', elevation: 0.002 },
    { id: 'park', color: '#8fb07a', elevation: 0.003 },
    { id: 'pitch', color: '#7fa56e', elevation: 0.004 },
    { id: 'footway', color: '#d8d0b8', elevation: 0.006 },
    { id: 'service', color: '#8e948c', elevation: 0.008 },
    { id: 'road', color: '#6f7670', elevation: 0.01 },
  ],
};

export async function importDistrict(configPath: string, root = process.cwd()) {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as ImportConfig;
  if (config.formatVersion !== 1 || !/^[a-z0-9-]{1,64}$/.test(config.worldId))
    throw new Error('Invalid district import config');
  const data = extractPrototypeData(await readFile(resolve(root, config.source), 'utf8'));
  const { west, east, south, north } = config.area;

  // 1. Здания с центром внутри участка; границы мира расширяются, чтобы не резать дома.
  const selected = data.buildings.filter(
    (b) => b.c[0] >= west && b.c[0] <= east && b.c[1] >= south && b.c[1] <= north,
  );
  let [minX, maxX, minZ, maxZ] = [west, east, -north, -south];
  for (const b of selected)
    for (const [x, z] of b.p[0].map(toGame)) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  minX = Math.floor(minX - config.margin);
  maxX = Math.ceil(maxX + config.margin);
  minZ = Math.floor(minZ - config.margin);
  maxZ = Math.ceil(maxZ + config.margin);
  const clipMin: Point2 = [minX, minZ],
    clipMax: Point2 = [maxX, maxZ];

  const report = { buildings: 0, skipped: [] as string[], polygons: 0, poorCoverage: 0, trees: 0 };
  const buildingsDir = resolve(root, 'content/buildings', config.worldId);
  const worldDir = dirname(resolve(configPath));
  // Сгенерированные модели пересоздаются целиком; ручные из manual/ сохраняются.
  await mkdir(buildingsDir, { recursive: true });
  for (const entry of await readdir(buildingsDir))
    if (entry !== MANUAL_DIRECTORY)
      await rm(join(buildingsDir, entry), { recursive: true, force: true });
  await rm(join(worldDir, 'cells'), { recursive: true, force: true });
  const catalog: Record<string, string> = {};
  const overrides = config.buildings ?? {};
  for (const [osm, override] of Object.entries(overrides)) {
    if (!selected.some((b) => b.id === osm))
      throw new Error(`Building override ${osm} refers to a building outside the area`);
    for (const key of Object.keys(override))
      if (key !== 'note' && !(OVERRIDABLE as readonly string[]).includes(key))
        throw new Error(`Building override ${osm} has unsupported field ${key}`);
  }
  const writeAsset = async (assetId: string, kind: string, recipe: unknown) => {
    const directory = join(buildingsDir, assetId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'asset.json'),
      JSON.stringify(
        { formatVersion: 1, assetId, source: { kind, file: 'source.json' } },
        null,
        2,
      ) + '\n',
    );
    await writeFile(join(directory, 'source.json'), JSON.stringify(recipe) + '\n');
    catalog[assetId] = `${assetId}/asset.json`;
  };

  const instances: BuildingInstance[] = [];
  const footprints: Point2[][] = [];
  const roofs = new Map<string, Vec3>();
  const usedIds = new Set<string>();
  // Высота самого высокого дома с учётом растяжения: по ней выбирается верх границ мира.
  let tallest = 10;
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  for (const b of selected.sort((a, z) => (a.id < z.id ? -1 : 1))) {
    const outline = cleanRing(b.p[0].map(toGame));
    if (outline.length < 3 || Math.abs(signedArea(outline)) < 4) {
      report.skipped.push(`${b.id}: вырожденный контур`);
      continue;
    }
    const shape = triangulate(outline);
    if (Math.abs(shape.coverage - 1) > 0.001) {
      report.skipped.push(`${b.id}: самопересекающийся контур`);
      continue;
    }
    // OSM-ID может повторяться у частей одного здания; ID экземпляра остаётся уникальным.
    const base = `osm-${b.id.replace('/', '-')}`;
    let assetId = base;
    for (let n = 2; usedIds.has(assetId); n++) assetId = `${base}-${n}`;
    usedIds.add(assetId);
    const cx = round(outline.reduce((s, p) => s + p[0], 0) / outline.length);
    const cz = round(outline.reduce((s, p) => s + p[1], 0) / outline.length);
    const height = Math.max(2.5, b.h);
    const recipe: FootprintRecipe = {
      formatVersion: 1,
      outline: outline.map(([x, z]) => [round(x - cx), round(z - cz)]),
      height: round(height),
      floors: Math.max(1, Math.min(60, b.levels ?? Math.round(height / 3.2))),
      windows: !UTILITY.has(b.type) && height >= 5,
      wallColor: UTILITY.has(b.type)
        ? '#b6b8a8'
        : (NAMED_COLORS[b.color ?? ''] ?? pick(`${b.id}:wall`, WALLS)),
      roofColor: NAMED_COLORS[b.roofColor ?? ''] ?? pick(`${b.id}:roof`, ROOFS),
      windowColor: '#3d4d57',
    };
    if (overrides[b.id]) {
      const { note: _note, ...override } = overrides[b.id];
      // Уточнённые дома растягиваются по высоте, если сам override не задаёт масштаб.
      if (config.detailedHeightScale !== undefined) recipe.heightScale = config.detailedHeightScale;
      Object.assign(recipe, override);
    }
    await writeAsset(assetId, 'footprint', recipe);
    const wallTop = recipe.height * (recipe.heightScale ?? 1);
    tallest = Math.max(tallest, wallTop);
    const [kind, osmId] = b.id.split('/');
    instances.push({
      entityId: assetId,
      assetId,
      position: { x: cx, y: 0, z: cz },
      rotation: identity,
      sourceRef: { provider: 'osm', type: kind, id: osmId },
    });
    footprints.push(outline);
    if (!roofs.has(b.id)) roofs.set(b.id, { x: cx, y: round(wallTop + 3), z: cz });
    report.buildings++;
  }

  // 2. Поверхность: зелень, площадки, тротуары и проезжая часть, обрезанные границей мира.
  const layers: GroundLayer[] = GROUND.layers.map((layer) => ({ ...layer, polygons: [] }));
  const layer = (id: string) => layers.find((l) => l.id === id)!;
  const roadPolygons: Point2[][] = [];
  const addPolygon = (target: GroundLayer, rings: Ring[]) => {
    const [outer, ...holes] = rings.map((ring) =>
      cleanRing(clipRing(ring.map(toGame), clipMin, clipMax)),
    );
    if (!outer || outer.length < 3 || Math.abs(signedArea(outer)) < 0.5) return;
    const kept = holes.filter((hole) => hole.length >= 3 && Math.abs(signedArea(hole)) >= 0.5);
    const shape = triangulate(outer, kept);
    report.polygons++;
    if (Math.abs(shape.coverage - 1) > 0.02) report.poorCoverage++;
    const rounded = [outer, ...kept].map((ring) =>
      ring.map(([x, z]) => [round(x), round(z)] as Point2),
    );
    target.polygons.push(rounded);
    return rounded;
  };
  for (const ground of data.grounds)
    if (['green', 'park', 'pitch'].includes(ground.kind)) addPolygon(layer(ground.kind), ground.p);
  for (const road of data.roads) {
    const target = road.walk ? 'footway' : road.kind === 'service' ? 'service' : 'road';
    for (const polygon of road.p) {
      const added = addPolygon(layer(target), polygon);
      if (added && !road.walk) roadPolygons.push(added[0]);
    }
  }
  const groundRecipe: GroundRecipe = {
    formatVersion: 1,
    min: clipMin,
    max: clipMax,
    depth: 1,
    color: GROUND.base,
    layers,
  };
  const groundId = `${config.worldId}-ground`;
  await writeAsset(groundId, 'ground', groundRecipe);
  instances.unshift({
    entityId: 'ground',
    assetId: groundId,
    position: { x: 0, y: 0, z: 0 },
    rotation: identity,
  });

  // 3. Штучные объекты: ручные модели из manual/, например памятник в центре кольца.
  for (const prop of config.props ?? []) {
    const descriptor = `${MANUAL_DIRECTORY}/${prop.assetId}/asset.json`;
    await readFile(join(buildingsDir, descriptor)).catch(() => {
      throw new Error(`Manual asset ${prop.assetId} not found in ${MANUAL_DIRECTORY}/`);
    });
    catalog[prop.assetId] = descriptor;
    const yaw = ((prop.yaw ?? 0) * Math.PI) / 180;
    instances.push({
      entityId: prop.entityId,
      assetId: prop.assetId,
      position: prop.position,
      rotation: {
        x: 0,
        y: round(Math.sin(yaw / 2) * 1e6) / 1e6,
        z: 0,
        w: round(Math.cos(yaw / 2) * 1e6) / 1e6,
      },
    });
  }

  // 4. Декоративные деревья из прототипа, кроме стоящих в домах, на проезжей части и у старта.
  const trees: Record<string, TreeRecipe> = {
    'tree-spruce-small': {
      formatVersion: 1,
      height: 7,
      crownRadius: 1.8,
      trunkColor: '#6b5a49',
      crownColor: '#4f7a4f',
    },
    'tree-spruce-large': {
      formatVersion: 1,
      height: 10,
      crownRadius: 2.4,
      trunkColor: '#6b5a49',
      crownColor: '#456e47',
    },
  };
  const clear = [
    ...config.spawnPoints,
    config.crate,
    ...(config.props ?? []).map((prop) => prop.position),
  ];
  let treeIndex = 0;
  for (const [sx, sy, size] of data.trees) {
    const [x, z] = toGame([sx, sy]);
    const assetId = size < 8.5 ? 'tree-spruce-small' : 'tree-spruce-large';
    // Габарит повёрнутой модели проверяется по углам её рамки: берём запас √2.
    const r = trees[assetId].crownRadius * Math.SQRT2 + 0.1;
    if (x - r < minX || x + r > maxX || z - r < minZ || z + r > maxZ) continue;
    if (clear.some((p) => Math.hypot(p.x - x, p.z - z) < config.spawnClearance)) continue;
    if (footprints.some((ring) => pointInRing([x, z], ring))) continue;
    if (roadPolygons.some((ring) => pointInRing([x, z], ring))) continue;
    const yaw = seeded(`tree:${sx}:${sy}`) * Math.PI * 2;
    instances.push({
      entityId: `tree-${String(++treeIndex).padStart(3, '0')}`,
      assetId,
      position: { x: round(x), y: 0, z: round(z) },
      rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    });
  }
  report.trees = treeIndex;
  for (const [assetId, recipe] of Object.entries(trees))
    if (instances.some((i) => i.assetId === assetId)) await writeAsset(assetId, 'tree', recipe);

  // 5. Точки появления не должны оказаться внутри дома.
  const radius = 0.35;
  for (const spawn of config.spawnPoints)
    for (const ring of footprints)
      if (
        pointInRing([spawn.x, spawn.z], ring) ||
        ring.some(([x, z]) => Math.hypot(x - spawn.x, z - spawn.z) < radius)
      )
        throw new Error(`Spawn point ${spawn.x},${spawn.z} is inside a building`);

  // 6. Мир: границы, ограждение по краю, ящик и ссылки на ячейку и каталог.
  const wall = (entityId: string, position: Vec3, size: Vec3): EntityDefinition => ({
    entityId,
    kind: 'obstacle',
    position,
    size,
    mass: 0,
    friction: 0.6,
    restitution: 0.05,
    color: '#414f60',
  });
  const width = maxX - minX,
    depth = maxZ - minZ,
    midX = (minX + maxX) / 2,
    midZ = (minZ + maxZ) / 2;
  const world: WorldSource = {
    formatVersion: 3,
    worldId: config.worldId,
    bounds: {
      min: { x: minX, y: -5, z: minZ },
      max: { x: maxX, y: Math.ceil((tallest + 10) / 10) * 10, z: maxZ },
    },
    simulation: {
      tickRate: 60,
      gravity: { x: 0, y: -9.81, z: 0 },
      character: { height: 1.8, radius, speed: 4, sprintSpeed: 14, mass: 70 },
    },
    spawnPoints: config.spawnPoints,
    itemCatalog: relative(worldDir, 'content/items/catalog.json').replaceAll('\\', '/'),
    initialItems: [
      {
        seedId: 'crate-01',
        typeId: 'wooden-crate',
        position: config.crate,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    ],
    entities: [
      wall('boundary-north', { x: midX, y: 0.75, z: minZ + 0.25 }, { x: width, y: 1.5, z: 0.5 }),
      wall('boundary-south', { x: midX, y: 0.75, z: maxZ - 0.25 }, { x: width, y: 1.5, z: 0.5 }),
      wall('boundary-west', { x: minX + 0.25, y: 0.75, z: midZ }, { x: 0.5, y: 1.5, z: depth }),
      wall('boundary-east', { x: maxX - 0.25, y: 0.75, z: midZ }, { x: 0.5, y: 1.5, z: depth }),
    ],
    landmarks: (config.landmarks ?? []).map(({ id, name, osm, position }) => {
      const anchor = osm ? roofs.get(osm) : position;
      if (!anchor) throw new Error(`Landmark ${id} refers to a building outside the area`);
      return { id, name, position: anchor };
    }),
    cells: ['cells/0_0.json'],
    assetCatalog: relative(worldDir, join(buildingsDir, 'catalog.json')).replaceAll('\\', '/'),
  };
  await mkdir(join(worldDir, 'cells'), { recursive: true });
  await writeFile(
    join(worldDir, 'cells/0_0.json'),
    JSON.stringify({ formatVersion: 1, cellId: '0_0', buildings: instances }, null, 2) + '\n',
  );
  await writeFile(join(worldDir, 'world.json'), JSON.stringify(world, null, 2) + '\n');
  await writeFile(
    join(buildingsDir, 'catalog.json'),
    JSON.stringify({ formatVersion: 1, assets: catalog }, null, 2) + '\n',
  );
  return { ...report, bounds: world.bounds, instances: instances.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = process.argv[2] ?? 'content/worlds/ring-block/import.json';
  const report = await importDistrict(config);
  console.log(
    `Участок импортирован: ${report.buildings} зданий, ${report.trees} деревьев, ` +
      `${report.polygons} участков поверхности (${report.poorCoverage} с неточной триангуляцией).`,
  );
  console.log(
    `Границы X ${report.bounds.min.x}…${report.bounds.max.x}, Z ${report.bounds.min.z}…${report.bounds.max.z}`,
  );
  for (const line of report.skipped) console.log(`Пропущено ${line}`);
}
