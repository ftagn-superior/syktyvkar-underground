import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planStaticTerrainPoses,
  type TerrainPoseRules,
} from '../../apps/server/src/layout/terrain-poses.js';
import { readAuthoringRelease } from '../../apps/server/src/layout/release.js';
import { sampleTerrain, type StaticObjectInstance } from '../../packages/contracts/src/index.js';
import { generateFootprint, type FootprintRecipe } from '../../tools/world-build/src/city.js';
import { compileGeneratedAsset } from '../../packages/terrain-build/src/assets.js';
import { readRingEmbeddedFootprintPolicies } from '../../tools/world-build/src/ring-embedded-footprints.js';
import { terrainPoseRules } from '../../tools/world-build/src/terrain-pose-rules.js';
import { buildTerrainPlacementWorld } from '../helpers/terrain-placement-world.js';

const recipe: FootprintRecipe = {
  formatVersion: 1,
  outline: [
    [-2, -1],
    [2, -1],
    [2, 1],
    [-2, 1],
  ],
  height: 5,
  floors: 1,
  windows: false,
  wallColor: '#999999',
  roofColor: '#555555',
  windowColor: '#333333',
};
const assetId = 'embedded-house';
let temporary: string;
let release: Awaited<ReturnType<typeof readAuthoringRelease>>;
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'su-embedded-footprint-'));
  release = await readAuthoringRelease(await buildTerrainPlacementWorld(temporary));
  release.definition.buildingAssets[assetId] = compileGeneratedAsset(
    assetId,
    generateFootprint(assetId, recipe),
  ).physics;
  const path = join(temporary, 'embedded', assetId);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'asset.json'),
    JSON.stringify({ assetId, source: { kind: 'footprint', file: 'source.json' } }),
  );
  await writeFile(join(path, 'source.json'), JSON.stringify(recipe));
});
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

function fixture() {
  const source = structuredClone(release),
    target = structuredClone(release);
  target.terrain!.grid.heights = target.terrain!.grid.heights.map((y) => y + 2);
  const owner: StaticObjectInstance = {
    entityId: 'placed-box',
    assetId,
    position: { x: 0, y: -0.5, z: 0 },
    rotation: { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) },
    instanceRevision: 7,
    enabled: true,
    sourceRef: { provider: 'osm', type: 'way', id: '123' },
  };
  const context = {
    sourceRelease: source,
    targetRelease: target,
    sourceWorld: source.definition,
    sourceSnapshot: {
      formatVersion: 1 as const,
      worldId: source.definition.worldId,
      assetReleaseVersion: source.metadata.assetReleaseVersion,
      seedVersion: source.metadata.seedVersion,
      revision: 10,
      instances: [owner],
    },
    sourceItems: [],
    sourcePlayers: [],
  };
  const rules: TerrainPoseRules = {
    ...terrainPoseRules(source, target),
    models: [
      {
        assetId,
        policy: {
          kind: 'embedded-footprint',
          components: [{ outline: recipe.outline }],
          minimumBurialMetres: 0.3,
        },
      },
    ],
  };
  return { source, target, owner, context, rules };
}

describe('embedded footprint terrain migration', () => {
  it('keeps the exact saved Y when the footprint terrain is unchanged', () => {
    const f = fixture();
    f.target.terrain!.grid = structuredClone(f.source.terrain!.grid);
    f.owner.position.y = -0.123456789123;
    const result = planStaticTerrainPoses(f.context, f.rules);
    expect(result.issues).toEqual([]);
    expect(result.targetSnapshot.instances[0]).toEqual(f.owner);
  });

  it('keeps roof offset above the whole rotated footprint and preserves the saved placement', () => {
    const f = fixture();
    const before = structuredClone(f.context);
    const result = planStaticTerrainPoses(f.context, f.rules);
    expect(result.issues).toEqual([]);
    expect(result.targetSnapshot.instances[0]).toEqual({
      ...f.owner,
      position: { ...f.owner.position, y: expect.closeTo(1.5, 8) },
    });
    expect(result.audit[0]).toMatchObject({
      rule: 'embedded-footprint',
      baseClearance: expect.any(Number),
    });
    expect(f.context).toEqual(before);
    expect(f.target.terrain!.supports).toHaveLength(1);
  });

  it('keeps the base buried while the whole unchanged prism follows a steeper footprint', () => {
    const f = fixture();
    const grid = f.target.terrain!.grid;
    grid.heights = grid.heights.map((y, i) => y + (i % grid.columns) - 10);
    grid.bottom = -50;
    const result = planStaticTerrainPoses(f.context, f.rules);
    expect(result.issues).toEqual([]);
    expect(result.audit[0]).toMatchObject({
      rule: 'embedded-footprint',
      baseClearance: expect.closeTo(0.3, 8),
      targetRoofClearance: expect.any(Number),
    });
    const audit = result.audit[0] as {
      targetRoofClearance: number;
      sourceBaseBurial: number;
      baseClearance: number;
      loweringMetres: number;
    };
    expect(audit.targetRoofClearance).toBeGreaterThan(0);
    expect(audit.sourceBaseBurial).toBeCloseTo(1.1787867965, 8);
    expect(audit.loweringMetres).toBeGreaterThan(0);
  });

  it('uses existing deep plinth reserve to preserve a roof that minimum-to-minimum anchoring would bury', () => {
    const f = fixture();
    f.owner.position.y = -3;
    const grid = f.target.terrain!.grid;
    grid.heights = grid.heights.map((y, i) => y + (i % grid.columns) - 10);
    grid.bottom = -50;
    const result = planStaticTerrainPoses(f.context, f.rules);
    expect(result.issues).toEqual([]);
    const audit = result.audit[0] as {
      preferredY: number;
      afterY: number;
      loweringMetres: number;
      sourceBaseBurial: number;
      targetBaseBurial: number;
      sourceRoofClearance: number;
      targetRoofClearance: number;
    };
    expect(audit.afterY).toBe(audit.preferredY);
    expect(audit.loweringMetres).toBe(0);
    expect(audit.targetRoofClearance).toBeCloseTo(audit.sourceRoofClearance, 8);
    expect(audit.targetBaseBurial).toBeGreaterThanOrEqual(0.3);
    expect(audit.targetBaseBurial).toBeLessThan(audit.sourceBaseBurial);
  });

  it('keeps an accepted shallow source burial instead of requiring an additional 0.3 metres', () => {
    const f = fixture();
    f.owner.position.y = 0.6;
    const grid = f.target.terrain!.grid;
    grid.heights = grid.heights.map((y, i) => y + (i % grid.columns) - 10);
    grid.bottom = -50;
    const result = planStaticTerrainPoses(f.context, f.rules);
    expect(result.issues).toEqual([]);
    const audit = result.audit[0] as {
      sourceBaseBurial: number;
      minimumRequiredBurial: number;
      targetBaseBurial: number;
    };
    expect(audit.sourceBaseBurial).toBeLessThan(0.3);
    expect(audit.minimumRequiredBurial).toBe(audit.sourceBaseBurial);
    expect(audit.targetBaseBurial).toBeCloseTo(audit.sourceBaseBurial, 8);
  });

  it('requires an explicit positive minimum burial policy', () => {
    const f = fixture();
    if (f.rules.models[0].policy.kind !== 'embedded-footprint')
      throw new Error('Expected embedded policy');
    f.rules.models[0].policy.minimumBurialMetres = 0;
    expect(planStaticTerrainPoses(f.context, f.rules).issues[0].message).toContain(
      'minimum embedded burial',
    );
  });

  it('blocks an excessive relief increase that would bury the roof', () => {
    const f = fixture();
    const grid = f.target.terrain!.grid;
    grid.heights = grid.heights.map((y, i) => y + ((i % grid.columns) - 10) * 3);
    grid.bottom = -50;
    const result = planStaticTerrainPoses(f.context, f.rules);
    expect(result.issues).toEqual([
      expect.objectContaining({
        entityId: f.owner.entityId,
        message: expect.stringContaining('Target embedded model roof'),
      }),
    ]);
    expect(result.targetSnapshot.instances[0]).toEqual(f.owner);
  });

  it('rejects a pre-existing exposed base and changed model geometry', () => {
    const exposed = fixture();
    exposed.owner.position.y = sampleTerrain(exposed.source.terrain!.grid, 0, 0)!.height + 1;
    expect(planStaticTerrainPoses(exposed.context, exposed.rules).issues[0].message).toContain(
      'Source embedded model base',
    );
    const changed = fixture();
    changed.target.definition.buildingAssets[assetId].bounds.max.y += 1;
    expect(planStaticTerrainPoses(changed.context, changed.rules).issues[0].message).toContain(
      'unchanged model geometry',
    );
  });

  it('leaves disabled saved boxes untouched and never adds runtime placement eligibility', () => {
    const f = fixture();
    f.owner.enabled = false;
    const result = planStaticTerrainPoses(f.context, f.rules);
    expect(result.issues).toEqual([]);
    expect(result.targetSnapshot.instances[0]).toEqual(f.owner);
    if (f.target.terrain?.formatVersion !== 2) throw new Error('Expected terrain v2');
    expect(f.target.terrain.placementModels?.some((m) => m.assetId === assetId)).toBe(false);
  });

  it('derives migration policies only when the committed plain prism reproduces both releases', async () => {
    const f = fixture();
    const policies = await readRingEmbeddedFootprintPolicies(
      f.source,
      f.target,
      join(temporary, 'embedded'),
    );
    expect(policies).toEqual(f.rules.models);
    f.target.definition.buildingAssets[assetId].bounds.max.y += 1;
    await expect(
      readRingEmbeddedFootprintPolicies(f.source, f.target, join(temporary, 'embedded')),
    ).rejects.toThrow('differs from its committed recipe');
  });
});
