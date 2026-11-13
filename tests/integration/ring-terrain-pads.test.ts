import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TerrainGrid, WorldLayoutSnapshot } from '../../packages/contracts/src/index.js';
import { planSupportPlacement } from '../../packages/terrain-build/src/supports.js';
import {
  generateRingTerrainPads,
  readRingTerrainPadInputs,
  readRingTerrainPilotWithPads,
} from '../../tools/world-build/src/ring-pads.js';
import { ringTerrainGridStatistics } from '../../tools/world-build/src/ring-terrain-candidate.js';

describe('explicit simultaneous ring terrain pads', () => {
  let inputs: Awaited<ReturnType<typeof readRingTerrainPadInputs>>;
  let grid: TerrainGrid;
  beforeAll(async () => {
    inputs = await readRingTerrainPadInputs();
    grid = await readRingTerrainPilotWithPads();
  });

  it('does not depend on catalogue ordering or mutate the source grid', () => {
    const before = JSON.stringify(inputs.base);
    const reversed = generateRingTerrainPads(inputs.base, [...inputs.rules].reverse(), {
      ...inputs.config,
      clusters: [...inputs.config.clusters].reverse(),
      gradeCorrections: [...inputs.config.gradeCorrections].reverse(),
      placements: [...inputs.config.placements].reverse(),
    });
    expect(reversed).toEqual(grid);
    expect(JSON.stringify(inputs.base)).toBe(before);
    expect(inputs.config.placements).toHaveLength(27);
    expect(inputs.config.clusters.flatMap((c) => c.ownerIds)).toHaveLength(23);
    expect(inputs.config.gradeCorrections).toHaveLength(4);
  });

  it('meets the full-footprint support limit, including models outside the listed pads', async () => {
    const snapshot: WorldLayoutSnapshot = JSON.parse(
      await readFile('data/map-layout.json', 'utf8'),
    );
    let checked = 0,
      maximum = 0;
    for (const owner of snapshot.instances.filter((owner) => owner.enabled)) {
      const rule = inputs.rules.find((rule) => rule.assetId === owner.assetId);
      if (!rule) continue;
      const plan = planSupportPlacement(grid, rule, owner);
      const height = plan.minimumY + rule.jointY - plan.terrainMin;
      expect(height, owner.entityId).toBeLessThanOrEqual(3);
      if (owner.entityId === 'osm-way-1258973447') expect(height).toBeCloseTo(0.08, 9);
      maximum = Math.max(maximum, height);
      checked++;
    }
    expect(checked).toBe(136);
    expect(maximum).toBeCloseTo(2.9261855603508096, 9);
    expect(ringTerrainGridStatistics(grid).triangleSlopeDegrees.max).toBeLessThan(6.6);
  });

  it('rejects an unlisted owner instead of silently giving it a pad', () => {
    expect(() =>
      generateRingTerrainPads(inputs.base, inputs.rules, {
        ...inputs.config,
        clusters: [
          ...inputs.config.clusters,
          { id: 'unlisted', ownerIds: ['unlisted-owner'], levelMetres: 1 },
        ],
      }),
    ).toThrow('Missing explicit pad placement');
  });
});
