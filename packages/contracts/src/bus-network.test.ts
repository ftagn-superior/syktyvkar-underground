import { describe, expect, it } from 'vitest';
import {
  BUS_ROUTES_IN_GAME,
  busOppositePlatformTrips,
  busPlatformNear,
  busStopOrder,
  busTransferPath,
  busTripsFrom,
  parseBusTravelRequest,
  selectBusNetwork,
  validateBusNetwork,
  type BusNetwork,
  type BusPlatform,
  type BusRoute,
} from './bus-network.js';
import ringBlock from '../../../content/worlds/ring-block/bus-network/network.json';

const plat = (id: string, x: number, z = 5, sideHint?: string): BusPlatform => ({
  id,
  position: [x, z],
  ...(sideHint ? { sideHint } : {}),
  source: 'osm' as const,
});
const stop = (id: string, x: number, routes: string[], platforms: BusPlatform[]) => ({
  id,
  name: id.toUpperCase(),
  position: [x, 0] as [number, number],
  platforms,
  routes,
  source: 'osm' as const,
});
const ref = (stopId: string, platformId: string) => ({ stopId, platformId });
const dir = (
  towards: string,
  sequence: BusRoute['directions'][number]['sequence'],
  circular = false,
): BusRoute['directions'][number] => ({
  towards,
  circular,
  sequence,
  legs: [],
});

// 1: двусторонний (a ↔ b ↔ [за краем] ↔ c) на раздельных платформах.
// 2: кольцо (T → c → d → W → T), плюс встречный короткий рейс (c ↔ d) для проверки fasterOpposite.
// 3: односторонний участок (d → e).
const network: BusNetwork = {
  formatVersion: 3,
  stops: [
    stop('a', 0, ['1'], [plat('a-e', 0, 5, '→ C'), plat('a-w', 0, -5, 'конечная')]),
    stop('b', 100, ['1'], [plat('b-e', 100, 5, '→ C'), plat('b-w', 100, -5, '→ A')]),
    stop('c', 200, ['1', '2'], [plat('c-e', 200, 5, '→ D'), plat('c-w', 200, -5, '→ A')]),
    stop('d', 300, ['2', '3'], [plat('d-e', 300, 5), plat('d-w', 300, -5)]),
    stop('e', 400, ['3'], [plat('e-e', 400, 5)]),
  ],
  routes: [
    {
      id: '1',
      ref: '1',
      name: 'A — C',
      from: 'A',
      to: 'C',
      circular: false,
      directions: [
        dir('C', [ref('a', 'a-e'), ref('b', 'b-e'), { offWorld: ['X', 'Y'] }, ref('c', 'c-e')]),
        dir('A', [ref('c', 'c-w'), { offWorld: ['Y', 'X'] }, ref('b', 'b-w'), ref('a', 'a-w')]),
      ],
    },
    {
      id: '2',
      ref: '2',
      name: 'Кольцо',
      from: 'T',
      to: 'T',
      circular: true,
      directions: [
        dir(
          'по часовой',
          [{ offWorld: ['T'] }, ref('c', 'c-e'), ref('d', 'd-e'), { offWorld: ['W', 'T'] }],
          true,
        ),
        dir(
          'против часовой',
          [{ offWorld: ['T', 'W'] }, ref('d', 'd-w'), ref('c', 'c-w'), { offWorld: ['T'] }],
          true,
        ),
      ],
    },
    {
      id: '3',
      ref: '3',
      name: 'D — E',
      from: 'D',
      to: 'E',
      circular: false,
      directions: [dir('E', [ref('d', 'd-e'), ref('e', 'e-e')])],
    },
  ],
};

describe('bus trips v3', () => {
  it('does not collapse distinct off-world stops or different platforms at a loop seam', () => {
    const copy = structuredClone(network);
    copy.routes = [copy.routes[1]!];
    copy.routes[0]!.directions = [
      dir(
        'loop',
        [{ offWorld: ['X'] }, ref('c', 'c-e'), ref('d', 'd-e'), { offWorld: ['Y'] }],
        true,
      ),
    ];
    expect(busTripsFrom(copy, 'd-e').get('c')![0]!.steps).toBe(3);
    copy.routes[0]!.directions = [
      dir('loop', [ref('c', 'c-e'), ref('d', 'd-e'), ref('c', 'c-w')], true),
    ];
    expect(busTripsFrom(copy, 'c-w').get('d')![0]!.steps).toBe(2);
  });

  it('rides strictly forward per platform, handles opposite platforms and circular fasterOpposite', () => {
    expect(busStopOrder(network.routes[0]!.directions[0]!)).toEqual([
      ref('a', 'a-e'),
      ref('b', 'b-e'),
      null,
      null,
      ref('c', 'c-e'),
    ]);

    // С платформы в сторону C можно уехать только в C (не назад в A).
    const fromBE = busTripsFrom(network, 'b-e');
    expect([...fromBE.keys()]).toEqual(['c']);
    expect(fromBE.get('c')![0]).toMatchObject({
      ref: '1',
      steps: 3,
      directionIndex: 0,
      toPlatformId: 'c-e',
      leaves: true,
    });

    // Со встречной платформы — только в A.
    const fromBW = busTripsFrom(network, 'b-w');
    expect([...fromBW.keys()]).toEqual(['a']);
    expect(fromBW.get('a')![0]).toMatchObject({
      ref: '1',
      steps: 1,
      directionIndex: 1,
      toPlatformId: 'a-w',
      towards: 'A',
    });

    // Подсказка о встречной стороне остановки.
    expect(busOppositePlatformTrips(network, 'b-e', 'a')).toMatchObject([
      { platform: { id: 'b-w' }, trips: [{ ref: '1', toStopId: 'a', toPlatformId: 'a-w' }] },
    ]);

    // Кольцо: с d-e до c по длинной дуге через W и T (3 остановки), быстрее — с d-w (1 остановка).
    expect(busTripsFrom(network, 'd-e').get('c')![0]).toMatchObject({
      ref: '2',
      steps: 3,
      leaves: true,
      fasterOpposite: { platformId: 'd-w', steps: 1, towards: 'против часовой' },
    });

    // Конечная только на высадку (e-e): отправлений нет.
    expect(busTripsFrom(network, 'e-e').size).toBe(0);
  });

  it('finds the shortest chain of buses with sibling-platform transfers at intermediate stops', () => {
    expect(busTransferPath(network, 'a-e', 'e')).toEqual(['a', 'c', 'd', 'e']);
    expect(busTransferPath(network, 'e-e', 'a')).toBeUndefined();
  });

  it('finds the nearest platform a player stands at', () => {
    expect(busPlatformNear(network, { x: 101, z: 4 }, 6)).toMatchObject({
      stop: { id: 'b' },
      platform: { id: 'b-e' },
    });
    expect(busPlatformNear(network, { x: 101, z: -4 }, 6)).toMatchObject({
      stop: { id: 'b' },
      platform: { id: 'b-w' },
    });
    expect(busPlatformNear(network, { x: 150, z: 0 }, 6)).toBeUndefined();
  });

  it('keeps only the chosen routes and the stops/platforms they serve', () => {
    const only = selectBusNetwork(network, ['3']);
    expect(only.routes.map((r) => r.ref)).toEqual(['3']);
    expect(only.stops.map((s) => [s.id, s.routes])).toEqual([
      ['d', ['3']],
      ['e', ['3']],
    ]);
    expect(only.stops[0]!.platforms.map((p) => p.id)).toEqual(['d-e']);
  });

  it('accepts only exact, bounded v3 travel requests', () => {
    const ok = {
      requestId: 4,
      worldEpoch: 'w',
      fromPlatformId: 'osm-2165055372',
      toPlatformId: 'osm-6533272746',
      routeId: '17m',
      directionIndex: 1,
    };
    expect(parseBusTravelRequest(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, requestId: 1.5 },
      { ...ok, directionIndex: -1 },
      { ...ok, directionIndex: 1.5 },
      { ...ok, toPlatformId: '../x' },
      { ...ok, fromPlatformId: 'a'.repeat(81) },
      [ok],
      null,
    ])
      expect(parseBusTravelRequest(bad)).toBeUndefined();
  });
});

describe('ring-block bus network in game', () => {
  const full = validateBusNetwork(ringBlock)!;
  const live = selectBusNetwork(full);

  it('passes validation and carries exactly the chosen routes', () => {
    expect(full).toBeDefined();
    expect(live.routes.map((r) => r.ref).sort()).toEqual([...BUS_ROUTES_IN_GAME].sort());
  });

  it('distinguishes SGU Oktyabrsky 55 southbound platform from northbound platform', () => {
    const fromSguSouth = busTripsFrom(live, 'osm-2165055372');
    expect(fromSguSouth.has('poliklinika-3')).toBe(true);
    expect(fromSguSouth.has('pedkolledzh')).toBe(true);
    // В сторону Рынка / Бани №4 с южной платформы ехать нельзя — только со встречной.
    expect(fromSguSouth.has('banya-4')).toBe(false);
    expect(busOppositePlatformTrips(live, 'osm-2165055372', 'banya-4')).toMatchObject([
      { platform: { id: 'osm-1391361123' } },
    ]);
  });

  it('rejects broken networks instead of trusting them', () => {
    const copy = () => structuredClone(ringBlock) as unknown as BusNetwork;
    const unknownStop = copy();
    unknownStop.routes[0]!.directions[0]!.sequence[0] = {
      stopId: 'nowhere',
      platformId: 'osm-1',
    };
    const missingLeg = copy();
    missingLeg.routes.find((r) => r.directions[0]!.legs.length)!.directions[0]!.legs.pop();
    const badPoint = copy();
    badPoint.stops[0]!.position = [Number.NaN, 0];
    for (const broken of [unknownStop, missingLeg, badPoint, { formatVersion: 2 }, null])
      expect(validateBusNetwork(broken)).toBeUndefined();
  });

  it('lets every stop leave and reach every stop that has an inbound route in the live network', () => {
    const inbound = new Set<string>();
    for (const s of live.stops) {
      let outbound = false;
      for (const p of s.platforms) {
        const trips = busTripsFrom(live, p.id);
        if (trips.size > 0) outbound = true;
        for (const toId of trips.keys()) inbound.add(toId);
      }
      expect(outbound, s.id).toBe(true);
    }
    const ids = live.stops.map((s) => s.id);
    const targets = ids.filter((id) => inbound.has(id));
    expect(targets.length).toBeGreaterThanOrEqual(ids.length - 2);
    const unreachable = ids.flatMap((from) => {
      const startPlatforms = live.stops
        .find((s) => s.id === from)!
        .platforms.filter((p) => busTripsFrom(live, p.id).size > 0);
      return targets
        .filter((to) => to !== from && !startPlatforms.some((p) => busTransferPath(live, p.id, to)))
        .map((to) => `${from}→${to}`);
    });
    expect(unreachable).toEqual([]);
  });
});
