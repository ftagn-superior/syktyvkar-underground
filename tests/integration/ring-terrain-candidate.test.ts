import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sampleTerrain } from '../../packages/contracts/src/terrain.js';
import {
  assertRingPilotCorePreserved,
  generateRingTerrainCandidate,
  readDiagnosticSourceGrid,
  readRingTerrainCandidate,
  ringPilotWeight,
  ringTerrainGridStatistics,
} from '../../tools/world-build/src/ring-terrain-candidate.js';

describe('pinned approximate ring terrain candidate', () => {
  it('preserves the continuous core and leaves only the west world boundary elevated', async () => {
    const [full, pilot] = await Promise.all([
      readRingTerrainCandidate('full'),
      readRingTerrainCandidate('pilot'),
    ]);
    expect(assertRingPilotCorePreserved(full, pilot)).toMatchObject({
      intersectingCells: 3538,
      maxHeightDifferenceMetres: 0,
    });
    for (const [x, z] of [
      [0, -280],
      [0, -40],
      [-225, -280],
      [-225, -40],
      [-111.3, -101.8],
    ])
      expect(sampleTerrain(pilot, x, z)?.height).toBe(sampleTerrain(full, x, z)?.height);
    const stats = ringTerrainGridStatistics(pilot);
    expect(stats.boundary.west.max).toBeGreaterThan(12);
    expect(stats.boundary.north.max).toBe(0);
    expect(stats.boundary.south.max).toBe(0);
    expect(stats.boundary.east.max).toBe(0);
    expect(stats.triangleSlopeDegrees.max).toBeLessThan(6.44);
    expect(stats.heightY.min).toBeLessThan(0);
    expect(sampleTerrain(pilot, -270, -100)).toBeUndefined();
  });

  it('takes exact 2 m source nodes at 4 m without clipping their height', async () => {
    const source = readDiagnosticSourceGrid(
      JSON.parse(
        await readFile('content/worlds/ring-block/terrain-candidate/source-grid-2m.json', 'utf8'),
      ),
    );
    const full = generateRingTerrainCandidate(source, 'full');
    for (let row = 0; row < full.rows; row++)
      for (let column = 0; column < full.columns; column++)
        expect(full.heights[row * full.columns + column]).toBe(
          source.heights[row * 2 * source.columns + column * 2],
        );
    const extreme = { ...source, heights: source.heights.map(() => 20) };
    expect(generateRingTerrainCandidate(extreme, 'full').heights[0]).toBe(20);
    expect(ringPilotWeight(-200, -100)).toBe(1);
    expect(ringPilotWeight(-269, -100)).toBe(1);
    expect(ringPilotWeight(200, -100)).toBe(0);
    expect(ringPilotWeight(0, -481)).toBe(0);
    expect(ringPilotWeight(0, 131)).toBe(0);
  });
});
