import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  ringTerrainLandmarks,
  ringTerrainBoundaries,
} from '../../tools/world-build/src/ring-terrain-layout.js';
import { primitiveBounds } from '../../packages/contracts/src/index.js';
import type {
  BuildingInstance,
  Landmark,
  TerrainGrid,
} from '../../packages/contracts/src/index.js';

it('keeps the six authored city labels above their moved owner or public ground', async () => {
  const source = JSON.parse(await readFile('content/worlds/ring-block/world.json', 'utf8'));
  const cell = JSON.parse(await readFile('content/worlds/ring-block/cells/0_0.json', 'utf8'));
  const owners: BuildingInstance[] = cell.buildings;
  const targets = Object.fromEntries(owners.map((o) => [o.entityId, o.position.y + 2]));
  const grid: TerrainGrid = {
    formatVersion: 1,
    origin: { x: -269, z: -745 },
    spacing: 4,
    columns: 151,
    rows: 220,
    bottom: -4,
    heights: Array(151 * 220).fill(3),
  };
  const before = structuredClone(source.landmarks);
  const actual = ringTerrainLandmarks(source.landmarks, owners, targets, grid);
  expect(actual).toHaveLength(6);
  for (const label of actual) {
    const old = source.landmarks.find((l: Landmark) => l.id === label.id);
    expect(label.position).toEqual({
      ...old.position,
      y: old.position.y + (label.id === 'theatre-square' ? 3 : 2),
    });
  }
  expect(source.landmarks).toEqual(before);
  delete targets['osm-way-1258973447'];
  expect(() => ringTerrainLandmarks(source.landmarks, owners, targets, grid)).toThrow(
    'Missing label owner',
  );
});

it('insets every full-map wall face without opening segment or corner gaps', async () => {
  const source = JSON.parse(await readFile('content/worlds/ring-block/world.json', 'utf8'));
  const before = structuredClone(source.entities);
  const grid: TerrainGrid = {
    formatVersion: 1,
    origin: { x: -269, z: -745 },
    spacing: 4,
    columns: 151,
    rows: 220,
    bottom: -4,
    heights: Array(151 * 220).fill(3),
  };
  const original = ringTerrainBoundaries(source, grid);
  expect(ringTerrainBoundaries(source, grid, { insetMetres: 0 })).toEqual(original);
  const inset = 0.02;
  const walls = ringTerrainBoundaries(source, grid, { insetMetres: inset });
  expect(walls).toHaveLength(original.length);
  for (const wall of walls) {
    const b = primitiveBounds(wall);
    for (const axis of ['x', 'z'] as const) {
      expect(b.min[axis]).toBeGreaterThanOrEqual(source.bounds.min[axis] + inset - 1e-9);
      expect(b.max[axis]).toBeLessThanOrEqual(source.bounds.max[axis] - inset + 1e-9);
    }
    expect(b.min.y).toBe(-4);
    expect(b.max.y).toBe(4.5);
  }
  for (const side of ['north', 'south', 'east', 'west']) {
    const axis = side === 'north' || side === 'south' ? 'x' : 'z';
    const bounds = walls
      .filter((w) => w.entityId.startsWith(`boundary-${side}-`))
      .map(primitiveBounds)
      .sort((a, b) => a.min[axis] - b.min[axis]);
    expect(bounds[0].min[axis]).toBeCloseTo(source.bounds.min[axis] + inset, 9);
    expect(bounds.at(-1)!.max[axis]).toBeCloseTo(source.bounds.max[axis] - inset, 9);
    for (let i = 1; i < bounds.length; i++)
      expect(bounds[i].min[axis]).toBeCloseTo(bounds[i - 1].max[axis], 9);
  }
  for (const ns of ['north', 'south'])
    for (const ew of ['east', 'west']) {
      const horizontal = walls.filter((w) => w.entityId.startsWith(`boundary-${ns}-`));
      const vertical = walls.filter((w) => w.entityId.startsWith(`boundary-${ew}-`));
      const a = primitiveBounds(ew === 'west' ? horizontal[0] : horizontal.at(-1)!);
      const b = primitiveBounds(ns === 'north' ? vertical[0] : vertical.at(-1)!);
      for (const axis of ['x', 'z'] as const)
        expect(Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis])).toBeCloseTo(
          0.5,
          9,
        );
    }
  expect(source.entities).toEqual(before);
  expect(() => ringTerrainBoundaries(source, grid, { insetMetres: -0.01 })).toThrow(
    'Invalid boundary inset',
  );
  expect(() => ringTerrainBoundaries(source, grid, { insetMetres: 0.25 })).toThrow();
});
