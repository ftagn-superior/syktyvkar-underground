import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  sampleTerrain,
  terrainCellTriangles,
  terrainNormal,
  validateTerrainGrid,
  type TerrainGrid,
} from '@su/contracts';
import { hash } from '@su/world-release';

export const RING_TERRAIN_CANDIDATE_DIRECTORY = 'content/worlds/ring-block/terrain-candidate';
export const RING_TERRAIN_SOURCE_SHA256 =
  '0db90bcb34b14f8b3de9c2fd02ad10d2567dc79bd5d16d5dfda136bf9484e6dc';
export const RING_TERRAIN_PILOT_CORE = { minX: -225, maxX: 0, minZ: -280, maxZ: -40 };
/** The plateau includes every grid triangle intersecting the requested continuous core. */
export const RING_TERRAIN_PILOT_TRANSITION = {
  plateau: { maxX: 3, minZ: -281, maxZ: -37 },
  zero: { minZ: -481, maxX: 200, maxZ: 131 },
  westBoundary: 'retain-candidate-height' as const,
};

export function smoothstep(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function ringPilotWeight(x: number, z: number) {
  const { plateau, zero } = RING_TERRAIN_PILOT_TRANSITION;
  return (
    (1 - smoothstep((x - plateau.maxX) / (zero.maxX - plateau.maxX))) *
    smoothstep((z - zero.minZ) / (plateau.minZ - zero.minZ)) *
    (1 - smoothstep((z - plateau.maxZ) / (zero.maxZ - plateau.maxZ)))
  );
}

export function readDiagnosticSourceGrid(value: unknown): TerrainGrid {
  const input = value as Record<string, unknown>;
  assert.equal(input.status, 'diagnostic_candidate_not_approved_terrain');
  assert.equal(input.verticalReference, 'WGS84 ellipsoid, Y=h-124');
  const grid = validateTerrainGrid({ ...input, formatVersion: 1, bottom: -4 });
  assert.deepEqual(grid.origin, { x: -269, z: -745 });
  assert.equal(grid.spacing, 2);
  assert.equal(grid.columns, 301);
  assert.equal(grid.rows, 439);
  return {
    formatVersion: 1,
    origin: grid.origin,
    spacing: grid.spacing,
    columns: grid.columns,
    rows: grid.rows,
    bottom: grid.bottom,
    heights: grid.heights,
  };
}

/** Pure authoring: no publication, database, pose updates, extra smoothing or clipping. */
export function generateRingTerrainCandidate(source: TerrainGrid, variant: 'full' | 'pilot') {
  validateTerrainGrid(source);
  const spacing = 4;
  const columns = ((source.columns - 1) * source.spacing) / spacing + 1;
  const rows = ((source.rows - 1) * source.spacing) / spacing + 1;
  assert.ok(Number.isInteger(columns) && Number.isInteger(rows));
  const heights = Array.from({ length: columns * rows }, (_, index) => {
    const x = source.origin.x + (index % columns) * spacing;
    const z = source.origin.z + Math.floor(index / columns) * spacing;
    const value = sampleTerrain(source, x, z);
    assert.ok(value, 'Candidate resampling is outside the pinned source grid');
    return value.height * (variant === 'pilot' ? ringPilotWeight(x, z) : 1);
  });
  return validateTerrainGrid({
    formatVersion: 1,
    origin: { ...source.origin },
    spacing,
    columns,
    rows,
    bottom: -4,
    heights,
  });
}

function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(sorted.length > 0);
  const percentile = (q: number) => {
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position);
    return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
  };
  return { count: sorted.length, min: sorted[0], p95: percentile(0.95), max: sorted.at(-1)! };
}

export function ringTerrainGridStatistics(grid: TerrainGrid) {
  validateTerrainGrid(grid);
  const slopes: number[] = [];
  let changedTriangles = 0;
  for (let row = 0; row < grid.rows - 1; row++)
    for (let column = 0; column < grid.columns - 1; column++)
      for (const triangle of terrainCellTriangles(grid, column, row)) {
        const normal = terrainNormal(triangle);
        slopes.push((Math.atan2(Math.hypot(normal.x, normal.z), normal.y) * 180) / Math.PI);
        if (triangle.some((p) => p.y !== 0)) changedTriangles++;
      }
  const boundary = {
    north: grid.heights.slice(0, grid.columns),
    south: grid.heights.slice(-grid.columns),
    west: Array.from({ length: grid.rows }, (_, row) => grid.heights[row * grid.columns]),
    east: Array.from({ length: grid.rows }, (_, row) => grid.heights[(row + 1) * grid.columns - 1]),
  };
  return {
    heightY: statistics(grid.heights),
    triangleSlopeDegrees: statistics(slopes),
    changedTriangles,
    boundary: Object.fromEntries(
      Object.entries(boundary).map(([side, ys]) => [side, statistics(ys)]),
    ),
  };
}

/** All vertices of every cell intersecting the closed core agree, so every point does. */
export function assertRingPilotCorePreserved(full: TerrainGrid, pilot: TerrainGrid) {
  const core = RING_TERRAIN_PILOT_CORE;
  assert.equal(full.spacing, pilot.spacing);
  assert.deepEqual(full.origin, pilot.origin);
  assert.equal(full.columns, pilot.columns);
  assert.equal(full.rows, pilot.rows);
  let cells = 0;
  for (let row = 0; row < full.rows - 1; row++)
    for (let column = 0; column < full.columns - 1; column++) {
      const x = full.origin.x + column * full.spacing;
      const z = full.origin.z + row * full.spacing;
      if (
        x > core.maxX ||
        x + full.spacing < core.minX ||
        z > core.maxZ ||
        z + full.spacing < core.minZ
      )
        continue;
      for (const [dx, dz] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const index = (row + dz) * full.columns + column + dx;
        assert.equal(
          pilot.heights[index],
          full.heights[index],
          'Pilot transition changed the core',
        );
      }
      cells++;
    }
  return { core, intersectingCells: cells, maxHeightDifferenceMetres: 0 };
}

/** Read the pinned input and validate the committed derived grid before a candidate build. */
export async function readRingTerrainCandidate(variant: 'full' | 'pilot' = 'pilot') {
  const sourceBytes = await readFile(`${RING_TERRAIN_CANDIDATE_DIRECTORY}/source-grid-2m.json`);
  assert.equal(hash(sourceBytes), RING_TERRAIN_SOURCE_SHA256, 'Approximate source grid changed');
  const source = readDiagnosticSourceGrid(JSON.parse(sourceBytes.toString()));
  const expected = generateRingTerrainCandidate(source, variant);
  const grid = validateTerrainGrid(
    JSON.parse(
      await readFile(`${RING_TERRAIN_CANDIDATE_DIRECTORY}/${variant}-grid-4m.json`, 'utf8'),
    ),
  );
  assert.deepEqual(grid, expected, 'Committed terrain candidate is stale; regenerate and review');
  return grid;
}
