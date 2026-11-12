import { describe, expect, it } from 'vitest';
import {
  createWorldGrid,
  worldCellAt,
  worldCellBounds,
  cellsIntersectingBounds,
  buildingBounds,
  mergeWorldCells,
  validateWorldCell,
  type Bounds,
  type WorldCell,
} from './index.js';

const bounds: Bounds = { min: { x: -1000, y: -5, z: -1000 }, max: { x: 1000, y: 15, z: 1000 } };
const grid = createWorldGrid(bounds, 125);

describe('world grid and seam identity', () => {
  it('uses world-relative floor indices, half-open interiors and a closed outer maximum', () => {
    expect(grid).toEqual({ origin: { x: -1000, z: -1000 }, cellSize: 125, columns: 16, rows: 16 });
    for (const [x, z, expected] of [
      [-1000, -1000, '0_0'],
      [-875.001, -1, '0_7'],
      [-875, 0, '1_8'],
      [-0.001, 0, '7_8'],
      [0, 0, '8_8'],
      [1000, 1000, '15_15'],
    ] as const)
      expect(worldCellAt(bounds, grid, { x, z })).toBe(expected);
    for (const point of [
      { x: -1000.001, z: 0 },
      { x: 0, z: 1000.001 },
      { x: NaN, z: 0 },
    ])
      expect(worldCellAt(bounds, grid, point)).toBeUndefined();
  });

  it('clips partial edge cells and rejects invalid sizes, cell IDs and excessive grids', () => {
    const small = { min: { x: -20, y: -5, z: -20 }, max: { x: 20, y: 15, z: 20 } };
    expect(worldCellBounds(small, createWorldGrid(small, 125), '0_0')).toEqual(small);
    const partial = { ...small, max: { ...small.max, x: 130 } };
    expect(worldCellBounds(partial, createWorldGrid(partial, 125), '1_0').max.x).toBe(130);
    expect(worldCellBounds(partial, createWorldGrid(partial, 125), '1_0').min.x).toBe(105);
    for (const size of [0, -1, NaN, Infinity, 0.5, 1001])
      expect(() => createWorldGrid(bounds, size)).toThrow();
    expect(() => createWorldGrid(bounds, 1)).toThrow('cell count');
    for (const id of ['-1_0', '16_0', '01_0', '0_0_extra'])
      expect(() => worldCellBounds(bounds, grid, id)).toThrow();
  });

  it('assigns side/corner overlaps, but keeps exactly touching tiles in their own cell', () => {
    const tile = worldCellBounds(bounds, grid, '8_8');
    expect(cellsIntersectingBounds(bounds, grid, tile)).toEqual(['8_8']);
    expect(
      cellsIntersectingBounds(bounds, grid, {
        min: { x: -1, y: 0, z: 1 },
        max: { x: 1, y: 2, z: 2 },
      }),
    ).toEqual(['7_8', '8_8']);
    expect(
      cellsIntersectingBounds(bounds, grid, {
        min: { x: -1, y: 0, z: -1 },
        max: { x: 1, y: 2, z: 1 },
      }),
    ).toEqual(['7_7', '8_7', '7_8', '8_8']);
    expect(
      cellsIntersectingBounds(bounds, grid, {
        min: { x: 1000, y: 0, z: 0 },
        max: { x: 1001, y: 1, z: 1 },
      }),
    ).toEqual([]);
  });

  it('includes the full rotation when finding the world bounding box', () => {
    const result = buildingBounds(
      {
        entityId: 'rotated',
        assetId: 'test',
        position: { x: 1, y: 0, z: 5 },
        rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
      },
      { min: { x: -4, y: 0, z: -1 }, max: { x: 4, y: 3, z: 1 } },
    );
    expect(result.min.x).toBeCloseTo(0);
    expect(result.max.x).toBeCloseTo(2);
    expect(result.min.z).toBeCloseTo(1);
    expect(result.max.z).toBeCloseTo(9);
    const rounded = buildingBounds(
      {
        entityId: 'rounded',
        assetId: 'test',
        position: { x: 1, y: 0, z: 5 },
        rotation: { x: 0.7071, y: 0, z: 0, w: 0.7071 },
      },
      { min: { x: -4, y: 0, z: -1 }, max: { x: 4, y: 3, z: 1 } },
    );
    expect(rounded.min.y).toBeCloseTo(-1, 10);
    expect(rounded.max.y).toBeCloseTo(1, 10);
    expect(rounded.min.z).toBeCloseTo(5, 10);
    expect(rounded.max.z).toBeCloseTo(8, 10);
  });

  it('merges identical definitions across cells and rejects conflicts and within-cell duplicates', () => {
    const item = {
      entityId: 'shared',
      assetId: 'test',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    const first: WorldCell = { formatVersion: 2, cellId: '7_8', statics: [], buildings: [item] };
    const second: WorldCell = { ...first, cellId: '8_8', buildings: [structuredClone(item)] };
    expect(mergeWorldCells([first, second]).buildings).toEqual([item]);
    second.buildings[0].position.x = 1;
    expect(() => mergeWorldCells([first, second])).toThrow('Conflicting entity ID');
    expect(() => validateWorldCell({ ...first, buildings: [item, item] })).toThrow('duplicate ID');
    expect(() => validateWorldCell({ ...first, formatVersion: 1 })).toThrow();
    const primitive: WorldCell = {
      formatVersion: 2,
      cellId: '8_8',
      buildings: [],
      statics: [
        {
          entityId: 'shared',
          kind: 'obstacle',
          position: { x: 0, y: 1, z: 0 },
          size: { x: 1, y: 2, z: 1 },
          mass: 0,
          friction: 0.6,
          restitution: 0,
          color: '#ffffff',
        },
      ],
    };
    expect(() => mergeWorldCells([first, primitive])).toThrow('Conflicting entity ID');
  });
});
