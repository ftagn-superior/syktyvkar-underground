import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  sampleTerrain,
  terrainCellTriangles,
  terrainNormal,
  validateTerrainGrid,
} from '../../packages/contracts/src/index.js';
import {
  expressiveRingTerrainOffset,
  generateExpressiveRingTerrain,
  measureTerrainProfile,
  RING_TERRAIN_EXPRESSIVENESS_CONFIG,
  RING_TERRAIN_EXPRESSIVENESS_ROUTES,
} from '../../tools/world-build/src/ring-terrain-expressiveness.js';

const source = validateTerrainGrid(
  JSON.parse(await readFile('content/worlds/ring-block/terrain-smoothed/grid.json', 'utf8')),
);
const candidate = generateExpressiveRingTerrain(source);
const slopes = (grid: typeof source) => {
  const values: number[] = [];
  for (let z = 0; z < grid.rows - 1; z++)
    for (let x = 0; x < grid.columns - 1; x++)
      for (const triangle of terrainCellTriangles(grid, x, z)) {
        const normal = terrainNormal(triangle);
        values.push((Math.atan2(Math.hypot(normal.x, normal.z), normal.y) * 180) / Math.PI);
      }
  return values.sort((a, b) => a - b);
};

describe('ring-block expressive macro terrain', () => {
  it('preserves the approved topology and produces identical output without modifying its source', () => {
    const saved = structuredClone(source);
    expect(generateExpressiveRingTerrain(source)).toEqual(candidate);
    expect(source).toEqual(saved);
    expect({ ...candidate, heights: [] }).toEqual({ ...source, heights: [] });
    expect(candidate.heights).toHaveLength(15_399);
    expect(candidate.spacing).toBe(20);
    expect(Math.min(...candidate.heights)).toBeGreaterThan(candidate.bottom);
    expect(Math.max(...candidate.heights)).toBeLessThan(60);
  });

  it('makes the named routes substantially more pronounced in the actual triangle surface', () => {
    const profiles = Object.fromEntries(
      RING_TERRAIN_EXPRESSIVENESS_ROUTES.map((route) => [
        route.id,
        {
          before: measureTerrainProfile(source, route.points),
          after: measureTerrainProfile(candidate, route.points),
        },
      ]),
    );
    expect(profiles.river.before.distance).toBe(2450);
    expect(-profiles.river.after.rise).toBeGreaterThan(32);
    expect(-profiles.river.after.rise).toBeLessThan(40);
    expect(profiles.dimitrova.after.rise).toBeGreaterThan(10);
    expect(profiles.dimitrova.after.rise).toBeGreaterThan(profiles.dimitrova.before.rise * 2.5);
    expect(profiles.oplesnina.after.relief).toBeGreaterThan(11.5);
    expect(profiles.oplesnina.after.relief).toBeGreaterThan(profiles.oplesnina.before.relief * 1.8);
  });

  it('preserves riverbank lowering across the full city width while retaining inland hills', () => {
    for (const z of [-800, -600, -200, 0, 400, 800]) {
      const inland =
        sampleTerrain(candidate, 700, z)!.height - sampleTerrain(source, 700, z)!.height;
      const riverbank =
        sampleTerrain(candidate, 1800, z)!.height - sampleTerrain(source, 1800, z)!.height;
      expect(riverbank).toBeCloseTo(-11, 5);
      expect(inland).toBeGreaterThan(riverbank);
    }
  });

  it('keeps ordinary plateau yards calm and avoids a narrow ridge under Dimitrova', () => {
    for (const [x, z] of [
      [-1100, -500],
      [-900, 0],
    ])
      expect(expressiveRingTerrainOffset(x, z)).toBe(0);
    // The protected platform can move vertically while each yard keeps its
    // previously accepted grade. A zero absolute offset is not required.
    for (const [x, z] of [
      [0, 0],
      [300, 0],
      [0, -400],
      [300, -400],
    ]) {
      expect(expressiveRingTerrainOffset(x, z)).toBe(6.5);
      for (const axis of ['x', 'y', 'z'] as const)
        expect(sampleTerrain(candidate, x, z)!.normal[axis]).toBeCloseTo(
          sampleTerrain(source, x, z)!.normal[axis],
          10,
        );
    }
    const { start, end } = RING_TERRAIN_EXPRESSIVENESS_CONFIG.dimitrova;
    const dx = end[0] - start[0],
      dz = end[1] - start[1],
      length = Math.hypot(dx, dz);
    const midX = (start[0] + end[0]) / 2,
      midZ = (start[1] + end[1]) / 2;
    const center = expressiveRingTerrainOffset(midX, midZ);
    for (const across of [-200, -100, 100, 200])
      expect(
        expressiveRingTerrainOffset(midX - (across * dz) / length, midZ + (across * dx) / length),
      ).toBeCloseTo(center, 10);
    const before = slopes(source),
      after = slopes(candidate);
    expect(after[Math.floor(after.length * 0.95)]).toBeLessThan(3.5);
    expect(after.at(-1)!).toBeLessThanOrEqual(before.at(-1)! + 0.001);
  });

  it('preserves grades around long houses and the adjoining wall enclosure instead of growing ramps', () => {
    const protectedSites = [
      [-64.3, -325.8],
      [-101.9, -403.2],
      [-151.87, -378.45],
      [308.526, -526.34],
      [280.679, -579.031],
      [224.724, -440.562],
      [197.494, -472.358],
      [177.553, -515.017],
      [258.212, -587.791],
      [253.834, -524.128],
      [320.128, -475.623],
      [204.424, -563.94],
      [322.427, -471.169],
    ];
    for (const [x, z] of protectedSites)
      for (const dx of [-60, 0, 60])
        for (const dz of [-60, 0, 60])
          expect(
            sampleTerrain(candidate, x + dx, z + dz)!.height -
              sampleTerrain(source, x + dx, z + dz)!.height,
          ).toBeCloseTo(6.5, 5);
    const invalid = structuredClone(RING_TERRAIN_EXPRESSIVENESS_CONFIG);
    invalid.gradePreservationPads!.push({
      id: 'conflicting-platform',
      center: [100, -400],
      reference: [-1000, 0],
      plateauRadiusMetres: 100,
      blendWidthMetres: 100,
    });
    expect(() => generateExpressiveRingTerrain(source, invalid)).toThrow(/same additional height/);
  });

  it('rejects degenerate or non-finite authoring parameters before generation', () => {
    const invalid = structuredClone(RING_TERRAIN_EXPRESSIVENESS_CONFIG);
    invalid.dimitrova.end = invalid.dimitrova.start;
    expect(() => generateExpressiveRingTerrain(source, invalid)).toThrow();
    invalid.dimitrova.end = [NaN, 0];
    expect(() => generateExpressiveRingTerrain(source, invalid)).toThrow(/finite/);
    expect(() =>
      measureTerrainProfile(candidate, [
        [-5000, 0],
        [0, 0],
      ]),
    ).toThrow(/outside/);
  });
});
