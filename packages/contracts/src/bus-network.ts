/**
 * Автобусы как быстрые поездки: игрок у конкретной платформы остановки может уехать
 * только туда, куда действительно идёт автобус с этой стороны дороги (и только по ходу
 * направления). Сеть строит `tools/world-build/src/bus-network.ts` в
 * `content/worlds/ring-block/bus-network/`.
 * Правила здесь общие: клиент по ним рисует карту, сервер — проверяет поездку.
 */
import type { Vec3 } from './simulation.js';

export type BusPoint = [number, number];

export interface BusPlatform {
  /** Стабильный id платформы/стороны остановки, например `osm-2165055372`. */
  id: string;
  /** Мировые X/Z, м. */
  position: BusPoint;
  /** Единичный вектор [dx, dz] движения транспорта мимо платформы (X — восток, Z — юг). */
  bearing?: BusPoint;
  /** Подпись стороны/направления, например «в сторону Поликлиники №3». */
  sideHint?: string;
  source: 'osm' | 'interpolated' | 'override';
}

export interface BusStop {
  id: string;
  name: string;
  /** Мировые X/Z, м: центр остановки для подписи на карте. */
  position: BusPoint;
  platforms: BusPlatform[];
  routes: string[];
  /** `interpolated` — места нет в OSM, остановка поставлена на путь автобуса. */
  source: 'osm' | 'interpolated';
}

export interface BusRouteStopRef {
  stopId: string;
  platformId: string;
}

export type BusSequenceEntry = BusRouteStopRef | { offWorld: string[] };

export interface BusRouteDirection {
  /** Конечная или название направления (например, «Совхоз Пригородный», «по часовой»). */
  towards: string;
  /** Кольцевой рейс: после окончания круга автобус продолжает цикл от начала. */
  circular: boolean;
  /** Остановки мира (с точной платформой) и свёрнутые участки вне мира. */
  sequence: BusSequenceEntry[];
  /** Путь по улицам между соседними остановками мира: куски ломаной X/Z. */
  legs: BusPoint[][][];
}

export interface BusRoute {
  id: string;
  ref: string;
  name: string;
  from: string;
  to: string;
  circular: boolean;
  transport11?: string;
  directions: BusRouteDirection[];
}

export interface BusNetwork {
  formatVersion: 3;
  stops: BusStop[];
  routes: BusRoute[];
}

/** Файлы выпуска мира: сеть (сервер и клиент) и подложка карты (только клиент). */
export const BUS_NETWORK_FILE = 'bus-network.json';
export const BUS_MAP_FILE = 'bus-map.json';
/** Предел размера файлов автобусов в выпуске, байт. */
export const BUS_FILE_MAX_BYTES = 4 * 1024 * 1024;

/** Маршруты в игре; остальные из сети пока скрыты, чтобы карта читалась. */
export const BUS_ROUTES_IN_GAME = [
  '1',
  '4',
  '8',
  '17М',
  '18М',
  '19',
  '20',
  '54М',
  '101',
  '174',
] as const;

/** Подсказка «Автобусы» у платформы остановки, м по горизонтали. */
export const BUS_STOP_PROMPT_RANGE = 6;
/** Сервер принимает поездку чуть дальше подсказки: задержка позиции и ширина остановки. */
export const BUS_STOP_SERVER_RANGE = 10;
/** Макс. расстояние пешего перехода между платформами одной остановки при пересадке/подсказке, м. */
export const BUS_PLATFORM_WALK_RANGE = 200;

const ID = /^[a-z0-9-]{1,80}$/;

export interface BusTravelRequest {
  requestId: number;
  worldEpoch: string;
  fromPlatformId: string;
  toPlatformId: string;
  routeId: string;
  directionIndex: number;
}

export function parseBusTravelRequest(value: unknown): BusTravelRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !==
      'directionIndex,fromPlatformId,requestId,routeId,toPlatformId,worldEpoch' ||
    !Number.isSafeInteger(v.requestId) ||
    !Number.isSafeInteger(v.directionIndex) ||
    (v.directionIndex as number) < 0 ||
    typeof v.worldEpoch !== 'string' ||
    !['fromPlatformId', 'toPlatformId', 'routeId'].every(
      (key) => typeof v[key] === 'string' && ID.test(v[key] as string),
    )
  )
    return;
  return v as unknown as BusTravelRequest;
}

const isPoint = (p: unknown): p is BusPoint =>
  Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v));

const isPlatform = (value: unknown): value is BusPlatform => {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<BusPlatform>;
  return (
    typeof p.id === 'string' &&
    ID.test(p.id) &&
    isPoint(p.position) &&
    (p.bearing === undefined || isPoint(p.bearing)) &&
    (p.sideHint === undefined || typeof p.sideHint === 'string') &&
    (p.source === 'osm' || p.source === 'interpolated' || p.source === 'override')
  );
};

const isRouteStopRef = (value: unknown): value is BusRouteStopRef => {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<BusRouteStopRef>;
  return typeof e.stopId === 'string' && typeof e.platformId === 'string';
};

/**
 * Проверка сети из выпуска мира или ответа сервера: форма, платформы, ссылки маршрутов
 * на остановки/платформы и число путей. Неверные данные отключают автобусы, а не ломают мир.
 */
export function validateBusNetwork(value: unknown): BusNetwork | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Partial<BusNetwork>;
  if (v.formatVersion !== 3 || !Array.isArray(v.stops) || !Array.isArray(v.routes)) return;
  const stopPlatforms = new Map<string, Set<string>>();
  const allPlatformIds = new Set<string>();
  for (const s of v.stops as unknown[]) {
    const stop = s as Partial<BusStop>;
    if (
      !stop ||
      typeof stop.id !== 'string' ||
      !ID.test(stop.id) ||
      stopPlatforms.has(stop.id) ||
      typeof stop.name !== 'string' ||
      !isPoint(stop.position) ||
      !Array.isArray(stop.platforms) ||
      stop.platforms.length === 0 ||
      !stop.platforms.every(isPlatform) ||
      !Array.isArray(stop.routes) ||
      !stop.routes.every((r) => typeof r === 'string') ||
      (stop.source !== 'osm' && stop.source !== 'interpolated')
    )
      return;
    const pSet = new Set<string>();
    for (const pl of stop.platforms) {
      if (allPlatformIds.has(pl.id)) return;
      allPlatformIds.add(pl.id);
      pSet.add(pl.id);
    }
    stopPlatforms.set(stop.id, pSet);
  }
  for (const r of v.routes as unknown[]) {
    const route = r as Partial<BusRoute>;
    if (
      !route ||
      typeof route.id !== 'string' ||
      !ID.test(route.id) ||
      typeof route.ref !== 'string' ||
      typeof route.name !== 'string' ||
      typeof route.from !== 'string' ||
      typeof route.to !== 'string' ||
      typeof route.circular !== 'boolean' ||
      !Array.isArray(route.directions) ||
      route.directions.length === 0
    )
      return;
    for (const d of route.directions as unknown[]) {
      const dir = d as Partial<BusRouteDirection>;
      if (
        !dir ||
        typeof dir.towards !== 'string' ||
        typeof dir.circular !== 'boolean' ||
        !Array.isArray(dir.sequence) ||
        !Array.isArray(dir.legs)
      )
        return;
      let worldStops = 0;
      for (const e of dir.sequence) {
        if (isRouteStopRef(e)) {
          if (!stopPlatforms.get(e.stopId)?.has(e.platformId)) return;
          worldStops++;
        } else if (
          !e ||
          typeof e !== 'object' ||
          !Array.isArray((e as { offWorld?: unknown }).offWorld) ||
          !(e as { offWorld: unknown[] }).offWorld.every((n) => typeof n === 'string')
        ) {
          return;
        }
      }
      if (
        dir.legs.length !== Math.max(0, worldStops - 1) ||
        !dir.legs.every(
          (leg) =>
            Array.isArray(leg) &&
            leg.every((piece) => Array.isArray(piece) && piece.every(isPoint)),
        )
      )
        return;
    }
  }
  return value as BusNetwork;
}

const refOrder = (a: string, b: string) =>
  Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b);

/** Только выбранные маршруты и остановки/платформы, где они останавливаются. */
export function selectBusNetwork(
  network: BusNetwork,
  refs: readonly string[] = BUS_ROUTES_IN_GAME,
): BusNetwork {
  const keep = new Set(refs);
  const routes = network.routes.filter((r) => keep.has(r.ref));
  const usedPlatforms = new Set<string>();
  for (const r of routes)
    for (const dir of r.directions)
      for (const e of dir.sequence) if ('platformId' in e) usedPlatforms.add(e.platformId);
  const stops = network.stops
    .map((s) => ({
      ...s,
      routes: s.routes.filter((r) => keep.has(r)),
      platforms: s.platforms.filter((p) => usedPlatforms.has(p.id)),
    }))
    .filter((s) => s.routes.length > 0 && s.platforms.length > 0);
  return { formatVersion: 3, stops, routes };
}

export interface BusTrip {
  routeId: string;
  ref: string;
  directionIndex: number;
  toStopId: string;
  toPlatformId: string;
  /** Остановок в пути, включая те, что за краем мира. */
  steps: number;
  /** Индексы в полном порядке остановок этого направления (`busStopOrder`). */
  from: number;
  to: number;
  /** Часть пути проходит за краем мира. */
  leaves: boolean;
  towards: string;
  /** Если встречное направление этого маршрута с соседней платформы того же узла быстрее. */
  fasterOpposite?: {
    platformId: string;
    steps: number;
    towards: string;
  };
}

/** Полный порядок остановок направления: `{ stopId, platformId }` или `null` за краем. */
export function busStopOrder(direction: BusRouteDirection): (BusRouteStopRef | null)[] {
  return direction.sequence.flatMap((e) => ('stopId' in e ? [e] : e.offWorld.map(() => null)));
}

const pointDist = (a: BusPoint, b: BusPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Находит узел и платформу по id платформы. */
export function busPlatformById(
  network: BusNetwork,
  platformId: string,
): { stop: BusStop; platform: BusPlatform } | undefined {
  for (const stop of network.stops) {
    const platform = stop.platforms.find((p) => p.id === platformId);
    if (platform) return { stop, platform };
  }
  return undefined;
}

/** Прямые шаги (без пересадок) вдоль всех направлений маршрута от конкретной платформы. */
function forwardTripsInDirection(
  route: BusRoute,
  directionIndex: number,
  fromStopId: string,
  fromPlatformId: string,
): BusTrip[] {
  const dir = route.directions[directionIndex]!;
  const order = busStopOrder(dir);
  const n = order.length;
  const first = dir.sequence[0];
  const last = dir.sequence.at(-1);
  const repeatedTerminal =
    n >= 2 &&
    first !== undefined &&
    last !== undefined &&
    (('platformId' in first && 'platformId' in last && first.platformId === last.platformId) ||
      ('offWorld' in first &&
        'offWorld' in last &&
        first.offWorld.length > 0 &&
        first.offWorld[0] === last.offWorld.at(-1)));
  const trips: BusTrip[] = [];
  order.forEach((entry, i) => {
    if (!entry || entry.platformId !== fromPlatformId) return;
    order.forEach((target, j) => {
      if (!target || target.platformId === fromPlatformId || target.stopId === fromStopId) return;
      let steps: number;
      let span: (BusRouteStopRef | null)[];
      if (j > i) {
        steps = j - i;
        span = order.slice(i, j);
      } else if (dir.circular) {
        const wrapBase = repeatedTerminal ? n - 1 : n;
        steps = wrapBase - i + j;
        span = [...order.slice(i), ...order.slice(repeatedTerminal ? 1 : 0, j)];
      } else {
        return;
      }
      trips.push({
        routeId: route.id,
        ref: route.ref,
        directionIndex,
        toStopId: target.stopId,
        toPlatformId: target.platformId,
        steps,
        from: i,
        to: j,
        leaves: span.some((s) => s === null),
        towards: dir.towards,
      });
    });
  });
  return trips;
}

/**
 * Куда можно уехать с конкретной платформы `fromPlatformId` без пересадки:
 * только по ходу направлений маршрутов, проходящих через эту платформу (или по кругу
 * для кольцевых направлений). Ключ результата — id остановки назначения.
 * Если на том же маршруте встречное направление с противоположной платформы этой
 * остановки довозит быстрее — заполняется `fasterOpposite`.
 */
export function busTripsFrom(network: BusNetwork, fromPlatformId: string): Map<string, BusTrip[]> {
  const origin = busPlatformById(network, fromPlatformId);
  const out = new Map<string, BusTrip[]>();
  if (!origin) return out;
  const siblingPlatforms = origin.stop.platforms.filter(
    (p) =>
      p.id !== fromPlatformId &&
      pointDist(p.position, origin.platform.position) <= BUS_PLATFORM_WALK_RANGE,
  );

  for (const route of network.routes) {
    const rawTrips: BusTrip[] = [];
    for (let d = 0; d < route.directions.length; d++) {
      rawTrips.push(...forwardTripsInDirection(route, d, origin.stop.id, fromPlatformId));
    }
    if (!rawTrips.length) continue;

    // Считаем кратчайшие варианты того же маршрута с соседних/встречных платформ узла
    const oppositeBest = new Map<string, { platformId: string; steps: number; towards: string }>();
    if (siblingPlatforms.length > 0 && route.directions.length > 0) {
      for (const altPlat of siblingPlatforms) {
        for (let d = 0; d < route.directions.length; d++) {
          for (const altTrip of forwardTripsInDirection(route, d, origin.stop.id, altPlat.id)) {
            const prev = oppositeBest.get(altTrip.toStopId);
            if (!prev || altTrip.steps < prev.steps) {
              oppositeBest.set(altTrip.toStopId, {
                platformId: altPlat.id,
                steps: altTrip.steps,
                towards: altTrip.towards,
              });
            }
          }
        }
      }
    }

    for (const trip of rawTrips) {
      const opp = oppositeBest.get(trip.toStopId);
      if (opp && opp.steps < trip.steps) trip.fasterOpposite = opp;

      const list = out.get(trip.toStopId) ?? [];
      const same = list.find((t) => t.ref === route.ref);
      if (same && same.steps <= trip.steps) continue;
      if (same) list.splice(list.indexOf(same), 1);
      list.push(trip);
      out.set(trip.toStopId, list);
    }
  }

  for (const list of out.values()) list.sort((a, b) => a.steps - b.steps || refOrder(a.ref, b.ref));
  return out;
}

/**
 * Прямые поездки до `toStopId` со встречных/соседних платформ той же остановки:
 * используется для подсказки игроку перейти на другую сторону улицы.
 */
export function busOppositePlatformTrips(
  network: BusNetwork,
  fromPlatformId: string,
  toStopId: string,
): { platform: BusPlatform; trips: BusTrip[] }[] {
  const origin = busPlatformById(network, fromPlatformId);
  if (!origin) return [];
  const results: { platform: BusPlatform; trips: BusTrip[] }[] = [];
  for (const alt of origin.stop.platforms) {
    if (
      alt.id === fromPlatformId ||
      pointDist(alt.position, origin.platform.position) > BUS_PLATFORM_WALK_RANGE
    )
      continue;
    const trips = busTripsFrom(network, alt.id).get(toStopId);
    if (trips?.length) results.push({ platform: alt, trips });
  }
  results.sort((a, b) => a.trips[0]!.steps - b.trips[0]!.steps);
  return results;
}

/** Кратчайшая цепочка остановок с пересадками от `fromPlatformId` до `toStopId` (если есть). */
export function busTransferPath(
  network: BusNetwork,
  fromPlatformId: string,
  toStopId: string,
): string[] | undefined {
  const origin = busPlatformById(network, fromPlatformId);
  if (!origin) return;
  const previousStop = new Map<string, string | null>([[origin.stop.id, null]]);
  const queue: { stopId: string; platformIds: string[] }[] = [
    { stopId: origin.stop.id, platformIds: [fromPlatformId] },
  ];
  const stopById = new Map(network.stops.map((s) => [s.id, s]));

  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.stopId === toStopId) break;
    for (const pid of cur.platformIds) {
      for (const [nextStopId, trips] of busTripsFrom(network, pid)) {
        if (previousStop.has(nextStopId)) continue;
        previousStop.set(nextStopId, cur.stopId);
        const arrivedPlatform = trips[0]!.toPlatformId;
        const nextStop = stopById.get(nextStopId);
        const arrivedObj = nextStop?.platforms.find((p) => p.id === arrivedPlatform);
        // На пересадочной остановке можно перейти между соседними платформами этого узла.
        const walkable =
          nextStop && arrivedObj
            ? nextStop.platforms
                .filter(
                  (p) => pointDist(p.position, arrivedObj.position) <= BUS_PLATFORM_WALK_RANGE,
                )
                .map((p) => p.id)
            : [arrivedPlatform];
        queue.push({ stopId: nextStopId, platformIds: walkable });
      }
    }
  }
  if (!previousStop.has(toStopId)) return;
  const path: string[] = [];
  for (let s: string | null = toStopId; s; s = previousStop.get(s) ?? null) path.unshift(s);
  return path;
}

/** Ближайшая платформа остановки не дальше `range` по горизонтали. */
export function busPlatformNear(
  network: BusNetwork,
  position: Pick<Vec3, 'x' | 'z'>,
  range: number,
): { stop: BusStop; platform: BusPlatform; distance: number } | undefined {
  let best: { stop: BusStop; platform: BusPlatform; distance: number } | undefined;
  for (const stop of network.stops) {
    for (const platform of stop.platforms) {
      const distance = Math.hypot(
        platform.position[0] - position.x,
        platform.position[1] - position.z,
      );
      if (distance <= range && (!best || distance < best.distance))
        best = { stop, platform, distance };
    }
  }
  return best;
}
