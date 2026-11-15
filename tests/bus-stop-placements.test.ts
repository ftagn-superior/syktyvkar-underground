import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  convexOverlap,
  PAVILION_ASSETS,
  planBusStopPlacements,
  stopEntityId,
  type AssetGeometry,
  type StopPlacementInput,
} from '../tools/world-build/src/bus-stop-placements.js';

type BusNetwork = StopPlacementInput['network'];
type StaticObjectInstance = StopPlacementInput['instances'][number];

const release = JSON.parse(
  readFileSync('content/worlds/ring-block/terrain-release.json', 'utf8'),
) as {
  groundTerrain: Required<Pick<StopPlacementInput['terrain'], 'supports' | 'placementModels'>>;
};
const pavilions = new Set<string>(PAVILION_ASSETS);
const terrain: StopPlacementInput['terrain'] = {
  grid: {
    formatVersion: 1,
    origin: { x: -120, z: -120 },
    spacing: 20,
    columns: 13,
    rows: 13,
    bottom: -10,
    heights: new Array(169).fill(0),
  },
  supports: release.groundTerrain.supports.filter((s) => pavilions.has(s.assetId)),
  placementModels: release.groundTerrain.placementModels.filter((m) => pavilions.has(m.assetId)),
};
const rect = (minX: number, minZ: number, maxX: number, maxZ: number): AssetGeometry => ({
  bounds: { minX, minZ, maxX, maxZ },
  footprints: [
    [
      [minX, minZ],
      [maxX, minZ],
      [maxX, maxZ],
      [minX, maxZ],
    ],
  ],
});
const assets = new Map<string, AssetGeometry>([
  ...PAVILION_ASSETS.map((id) => [id, rect(-1.8, -0.1, 2.7, 1.5)] as const),
  ['crate', rect(-1, -1, 1, 1)],
]);
const stop = (id: string, platform: [number, number], source: 'osm' | 'interpolated' = 'osm') => ({
  id,
  name: id,
  position: platform,
  platforms: [{ id: `${id}-p1`, position: platform, source }],
  routes: ['1'],
  source,
});
// Дорога 8 м вдоль X, автобус по оси на восток. Юг — +Z.
const network: BusNetwork = {
  formatVersion: 3,
  stops: [
    stop('curb', [0, 5.5]),
    stop('on-road', [40, 3]),
    stop('north', [-40, -6]),
    stop('blocked', [80, 6]),
    stop('served', [-80, 6]),
    stop('guess', [60, 0], 'interpolated'),
    stop('outside', [20, 119]),
  ],
  routes: [
    {
      id: '1',
      ref: '1',
      name: '1',
      from: 'a',
      to: 'b',
      circular: false,
      directions: [
        {
          towards: 'b',
          circular: false,
          sequence: [{ stopId: 'curb', platformId: 'curb-p1' }],
          legs: [
            [
              [
                [-100, 0],
                [100, 0],
              ],
            ],
          ],
        },
      ],
    },
  ],
};
const instance = (
  entityId: string,
  assetId: string,
  x: number,
  z: number,
): StaticObjectInstance => ({
  entityId,
  assetId,
  position: { x, y: 0, z },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  enabled: true,
  instanceRevision: 1,
});
const input = (instances: StaticObjectInstance[]): StopPlacementInput => ({
  network,
  ground: [
    {
      id: 'road',
      polygons: [
        [
          [
            [-100, -4],
            [100, -4],
            [100, 4],
            [-100, 4],
          ],
        ],
      ],
    },
  ],
  instances,
  assets,
  terrain,
  bounds: { minX: -120, minZ: -120, maxX: 120, maxZ: 120 },
});
const base = [
  instance('crate-1', 'crate', 80, 6.5),
  instance('old-stop', PAVILION_ASSETS[0], -79, 6),
];
const rows = planBusStopPlacements(input(base));
const row = (id: string) => rows.find((r) => r.stopId === id)!;
const back = (i: StaticObjectInstance) => {
  const yaw = 2 * Math.atan2(i.rotation.y, i.rotation.w);
  return [Math.sin(yaw), Math.cos(yaw)];
};

describe('bus stop pavilions', () => {
  it('keeps a curb platform in place, back to the road, on its foundation', () => {
    const r = row('curb');
    expect(r.status).toBe('placed');
    expect(r.entityId).toBe(stopEntityId('curb', 0));
    expect(r.shift).toBe(0);
    expect(back(r.instance!)[1]).toBeCloseTo(1);
    expect(r.instance!.position.y).toBeGreaterThan(0);
    expect(r.foundation).toBeLessThanOrEqual(0.6);
  });

  it('moves a platform off the carriageway within prompt range', () => {
    const r = row('on-road');
    expect(r.status).toBe('placed');
    expect(r.instance!.position.z).toBeGreaterThanOrEqual(4.4);
    expect(r.shift).toBeLessThanOrEqual(4);
  });

  it('faces the road from the other side too', () => {
    expect(back(row('north').instance!)[1]).toBeCloseTo(-1);
  });

  it('steps around other objects', () => {
    const r = row('blocked');
    expect(r.status).toBe('placed');
    const footprint = (i: StaticObjectInstance, g: AssetGeometry) => {
      const yaw = 2 * Math.atan2(i.rotation.y, i.rotation.w);
      const c = Math.cos(yaw),
        s = Math.sin(yaw);
      return g.footprints[0].map(
        ([x, z]) =>
          [i.position.x + c * x + s * z, i.position.z - s * x + c * z] as [number, number],
      );
    };
    expect(
      convexOverlap(
        footprint(r.instance!, assets.get(r.instance!.assetId)!),
        footprint(base[0], assets.get('crate')!),
      ),
    ).toBe(false);
  });

  it('skips served, interpolated and off-world platforms', () => {
    expect(row('served').status).toBe('served');
    expect(row('guess').status).toBe('interpolated');
    expect(row('outside').status).toBe('off-world');
  });

  it('adds nothing when run again on the result', () => {
    const placed = rows.flatMap((r) => (r.instance ? [r.instance] : []));
    const again = planBusStopPlacements(input([...base, ...placed]));
    expect(again.filter((r) => r.instance)).toEqual([]);
    expect(again.filter((r) => r.status === 'existing')).toHaveLength(placed.length);
  });
});
