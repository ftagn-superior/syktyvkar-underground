import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleTerrain, type TerrainGrid } from '../../packages/contracts/src/index.js';
import { planSupportPlacement } from '../../packages/terrain-build/src/supports.js';
import { patchRange, rectangle, terrainPatch } from '../../packages/terrain-build/src/terrain.js';
import {
  generateFullRingTerrain,
  readFullRingTerrainInputs,
  type FullRingTerrainConfig,
} from '../../tools/world-build/src/ring-full-terrain.js';
import { ringTerrainGridStatistics } from '../../tools/world-build/src/ring-terrain-candidate.js';

// The saved user export is intentionally untracked. Dataset checks are mandatory when it is present;
// readFullRingTerrainInputs verifies its exact pinned SHA before any actual-owner assertions.
describe.skipIf(!existsSync('data/map-layout.json'))(
  'full-map terrain with exact saved export (requires data/map-layout.json)',
  () => {
    let inputs: Awaited<ReturnType<typeof readFullRingTerrainInputs>>;
    let ready: TerrainGrid;
    const generate = (config = inputs.config) =>
      generateFullRingTerrain(
        inputs.base,
        inputs.catalog.rules,
        [...inputs.catalog.rules, ...inputs.kits.map((k) => k.rule)],
        inputs.snapshot,
        inputs.inheritedBuildings,
        inputs.inheritedPublic,
        config,
      );
    beforeAll(async () => {
      inputs = await readFullRingTerrainInputs();
      ready = JSON.parse(
        await readFile('content/worlds/ring-block/terrain-candidate/full-grid-ready.json', 'utf8'),
      );
    });

    it('reproduces the pinned full grid without source mutation or geographical peak clipping', () => {
      const before = JSON.stringify(inputs.base);
      expect(generate()).toEqual(ready);
      expect(JSON.stringify(inputs.base)).toBe(before);
      const source = ringTerrainGridStatistics(inputs.base),
        actual = ringTerrainGridStatistics(ready);
      expect(actual.heightY.max).toBe(source.heightY.max);
      expect(actual.heightY.min).toBeLessThan(0);
      expect(actual.triangleSlopeDegrees.max).toBeLessThan(8);
      expect(actual.triangleSlopeDegrees.p95).toBeLessThan(4.6);
      expect(ready.heights.filter((h, i) => h === inputs.base.heights[i]).length).toBeGreaterThan(
        11000,
      );
    });

    it('is deterministic under explicit decision and catalogue reordering', () => {
      const config = structuredClone(inputs.config);
      config.buildingPads.replacement.clusters.reverse();
      config.buildingPads.replacement.gradeCorrections.reverse();
      config.buildingPads.replacement.retiredOwners.reverse();
      config.publicPads.levelOverrides.reverse();
      config.additionalPads.reverse();
      expect(
        generateFullRingTerrain(
          inputs.base,
          [...inputs.catalog.rules].reverse(),
          [...inputs.catalog.rules, ...inputs.kits.map((k) => k.rule)].reverse(),
          { ...inputs.snapshot, instances: [...inputs.snapshot.instances].reverse() },
          inputs.inheritedBuildings,
          { ...inputs.inheritedPublic, pads: [...inputs.inheritedPublic.pads].reverse() },
          config,
        ),
      ).toEqual(ready);
    });

    it('checks every actual saved footprint and complete anchor contact against unchanged budgets', () => {
      const rules = new Map(
        [...inputs.catalog.rules, ...inputs.kits.map((k) => k.rule)].map((r) => [r.assetId, r]),
      );
      const kits = new Map(inputs.kits.map((k) => [k.assetId, k]));
      const anchors = new Map(inputs.anchors.map((a) => [a.assetId, a.policy]));
      const counts = { buildings: 0, kits: 0, anchors: 0 };
      for (const owner of inputs.snapshot.instances.filter((o) => o.enabled)) {
        const rule = rules.get(owner.assetId);
        if (rule) {
          const plan = planSupportPlacement(ready, rule, owner);
          const offset = owner.position.y + rule.jointY;
          expect(offset, owner.entityId).toBeGreaterThanOrEqual(0);
          const height = plan.minimumY + offset + rule.jointY - plan.terrainMin;
          expect(height, owner.entityId).toBeLessThanOrEqual(
            kits.get(owner.assetId)?.maximumVisibleHeight ?? 3,
          );
          if (kits.has(owner.assetId)) counts.kits++;
          else counts.buildings++;
        } else {
          const policy = anchors.get(owner.assetId)!;
          expect(policy, owner.entityId).toBeDefined();
          const yaw = 2 * Math.atan2(owner.rotation.y, owner.rotation.w);
          const x =
            owner.position.x + policy.anchor.x * Math.cos(yaw) + policy.anchor.z * Math.sin(yaw);
          const z =
            owner.position.z - policy.anchor.x * Math.sin(yaw) + policy.anchor.z * Math.cos(yaw);
          const patch = rectangle(x, z, 2 * policy.contactRadius, 2 * policy.contactRadius);
          for (const [px, pz] of patch)
            expect(sampleTerrain(ready, px, pz), owner.entityId).toBeDefined();
          const range = patchRange(terrainPatch(ready, patch));
          expect(range.max - range.min, owner.entityId).toBeLessThanOrEqual(
            policy.maximumTerrainReliefMetres,
          );
          counts.anchors++;
        }
      }
      expect(counts).toEqual({ buildings: 136, kits: 2389, anchors: 1184 });
    });

    it('requires an explicit decision for every formerly edited pilot owner', () => {
      const config = structuredClone(inputs.config);
      config.buildingPads.replacement.retiredOwners.pop();
      expect(() => generate(config)).toThrow('Unexplained pilot intervention');
    });

    it('rejects overlapping incompatible planes for distinct saved owners', () => {
      const config = structuredClone(inputs.config);
      config.additionalPads = ['wall-7c32a4ceec13672d9c54', 'wall-a5624cad1554188046ad'].map(
        (id, index) => ({
          id: `conflict-${index}`,
          ownerIds: [id],
          levelMetres: 9 + index,
          plateauMarginMetres: 6,
          blendWidthMetres: 64,
          reason: 'Explicit conflicting test planes',
        }),
      );
      expect(() => generate(config)).toThrow('Conflicting full pad planes');
    });
  },
);

describe('full-map pure structural fixtures (no local export required)', () => {
  it('uses rotated structural components and preserves holes and unaffected source nodes', () => {
    const base: TerrainGrid = {
      formatVersion: 1,
      origin: { x: -12, z: -12 },
      spacing: 1,
      columns: 25,
      rows: 25,
      heights: Array(625).fill(0),
      bottom: -4,
    };
    const owner = {
      entityId: 'rotated-owner',
      assetId: 'courtyard',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) },
      enabled: true,
      instanceRevision: 1,
    };
    const rule = {
      kind: 'foundation-v2' as const,
      assetId: 'courtyard',
      jointY: 0,
      clearance: 0.02,
      burial: 0.1,
      color: '#777777',
      components: [{ outline: rectangle(0, 0, 12, 12), holes: [rectangle(0, 0, 7, 7)] }],
    };
    const config: FullRingTerrainConfig = {
      formatVersion: 1,
      status: 'explicit-unapplied-full-terrain-pads',
      sourceGrid: 'full-grid-4m.json',
      sourceGridSha256: '0'.repeat(64),
      sourceExportSha256: '0'.repeat(64),
      buildingPads: {
        file: 'ring-pads.json',
        sha256: '0'.repeat(64),
        replacement: { reason: 'Fixture', clusters: [], gradeCorrections: [], retiredOwners: [] },
      },
      publicPads: { file: 'public-space-pads.json', sha256: '0'.repeat(64), levelOverrides: [] },
      additionalPads: [
        {
          id: 'courtyard-pad',
          ownerIds: [owner.entityId],
          levelMetres: 2,
          plateauMarginMetres: 1.5,
          blendWidthMetres: 1,
          reason: 'Fixture actual rotated courtyard',
        },
      ],
    };
    const result = generateFullRingTerrain(
      base,
      [],
      [rule],
      {
        formatVersion: 1,
        worldId: 'fixture',
        assetReleaseVersion: '0'.repeat(64),
        seedVersion: '0'.repeat(64),
        revision: 0,
        instances: [owner],
      },
      {
        formatVersion: 1,
        status: 'selected-unapplied-explicit-pads',
        sourceGrid: 'fixture-grid.json',
        sourceGridSha256: '0'.repeat(64),
        supportRulesSha256: '0'.repeat(64),
        blendWidthMetres: 1,
        forecourt: {
          ownerId: 'unused',
          outline: rectangle(0, 0, 1, 1).map(([x, z]): [number, number] => [x, z]),
        },
        placements: [],
        clusters: [],
        gradeCorrections: [],
        plateauMarginMetres: 2,
      },
      { pads: [] },
      config,
    );
    expect(sampleTerrain(result, 0, 0)!.height).toBe(0);
    expect(sampleTerrain(result, 4, -4)!.height).toBe(2);
    expect(sampleTerrain(result, 12, 12)!.height).toBe(0);
    expect(base.heights.every((h) => h === 0)).toBe(true);
  });
});
