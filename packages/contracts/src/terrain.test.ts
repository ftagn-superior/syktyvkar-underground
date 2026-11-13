import { describe, expect, it } from 'vitest';
import { sampleTerrain, validateTerrainGrid, type TerrainGrid } from './terrain.js';

const grid = (): TerrainGrid => ({
  formatVersion: 1,
  origin: { x: -1, z: -1 },
  columns: 2,
  rows: 2,
  spacing: 2,
  heights: [-3, -1, -2, 3],
  bottom: -4,
});
describe('terrain coordinate contract', () => {
  it('supports negative heights and triangular rather than bilinear interpolation', () => {
    const g = validateTerrainGrid(grid());
    expect(sampleTerrain(g, 0, 0)?.height).toBeCloseTo(0);
    expect(sampleTerrain(g, 0, -0.5)?.height).toBeCloseTo(-1);
    expect(sampleTerrain(g, -0.5, 0)?.height).toBeCloseTo(-1.25);
    expect(sampleTerrain(g, 0, 0)?.triangleIndex).toBe(0);
    expect(sampleTerrain(g, -0.5, 0)?.triangleIndex).toBe(1);
    expect(sampleTerrain(g, 1, 1)?.height).toBeCloseTo(3);
    expect(sampleTerrain(g, -1, -1)?.height).toBeCloseTo(-3);
    for (const p of [
      [1.00001, 0],
      [-1.00001, 0],
      [0, -2],
      [0, 2],
      [NaN, 0],
    ])
      expect(sampleTerrain(g, p[0], p[1])).toBeUndefined();
  });
  it('selects the positive cell at interior boundaries and returns upward unit normals', () => {
    const g = { ...grid(), columns: 3, rows: 3, heights: [0, 1, 0, 1, 2, 1, 0, 1, 0] };
    const s = sampleTerrain(g, 1, 1)!;
    expect([s.column, s.row, s.triangleIndex]).toEqual([1, 1, 0]);
    expect(Math.hypot(s.normal.x, s.normal.y, s.normal.z)).toBeCloseTo(1);
    expect(s.normal.y).toBeGreaterThan(0);
  });
  it.each([
    { spacing: 0 },
    { spacing: NaN },
    { rows: 1 },
    { columns: 2.5 },
    { heights: [0] },
    { heights: [0, 1, 2, Infinity] },
    { heights: [0, 1, 2, null] },
    { heights: [-4, 0, 1, 2] },
    { bottom: 0 },
    { origin: { x: NaN, z: 0 } },
    { rows: 1000001 },
    { formatVersion: 2 },
  ])('rejects malformed data %j', (fields) => {
    expect(() => validateTerrainGrid({ ...grid(), ...fields })).toThrow('Invalid terrain grid');
  });
});
