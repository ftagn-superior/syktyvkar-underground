import { describe, expect, it } from 'vitest';
import {
  toLatLon,
  type OsmSettings,
  type OsmSnapshot,
} from '../../tools/world-build/src/fetch-osm.js';
import { roadMarkings, trafficSignals } from '../../tools/world-build/src/road-markings.js';
import type { Point2 } from '../../tools/world-build/src/triangulate.js';

const settings: OsmSettings = {
  snapshot: 'unused.json',
  origin: { lat: 61.66386729706631, lon: 50.815951774241576 },
  metersPerDegree: { lon: 52837.29, lat: 110573.15 },
  fetchMargin: 0,
};
const at = (x: number, z: number) => toLatLon(settings, x, -z);
const snapshot = (elements: OsmSnapshot['elements']): OsmSnapshot => ({
  formatVersion: 1,
  license: 'test',
  source: 'test',
  fetchedAt: '2026-11-12',
  bbox: { south: 0, west: 0, north: 0, east: 0 },
  elements,
});
/** Прямая дорога вдоль оси X от −100 до 100 и асфальт шириной `width`. */
const straight = (
  tags: Record<string, string>,
  width: number,
  extra: OsmSnapshot['elements'] = [],
) => ({
  settings,
  snapshot: snapshot([
    {
      type: 'way',
      id: 1,
      tags: { highway: 'primary', ...tags },
      nodes: [10, 11, 12],
      geometry: [at(-100, 0), at(0, 0), at(100, 0)],
    },
    ...extra,
  ]),
  roads: [
    [
      [-110, -width / 2],
      [110, -width / 2],
      [110, width / 2],
      [-110, width / 2],
    ] as Point2[],
  ],
});
const centreOf = (polygon: Point2[][]) => {
  const ring = polygon[0];
  return [ring.reduce((s, p) => s + p[0], 0) / 4, ring.reduce((s, p) => s + p[1], 0) / 4];
};

describe('разметка дорог', () => {
  it('шесть полос в OSM, но на асфальте шириной 11 м помещаются только четыре', () => {
    const { polygons } = roadMarkings(straight({ lanes: '6' }, 11));
    const offsets = new Set(polygons.map((p) => Math.round(centreOf(p)[1] * 100) / 100));
    // Двойная сплошная ±0,12 м и по одной прерывистой на каждую сторону (полоса 2,75 м).
    expect([...offsets].sort((a, b) => a - b)).toEqual([-2.75, -0.12, 0.12, 2.75]);
  });

  it('узкая двухполосная дорога получает прерывистую осевую', () => {
    const { polygons } = roadMarkings(straight({ lanes: '2' }, 7));
    const offsets = new Set(polygons.map((p) => Math.round(centreOf(p)[1] * 100) / 100));
    expect([...offsets]).toEqual([0]);
    // Штрих 4 м, разрыв 4 м: на 200 м около 25 штрихов.
    expect(polygons.length).toBeGreaterThan(20);
  });

  it('на переходе — «зебра» во всю ширину, линии к ней не подходят', () => {
    const { polygons, stats } = roadMarkings(
      straight({ lanes: '2' }, 7, [
        {
          type: 'node',
          id: 11,
          tags: { highway: 'crossing', crossing: 'uncontrolled', 'crossing:markings': 'zebra' },
          point: at(0, 0),
        },
      ]),
    );
    expect(stats.crosswalks).toBe(1);
    const stripes = polygons.filter((p) => {
      const r = p[0];
      return Math.hypot(r[1][0] - r[0][0], r[1][1] - r[0][1]) === 3;
    });
    expect(stripes.length).toBeGreaterThanOrEqual(5);
    const lines = polygons.filter((p) => !stripes.includes(p));
    expect(lines.every((p) => Math.abs(centreOf(p)[0]) > 3.5)).toBe(true);
  });

  it('служебные проезды и жилые улицы не размечаются', () => {
    const { polygons } = roadMarkings(straight({ highway: 'service' }, 6));
    expect(polygons).toHaveLength(0);
  });
});

describe('светофоры', () => {
  it('на каждом подъезде светофор справа по ходу и смотрит на водителей', () => {
    const spots = trafficSignals(
      straight({ lanes: '2' }, 7, [
        { type: 'node', id: 11, tags: { highway: 'traffic_signals' }, point: at(0, 0) },
      ]),
    );
    expect(spots).toHaveLength(2);
    for (const spot of spots) {
      // Подъезд с запада (машины едут на восток) — светофор южнее оси, то есть справа.
      const fromWest = spot.facing[0] < 0;
      expect(Math.sign(spot.position[1])).toBe(fromWest ? 1 : -1);
      expect(Math.abs(spot.position[1])).toBeGreaterThan(3.5);
    }
  });

  it('на односторонней улице светофор только для разрешённого направления', () => {
    const spots = trafficSignals(
      straight({ lanes: '2', oneway: 'yes' }, 7, [
        { type: 'node', id: 11, tags: { highway: 'traffic_signals' }, point: at(0, 0) },
      ]),
    );
    expect(spots).toHaveLength(1);
    expect(spots[0].facing[0]).toBeLessThan(0);
  });
});
