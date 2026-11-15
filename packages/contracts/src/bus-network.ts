/**
 * Автобусы как быстрые поездки: игрок у остановки может уехать только туда, куда
 * действительно идёт автобус с этой остановки. Сеть строит
 * `tools/world-build/src/bus-network.ts` в `content/worlds/ring-block/bus-network/`.
 * Правила здесь общие: клиент по ним рисует карту, сервер — проверяет поездку.
 */
import type { Vec3 } from './simulation.js';

export type BusPoint = [number, number];
export interface BusStop {
  id: string;
  name: string;
  /** Мировые X/Z, м. */
  position: BusPoint;
  platforms: BusPoint[];
  routes: string[];
  /** `interpolated` — места нет в OSM, остановка поставлена на путь автобуса. */
  source: 'osm' | 'interpolated';
}
export type BusSequenceEntry = string | { offWorld: string[] };
export interface BusRoute {
  id: string;
  ref: string;
  name: string;
  from: string;
  to: string;
  circular: boolean;
  twoWay: boolean;
  transport11?: string;
  sequence: BusSequenceEntry[];
  /** Путь по улицам между соседними остановками мира: куски ломаной X/Z. */
  legs: BusPoint[][][];
}
export interface BusNetwork {
  formatVersion: 2;
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
/** Подсказка «Автобусы» у остановки, м по горизонтали от платформы. */
export const BUS_STOP_PROMPT_RANGE = 6;
/** Сервер принимает поездку чуть дальше подсказки: задержка позиции и ширина остановки. */
export const BUS_STOP_SERVER_RANGE = 10;

export interface BusTravelRequest {
  requestId: number;
  worldEpoch: string;
  fromStopId: string;
  toStopId: string;
}
export function parseBusTravelRequest(value: unknown): BusTravelRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'fromStopId,requestId,toStopId,worldEpoch' ||
    !Number.isSafeInteger(v.requestId) ||
    typeof v.worldEpoch !== 'string' ||
    !['fromStopId', 'toStopId'].every(
      (key) => typeof v[key] === 'string' && /^[a-z0-9-]{1,80}$/.test(v[key] as string),
    )
  )
    return;
  return v as unknown as BusTravelRequest;
}

const isPoint = (p: unknown): p is BusPoint =>
  Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v));
const ID = /^[a-z0-9-]{1,80}$/;

/**
 * Проверка сети из выпуска мира или ответа сервера: форма, ссылки маршрутов на остановки
 * и число путей. Неверные данные отключают автобусы, а не ломают мир.
 */
export function validateBusNetwork(value: unknown): BusNetwork | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Partial<BusNetwork>;
  if (v.formatVersion !== 2 || !Array.isArray(v.stops) || !Array.isArray(v.routes)) return;
  const ids = new Set<string>();
  for (const s of v.stops as unknown[]) {
    const stop = s as Partial<BusStop>;
    if (
      !stop ||
      typeof stop.id !== 'string' ||
      !ID.test(stop.id) ||
      ids.has(stop.id) ||
      typeof stop.name !== 'string' ||
      !isPoint(stop.position) ||
      !Array.isArray(stop.platforms) ||
      !stop.platforms.every(isPoint) ||
      !Array.isArray(stop.routes) ||
      !stop.routes.every((r) => typeof r === 'string') ||
      (stop.source !== 'osm' && stop.source !== 'interpolated')
    )
      return;
    ids.add(stop.id);
  }
  for (const r of v.routes as unknown[]) {
    const route = r as Partial<BusRoute>;
    if (
      !route ||
      typeof route.ref !== 'string' ||
      typeof route.name !== 'string' ||
      typeof route.from !== 'string' ||
      typeof route.to !== 'string' ||
      typeof route.circular !== 'boolean' ||
      typeof route.twoWay !== 'boolean' ||
      !Array.isArray(route.sequence) ||
      !Array.isArray(route.legs)
    )
      return;
    let worldStops = 0;
    for (const e of route.sequence) {
      if (typeof e === 'string') {
        if (!ids.has(e)) return;
        worldStops++;
      } else if (
        !e ||
        !Array.isArray(e.offWorld) ||
        !e.offWorld.every((n: unknown) => typeof n === 'string')
      )
        return;
    }
    if (
      route.legs.length !== Math.max(0, worldStops - 1) ||
      !route.legs.every(
        (leg) =>
          Array.isArray(leg) && leg.every((piece) => Array.isArray(piece) && piece.every(isPoint)),
      )
    )
      return;
  }
  return value as BusNetwork;
}

const refOrder = (a: string, b: string) =>
  Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b);

/** Только выбранные маршруты и остановки, где они останавливаются. */
export function selectBusNetwork(
  network: BusNetwork,
  refs: readonly string[] = BUS_ROUTES_IN_GAME,
): BusNetwork {
  const keep = new Set(refs);
  const routes = network.routes.filter((r) => keep.has(r.ref));
  const stops = network.stops
    .map((s) => ({ ...s, routes: s.routes.filter((r) => keep.has(r)) }))
    .filter((s) => s.routes.length > 0);
  return { formatVersion: 2, stops, routes };
}

export interface BusTrip {
  ref: string;
  /** Остановок в пути, включая те, что за краем мира. */
  steps: number;
  /** 1 — по ходу варианта, −1 — обратно (`twoWay`). */
  direction: 1 | -1;
  /** Индексы в полном порядке остановок варианта (`busStopOrder`). */
  from: number;
  to: number;
  /** Часть пути проходит за краем мира. */
  leaves: boolean;
  towards: string;
}

/** Полный порядок остановок: id остановки мира или null для каждой остановки за краем. */
export function busStopOrder(route: BusRoute): (string | null)[] {
  return route.sequence.flatMap((e) => (typeof e === 'string' ? [e] : e.offWorld.map(() => null)));
}

/**
 * Куда можно уехать с остановки без пересадки: по ходу маршрута, по кругу для кольцевых
 * и обратно для маршрутов с одним известным направлением. Для каждой цели — по одному
 * лучшему варианту на маршрут, ближайшие первыми.
 */
export function busTripsFrom(network: BusNetwork, fromId: string): Map<string, BusTrip[]> {
  const out = new Map<string, BusTrip[]>();
  for (const route of network.routes) {
    const order = busStopOrder(route);
    const n = order.length;
    order.forEach((stop, i) => {
      if (stop !== fromId) return;
      order.forEach((target, j) => {
        if (!target || target === fromId) return;
        let steps: number;
        let direction: 1 | -1;
        if (j > i) [steps, direction] = [j - i, 1];
        else if (route.circular) [steps, direction] = [n - 1 - i + j, 1];
        else if (route.twoWay) [steps, direction] = [i - j, -1];
        else return;
        const span =
          direction < 0
            ? order.slice(j, i)
            : j > i
              ? order.slice(i, j)
              : [...order.slice(i), ...order.slice(0, j)];
        const list = out.get(target) ?? [];
        const same = list.find((t) => t.ref === route.ref);
        if (same && same.steps <= steps) return;
        if (same) list.splice(list.indexOf(same), 1);
        list.push({
          ref: route.ref,
          steps,
          direction,
          from: i,
          to: j,
          leaves: span.some((s) => s === null),
          towards: direction > 0 ? route.to : route.from,
        });
        out.set(target, list);
      });
    });
  }
  for (const list of out.values()) list.sort((a, b) => a.steps - b.steps || refOrder(a.ref, b.ref));
  return out;
}

/** Кратчайшая цепочка остановок с пересадками (включая начало и конец), если она есть. */
export function busTransferPath(
  network: BusNetwork,
  from: string,
  to: string,
): string[] | undefined {
  const previous = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const stop = queue.shift()!;
    if (stop === to) break;
    for (const next of busTripsFrom(network, stop).keys())
      if (!previous.has(next)) {
        previous.set(next, stop);
        queue.push(next);
      }
  }
  if (!previous.has(to)) return;
  const path: string[] = [];
  for (let s: string | null = to; s; s = previous.get(s) ?? null) path.unshift(s);
  return path;
}

/** Ближайшая остановка, у которой платформа или центр не дальше `range` по горизонтали. */
export function busStopNear(
  network: BusNetwork,
  position: Pick<Vec3, 'x' | 'z'>,
  range: number,
): { stop: BusStop; distance: number; platform: BusPoint } | undefined {
  let best: { stop: BusStop; distance: number; platform: BusPoint } | undefined;
  for (const stop of network.stops)
    for (const platform of [stop.position, ...stop.platforms]) {
      const distance = Math.hypot(platform[0] - position.x, platform[1] - position.z);
      if (distance <= range && (!best || distance < best.distance))
        best = { stop, distance, platform };
    }
  return best;
}
