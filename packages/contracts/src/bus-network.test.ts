import { describe, expect, it } from 'vitest';
import {
  BUS_ROUTES_IN_GAME,
  busStopNear,
  busStopOrder,
  busTransferPath,
  busTripsFrom,
  parseBusTravelRequest,
  selectBusNetwork,
  validateBusNetwork,
  type BusNetwork,
  type BusRoute,
} from './bus-network.js';
import ringBlock from '../../../content/worlds/ring-block/bus-network/network.json';

const stop = (id: string, x: number, routes: string[]) => ({
  id,
  name: id.toUpperCase(),
  position: [x, 0] as [number, number],
  platforms: [[x, 5] as [number, number]],
  routes,
  source: 'osm' as const,
});
const route = (ref: string, sequence: BusRoute['sequence'], extra: Partial<BusRoute> = {}) => ({
  id: ref,
  ref,
  name: ref,
  from: 'A',
  to: 'Z',
  circular: false,
  twoWay: true,
  sequence,
  legs: [],
  ...extra,
});
// 1: a → b → (за краем) → c, обе стороны. 2: кольцо T → c → d → W → T. 3: только d → e.
const network: BusNetwork = {
  formatVersion: 2,
  stops: [
    stop('a', 0, ['1']),
    stop('b', 100, ['1']),
    stop('c', 200, ['1', '2']),
    stop('d', 300, ['2', '3']),
    stop('e', 400, ['3']),
  ],
  routes: [
    route('1', ['a', 'b', { offWorld: ['X', 'Y'] }, 'c']),
    // Как у «Транспорт 11»: конечная T и в начале, и в конце кольца.
    route('2', [{ offWorld: ['T'] }, 'c', 'd', { offWorld: ['W', 'T'] }], {
      circular: true,
      twoWay: false,
    }),
    route('3', ['d', 'e'], { twoWay: false }),
  ],
};

describe('bus trips', () => {
  it('rides forward, back on two-way routes, and round circular ones', () => {
    expect(busStopOrder(network.routes[0]!)).toEqual(['a', 'b', null, null, 'c']);
    const fromB = busTripsFrom(network, 'b');
    expect([...fromB.keys()].sort()).toEqual(['a', 'c']);
    expect(fromB.get('c')![0]).toMatchObject({ ref: '1', steps: 3, direction: 1, leaves: true });
    expect(fromB.get('a')![0]).toMatchObject({ ref: '1', steps: 1, direction: -1, towards: 'A' });
    // Кольцо: из d до c — по кругу через W и конечную T, которая считается один раз.
    expect(busTripsFrom(network, 'd').get('c')![0]).toMatchObject({
      ref: '2',
      steps: 3,
      leaves: true,
    });
    // Маршрут 3 известен только в одну сторону: из e назад не уехать.
    expect(busTripsFrom(network, 'e').size).toBe(0);
  });

  it('finds the shortest chain of buses when there is no direct one', () => {
    expect(busTransferPath(network, 'a', 'e')).toEqual(['a', 'c', 'd', 'e']);
    expect(busTransferPath(network, 'e', 'a')).toBeUndefined();
  });

  it('finds the stop a player stands at by any platform', () => {
    expect(busStopNear(network, { x: 101, z: 4 }, 6)).toMatchObject({ stop: { id: 'b' } });
    expect(busStopNear(network, { x: 150, z: 0 }, 6)).toBeUndefined();
  });

  it('keeps only the chosen routes and the stops they serve', () => {
    const only = selectBusNetwork(network, ['3']);
    expect(only.routes.map((r) => r.ref)).toEqual(['3']);
    expect(only.stops.map((s) => [s.id, s.routes])).toEqual([
      ['d', ['3']],
      ['e', ['3']],
    ]);
  });

  it('accepts only exact, bounded travel requests', () => {
    const ok = { requestId: 4, worldEpoch: 'w', fromStopId: 'rynok', toStopId: 'sgu' };
    expect(parseBusTravelRequest(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, requestId: 1.5 },
      { ...ok, toStopId: '../x' },
      { ...ok, fromStopId: 'a'.repeat(81) },
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

  it('rejects broken networks instead of trusting them', () => {
    const copy = () => structuredClone(ringBlock) as unknown as BusNetwork;
    const unknownStop = copy();
    unknownStop.routes[0]!.sequence[0] = 'nowhere';
    const missingLeg = copy();
    missingLeg.routes.find((r) => r.legs.length)!.legs.pop();
    const badPoint = copy();
    badPoint.stops[0]!.position = [Number.NaN, 0];
    for (const broken of [unknownStop, missingLeg, badPoint, { formatVersion: 1 }, null])
      expect(validateBusNetwork(broken)).toBeUndefined();
  });

  it('lets every stop reach another stop and every pair connect with transfers', () => {
    for (const s of live.stops) expect(busTripsFrom(live, s.id).size, s.id).toBeGreaterThan(0);
    const ids = live.stops.map((s) => s.id);
    const unreachable = ids.flatMap((from) =>
      ids
        .filter((to) => to !== from && !busTransferPath(live, from, to))
        .map((to) => `${from}→${to}`),
    );
    expect(unreachable).toEqual([]);
  });
});
