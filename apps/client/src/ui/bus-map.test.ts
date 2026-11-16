import { describe, expect, it } from 'vitest';
import type { BusNetwork, BusRoute } from '@su/contracts';
import { BusStopSource } from '../interaction/bus-stops';
import { LineBundles } from './bus-map';

const route = (ref: string, piece: [number, number][]): BusRoute => ({
  id: ref,
  ref,
  name: `Маршрут ${ref}`,
  from: 'СГУ',
  to: 'Рынок',
  circular: false,
  directions: [
    {
      towards: 'Конечная',
      circular: false,
      sequence: [
        { stopId: 'a', platformId: 'p-a' },
        { stopId: 'b', platformId: 'p-b' },
      ],
      legs: [[piece]],
    },
  ],
});

const network: BusNetwork = {
  formatVersion: 3,
  stops: [
    {
      id: 'a',
      name: 'СГУ',
      position: [0, 0],
      routes: ['1', '4', '17М', '54М', '174'],
      platforms: [
        { id: 'p-a', position: [0, 10], sideHint: '→ Поликлиника №3', source: 'osm' },
        { id: 'p-a-opp', position: [0, -10], sideHint: '→ Рынок', source: 'osm' },
      ],
      source: 'osm',
    },
    {
      id: 'b',
      name: 'Рынок',
      position: [100, 0],
      routes: ['1', '4', '17М', '54М', '174'],
      platforms: [{ id: 'p-b', position: [100, 10], source: 'osm' }],
      source: 'osm',
    },
  ],
  routes: [
    route('1', [
      [8, 0],
      [10, 0],
      [102, 0],
    ]),
    route('4', [
      [8, 0],
      [10, 0],
      [102, 0],
    ]),
    route('17М', [
      [8, 0],
      [10, 0],
      [102, 0],
    ]),
    route('54М', [
      [8, 0],
      [10, 0],
      [102, 0],
    ]),
    route('174', [
      [8, 0],
      [10, 0],
      [102, 0],
    ]),
  ],
};

describe('LineBundles alignment and bundling', () => {
  it('draws shared reverse segments once across differently split direction legs', () => {
    const r = route('17М', [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ]);
    r.directions.push({
      ...r.directions[0]!,
      legs: [
        [
          [
            [30, 0],
            [20, 0],
          ],
        ],
        [
          [
            [20, 0],
            [10, 0],
            [0, 0],
            [-10, 0],
          ],
        ],
      ],
    });
    const bundles = new LineBundles({ ...network, routes: [r] });
    expect(bundles.paths(r, 20, bundles.slotsFor([r]))).toEqual([
      [
        [0, 0],
        [10, 0],
        [20, 0],
        [30, 0],
      ],
      [
        [0, 0],
        [-10, 0],
      ],
    ]);
  });

  it('bundles only visible routes so hidden routes do not push an active route off-road', () => {
    const bundles = new LineBundles(network);
    const activeOnlySlots = bundles.slotsFor([network.routes[2]!]);
    const pts = bundles.offset(
      [
        [8, 0],
        [10, 0],
        [102, 0],
      ],
      '17М',
      18,
      activeOnlySlots,
    );
    for (const [, z] of pts) expect(Math.abs(z)).toBeLessThan(1e-6);
  });

  it('does not flip normals across string comparison boundaries (9 -> 10 -> 102) and bounds spread', () => {
    const bundles = new LineBundles(network);
    const slots = bundles.slotsFor(network.routes);
    // Даже при крупном экранном spacing на 5 маршрутах сдвиг не выходит за полотно улицы (<= 6.5 м).
    const pts1 = bundles.offset(
      [
        [8, 0],
        [10, 0],
        [102, 0],
      ],
      '1',
      20,
      slots,
    );
    const pts174 = bundles.offset(
      [
        [8, 0],
        [10, 0],
        [102, 0],
      ],
      '174',
      20,
      slots,
    );
    // Нормали всех вершин одного маршрута направлены в одну сторону (без зигзага 8->10->102).
    const zSigns = pts1.map(([, z]) => Math.sign(z));
    expect(new Set(zSigns).size).toBe(1);
    for (const [, z] of [...pts1, ...pts174]) expect(Math.abs(z)).toBeLessThanOrEqual(6.51);
  });
});

describe('BusStopSource platforms', () => {
  it('creates one interactable per platform with exact platform id and sideHint', () => {
    const opened: string[] = [];
    const source = new BusStopSource(
      () => network,
      (platformId) => opened.push(platformId),
    );
    const items = [...source.candidates({ x: 0, y: 0, z: 9 })];
    expect(items.map((i) => i.id)).toContain('bus-stop:p-a');
    expect(items.map((i) => i.id)).toContain('bus-stop:p-a-opp');
    const platA = items.find((i) => i.id === 'bus-stop:p-a')!;
    expect(platA.key).toBe('Space');
    expect(platA.keyLabel).toBe('Пробел');
    const platOpp = items.find((i) => i.id === 'bus-stop:p-a-opp')!;
    expect(platA.objectName).toBe('Остановка «СГУ» (→ Поликлиника №3)');
    expect(platA.getDistance({ x: 0, y: 0, z: 9 })).toBeCloseTo(1, 3);
    expect(platOpp.getDistance({ x: 0, y: 0, z: 9 })).toBeCloseTo(19, 3);
    platA.onActivate({ x: 0, y: 0, z: 9 });
    platOpp.onActivate({ x: 0, y: 0, z: 9 });
    expect(opened).toEqual(['p-a', 'p-a-opp']);
  });
});
