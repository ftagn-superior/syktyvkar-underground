import { expect, it } from 'vitest';
import { ringTerrainBoundaries } from '../../tools/world-build/src/ring-terrain-layout.js';
import type { TerrainGrid, WorldDefinition } from '../../packages/contracts/src/index.js';

it('repositions legacy boundary templates to the expanded world, keeping corners closed', () => {
  const bounds = { min: { x: -1500, y: -55, z: -850 }, max: { x: 2000, y: 60, z: 850 } };
  const grid: TerrainGrid = {
    formatVersion: 1,
    origin: { x: -1501, z: -853 },
    spacing: 20,
    columns: 177,
    rows: 87,
    bottom: -50,
    heights: Array(177 * 87).fill(6.5),
  };
  const entities = ['north', 'south', 'east', 'west'].map((direction) => ({
    entityId: `boundary-${direction}`,
    kind: 'obstacle' as const,
    color: '#888888',
    position: {
      x: direction === 'west' ? -268.75 : direction === 'east' ? 330.75 : 31,
      y: 0,
      z: direction === 'north' ? -744.75 : direction === 'south' ? 130.75 : -307,
    },
    size: {
      x: direction === 'north' || direction === 'south' ? 600 : 0.5,
      y: 2,
      z: direction === 'east' || direction === 'west' ? 876 : 0.5,
    },
  }));
  const original = structuredClone(entities);
  const result = ringTerrainBoundaries({ bounds, entities } as WorldDefinition, grid, {
    insetMetres: 0.02,
  });
  expect(entities).toEqual(original);
  expect(result).toHaveLength(652);
  for (const wall of result) {
    const horizontal = /^boundary-(north|south)-/.test(wall.entityId);
    const normal = horizontal ? 'z' : 'x',
      axis = horizontal ? 'x' : 'z';
    const minimum = /^boundary-(north|west)-/.test(wall.entityId);
    expect(wall.position[normal]).toBeCloseTo(
      minimum ? bounds.min[normal] + 0.27 : bounds.max[normal] - 0.27,
      8,
    );
    expect(wall.position.y - wall.size.y / 2).toBeCloseTo(grid.bottom, 8);
    expect(wall.position.y + wall.size.y / 2).toBeCloseTo(8, 8);
    expect(wall.position[axis] - wall.size[axis] / 2).toBeGreaterThanOrEqual(
      bounds.min[axis] + 0.019999,
    );
    expect(wall.position[axis] + wall.size[axis] / 2).toBeLessThanOrEqual(
      bounds.max[axis] - 0.019999,
    );
  }
});
