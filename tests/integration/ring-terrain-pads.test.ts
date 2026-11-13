import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hash } from '../../packages/world-release/src/index.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  validateTerrainGrid,
  type TerrainGrid,
  type WorldLayoutSnapshot,
} from '../../packages/contracts/src/index.js';
import { planSupportPlacement } from '../../packages/terrain-build/src/supports.js';
import { generateRingTerrainPads } from '../../tools/world-build/src/ring-pads.js';
import { readRevalidatedPadFixture } from '../helpers/revalidated-ring-grids.js';
import { ringTerrainGridStatistics } from '../../tools/world-build/src/ring-terrain-candidate.js';

describe('explicit simultaneous ring terrain pads', () => {
  let inputs: Awaited<ReturnType<typeof readRevalidatedPadFixture>>;
  let grid: TerrainGrid;
  beforeAll(async () => {
    inputs = await readRevalidatedPadFixture();
    grid = validateTerrainGrid(
      JSON.parse(
        await readFile(
          'content/worlds/ring-block/terrain-candidate/pilot-grid-with-pads.json',
          'utf8',
        ),
      ),
    );
    expect(generateRingTerrainPads(inputs.base, inputs.rules, inputs.config)).toEqual(grid);
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

  it.skipIf(!existsSync('data/map-layout.json'))(
    'meets the actual full-footprint support limit (requires exact saved export)',
    async () => {
      const snapshotBytes = await readFile('data/map-layout.json');
      expect(hash(snapshotBytes)).toBe(
        'f4419053c7b40d2f6262a05a690ede725e4c879938e8806f8b85e918d4bad193',
      );
      const snapshot: WorldLayoutSnapshot = JSON.parse(snapshotBytes.toString());
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
    },
  );

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
