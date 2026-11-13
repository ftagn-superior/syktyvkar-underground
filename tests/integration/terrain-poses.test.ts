import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initialItemState, type TerrainGrid } from '../../packages/contracts/src/index.js';
import type {
  FoundationSupportRuleV2,
  TerrainPrivateDataV2,
} from '../../packages/terrain-build/src/private-data.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import {
  readAuthoringRelease,
  type AuthoringRelease,
} from '../../apps/server/src/layout/release.js';
import type { TerrainMigrationContext } from '../../apps/server/src/layout/terrain-migration.js';
import {
  planStaticTerrainPoses,
  prepareTerrainPoses,
  type TerrainPoseRules,
} from '../../apps/server/src/layout/terrain-poses.js';

let directory: string;
let release: AuthoringRelease;
const support: FoundationSupportRuleV2 = {
  kind: 'foundation-v2',
  assetId: 'house-a',
  components: [
    {
      outline: [
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
      ],
    },
  ],
  jointY: 0,
  clearance: 0.1,
  burial: 0.05,
  color: '#888888',
};
function grid(height = 0, spacing = 2): TerrainGrid {
  const count = 40 / spacing + 1;
  return {
    formatVersion: 1,
    origin: { x: -20, z: -20 },
    spacing,
    columns: count,
    rows: count,
    heights: Array(count ** 2).fill(height),
    bottom: -2,
  };
}
function terrain(height = 0): TerrainPrivateDataV2 {
  return {
    formatVersion: 2,
    generatorVersion: 'terrain-build/2',
    worldId: 'physics-lab',
    grid: grid(height),
    supports: [structuredClone(support)],
  };
}
function fixture() {
  const sourceRelease = structuredClone(release);
  const targetRelease = structuredClone(release);
  targetRelease.terrain = terrain(1);
  targetRelease.metadata.assetReleaseVersion = 'a'.repeat(64);
  targetRelease.definition.entities.find((e) => e.entityId === 'ground-01')!.position.y += 1;
  targetRelease.definition.spawnPoints.forEach((p) => {
    p.y += 1;
  });
  const sourceSnapshot = {
    formatVersion: 1 as const,
    worldId: release.definition.worldId,
    assetReleaseVersion: release.metadata.assetReleaseVersion,
    seedVersion: release.metadata.seedVersion,
    revision: 47,
    instances: structuredClone(release.seed),
  };
  const owner = sourceSnapshot.instances[0];
  owner.position = { x: 0, y: 0.3, z: 0 };
  owner.instanceRevision = 31;
  sourceSnapshot.instances[1].enabled = false;
  const sourceWorld = structuredClone(sourceRelease.definition);
  sourceWorld.buildings = sourceSnapshot.instances
    .filter((i) => i.enabled)
    .map(({ enabled: _e, instanceRevision: _r, ...i }) => structuredClone(i));
  const context: TerrainMigrationContext = {
    sourceRelease,
    targetRelease,
    sourceSnapshot,
    sourceWorld,
    sourceItems: [],
    sourcePlayers: [],
  };
  const rules: TerrainPoseRules = {
    formatVersion: 1,
    algorithmVersion: 'terrain-poses/1',
    sourceFlatGroundY: 0,
    sourceGroundIds: ['ground-01'],
    targetGroundIds: ['ground-01'],
    models: [{ assetId: 'house-a', policy: { kind: 'foundation', maximumVisibleHeight: 5 } }],
  };
  return { context, rules, owner };
}
function withoutY(value: ReturnType<typeof fixture>['owner']) {
  const copy = structuredClone(value);
  copy.position.y = 0;
  return copy;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-terrain-poses-'));
  await buildWorld('content/worlds/physics-lab/world.json', directory);
  release = await readAuthoringRelease(directory);
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('saved static terrain pose planning', () => {
  it('preserves the saved offset and all non-Y fields while introducing a foundation', () => {
    const { context, rules, owner } = fixture();
    const before = structuredClone(context);
    const result = planStaticTerrainPoses(context, rules);
    expect(result.issues).toEqual([]);
    expect(result.targetSnapshot.instances[0].position.y).toBeCloseTo(1.4, 8);
    expect(withoutY(result.targetSnapshot.instances[0])).toEqual(withoutY(owner));
    expect(context).toEqual(before);
    expect(result.targetSnapshot.assetReleaseVersion).toBe(
      context.targetRelease.metadata.assetReleaseVersion,
    );
    expect(result.targetSnapshot.seedVersion).toBe(context.sourceSnapshot.seedVersion);
    expect(result.targetSnapshot.revision).toBe(context.sourceSnapshot.revision);
  });

  it('uses the actual source foundation rule when its joint and footprint differ', () => {
    const { context, rules } = fixture();
    context.sourceRelease.terrain = terrain(0);
    context.sourceRelease.terrain.supports[0].jointY = -0.2;
    context.sourceRelease.terrain.supports[0].components = [
      {
        outline: [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ],
      },
    ];
    context.sourceSnapshot.instances[0].position.y = 0.55;
    const result = planStaticTerrainPoses(context, rules);
    expect(result.issues).toEqual([]);
    // Source minimum .3, saved clearance .25, target minimum 1.1.
    expect(result.targetSnapshot.instances[0].position.y).toBeCloseTo(1.35, 8);
  });

  it('does not silently erase a negative source offset', () => {
    const { context, rules } = fixture();
    context.sourceSnapshot.instances[0].position.y = -0.005;
    const result = planStaticTerrainPoses(context, rules);
    expect(result.issues[0].message).toContain('below its declared support');
    expect(result.targetSnapshot.instances[0].position.y).toBe(-0.005);
  });

  it('does not infer a source footprint from a changed target model', () => {
    const { context, rules } = fixture();
    context.targetRelease.definition.buildingAssets['house-a'].colliders[0].position.y += 0.1;
    expect(planStaticTerrainPoses(context, rules).issues[0].message).toContain('changed model');
  });

  it('preserves disabled rows even when their old height cannot support an enabled owner', () => {
    const { context, rules, owner } = fixture();
    owner.enabled = false;
    owner.position.y = -4;
    rules.models = [];
    const result = planStaticTerrainPoses(context, rules);
    expect(result.issues).toEqual([]);
    expect(result.targetSnapshot.instances).toEqual(context.sourceSnapshot.instances);
    expect(result.audit).toEqual(
      context.sourceSnapshot.instances.map((i) =>
        expect.objectContaining({ entityId: i.entityId, rule: 'disabled-preserved' }),
      ),
    );
  });

  it('enforces maximum visible foundation height with the saved elevated offset', () => {
    const { context, rules } = fixture();
    rules.models[0].policy = { kind: 'foundation', maximumVisibleHeight: 0.2 };
    expect(planStaticTerrainPoses(context, rules).issues[0].message).toContain(
      'exceeds authored limit',
    );
    expect(planStaticTerrainPoses(context, rules).targetSnapshot.instances[0].position.y).toBe(0.3);
  });

  it.each(['absolute', 'ground-anchor', 'unsupported'] as const)(
    'blocks %s policy conflicting with a persistent foundation default',
    (kind) => {
      const { context, rules } = fixture();
      rules.overrides = [
        {
          entityId: 'building-a',
          assetId: 'house-a',
          policy:
            kind === 'ground-anchor'
              ? {
                  kind,
                  anchor: { x: 0, y: 0, z: 0 },
                  contactRadius: 0.2,
                  maximumTerrainReliefMetres: 0.1,
                }
              : { kind, reason: 'explicit instance exception' },
        },
      ];
      expect(planStaticTerrainPoses(context, rules).issues[0].message).toContain(
        'persistent no-support override',
      );
    },
  );

  it('keeps an explicitly absolute owner unchanged when there is no implicit foundation', () => {
    const { context, rules, owner } = fixture();
    owner.position.y = 3;
    context.targetRelease.terrain!.supports = [];
    rules.overrides = [
      {
        entityId: owner.entityId,
        assetId: owner.assetId,
        policy: { kind: 'absolute', reason: 'intentional elevated passage' },
      },
    ];
    const result = planStaticTerrainPoses(context, rules);
    expect(result.issues).toEqual([]);
    expect(result.targetSnapshot.instances[0]).toEqual(owner);
    expect(result.audit[0]).toMatchObject({ rule: 'absolute' });
  });

  it('blocks newly buried absolute geometry while accepting unchanged terrain contacts', () => {
    const { context, rules, owner } = fixture();
    context.targetRelease.terrain!.supports = [];
    rules.models[0].policy = { kind: 'absolute', reason: 'fixed bridge supports' };
    const blocked = planStaticTerrainPoses(context, rules);
    expect(blocked.issues[0].message).toContain('may intersect an absolute owner');
    expect(blocked.targetSnapshot.instances[0]).toEqual(owner);
    context.targetRelease.terrain!.grid.heights.fill(0);
    owner.position.y = 0;
    expect(planStaticTerrainPoses(context, rules).issues).toEqual([]);
  });

  it('transfers the actual rotated local anchor and preserves its vertical offset', () => {
    const { context, rules, owner } = fixture();
    context.targetRelease.terrain!.supports = [];
    owner.rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    const g = context.targetRelease.terrain!.grid;
    g.heights = g.heights.map(
      (_, i) => 1 + (g.origin.z + Math.floor(i / g.columns) * g.spacing) * 0.05,
    );
    rules.models[0].policy = {
      kind: 'ground-anchor',
      anchor: { x: 2, y: -0.1, z: 0 },
      contactRadius: 0.5,
      maximumTerrainReliefMetres: 0.05,
    };
    const result = planStaticTerrainPoses(context, rules);
    expect(result.issues).toEqual([]);
    expect(result.targetSnapshot.instances[0].position.y).toBeCloseTo(1.2, 8);
    expect(withoutY(result.targetSnapshot.instances[0])).toEqual(withoutY(owner));
  });

  it('accepts an exact-flat anchor limit and rejects a contact patch crossing the grid boundary', () => {
    const { context, rules, owner } = fixture();
    context.targetRelease.terrain!.supports = [];
    rules.models[0].policy = {
      kind: 'ground-anchor',
      anchor: { x: 0, y: 0, z: 0 },
      contactRadius: 0.5,
      maximumTerrainReliefMetres: 0,
    };
    expect(planStaticTerrainPoses(context, rules).issues).toEqual([]);
    owner.position.x = 19.8;
    expect(planStaticTerrainPoses(context, rules).issues[0].message).toContain(
      'outside the terrain grid',
    );
  });

  it('plants the whole minimum-datum root plane below the high side instead of floating over the low side', () => {
    const { context, rules, owner } = fixture();
    context.targetRelease.terrain!.supports = [];
    owner.position.y = 0;
    const g = context.targetRelease.terrain!.grid;
    g.heights = g.heights.map((_, i) => 1 + (g.origin.x + (i % g.columns) * g.spacing) * 0.04);
    rules.models[0].policy = {
      kind: 'ground-anchor',
      anchor: { x: 0, y: 0, z: 0 },
      contactRadius: 1,
      maximumTerrainReliefMetres: 0.1,
    };
    const atAnchor = planStaticTerrainPoses(context, rules);
    expect(atAnchor.issues).toEqual([]);
    expect(atAnchor.targetSnapshot.instances[0].position.y).toBeCloseTo(1, 8);
    rules.models[0].policy.contactDatum = 'minimum';
    const planted = planStaticTerrainPoses(context, rules);
    expect(planted.issues).toEqual([]);
    expect(planted.targetSnapshot.instances[0].position.y).toBeCloseTo(0.96, 8);
    expect(planted.audit[0]).toMatchObject({
      contactDatum: 'minimum',
      sourceHeight: 0,
      preservedOffset: 0,
    });
    const low = 0.96,
      high = 1.04,
      rootY = planted.targetSnapshot.instances[0].position.y;
    expect(rootY).toBeLessThanOrEqual(low + 1e-8);
    expect(high - rootY).toBeLessThanOrEqual(0.1);
  });

  it('preserves a saved minimum-relative offset using both source and target contact patches', () => {
    const { context, rules, owner } = fixture();
    context.sourceRelease.terrain = terrain(0);
    context.sourceRelease.terrain.supports = [];
    context.targetRelease.terrain!.supports = [];
    for (const [g, base, slope] of [
      [context.sourceRelease.terrain.grid, 0.4, 0.02],
      [context.targetRelease.terrain!.grid, 1, 0.04],
    ] as const)
      g.heights = g.heights.map(
        (_, i) => base + (g.origin.x + (i % g.columns) * g.spacing) * slope,
      );
    // Local anchor is 0.2 below the origin: .38 source minimum + .15 saved offset.
    owner.position.y = 0.73;
    rules.models[0].policy = {
      kind: 'ground-anchor',
      anchor: { x: 0, y: -0.2, z: 0 },
      contactRadius: 1,
      maximumTerrainReliefMetres: 0.1,
      contactDatum: 'minimum',
    };
    const result = planStaticTerrainPoses(context, rules);
    expect(result.issues).toEqual([]);
    expect(result.targetSnapshot.instances[0].position.y).toBeCloseTo(1.31, 8);
    expect(result.audit[0]).toMatchObject({
      contactDatum: 'minimum',
      preservedOffset: expect.closeTo(0.15, 8),
      sourceHeight: expect.closeTo(0.38, 8),
      targetHeight: expect.closeTo(0.96, 8),
    });
    rules.models[0].policy.maximumTerrainReliefMetres = 0.05;
    expect(planStaticTerrainPoses(context, rules).issues[0].message).toContain('relief exceeds');
  });

  it('rejects ground relief that cannot support an anchored object', () => {
    const { context, rules } = fixture();
    context.targetRelease.terrain!.supports = [];
    const g = context.targetRelease.terrain!.grid;
    g.heights[10 * g.columns + 10] = 1.5;
    rules.models[0].policy = {
      kind: 'ground-anchor',
      anchor: { x: 0, y: 0, z: 0 },
      contactRadius: 1,
      maximumTerrainReliefMetres: 0.1,
    };
    expect(planStaticTerrainPoses(context, rules).issues[0].message).toContain('relief exceeds');
  });

  it('does not reuse a target anchor as the reference for a changed source model', () => {
    const { context, rules } = fixture();
    context.targetRelease.terrain!.supports = [];
    context.targetRelease.definition.buildingAssets['house-a'].bounds.min.y -= 0.2;
    rules.models[0].policy = {
      kind: 'ground-anchor',
      anchor: { x: 0, y: -0.2, z: 0 },
      contactRadius: 1,
      maximumTerrainReliefMetres: 0.1,
    };
    expect(planStaticTerrainPoses(context, rules).issues[0].message).toContain(
      'source anchor reference',
    );
  });

  it('detects a source-grid peak absent from all target-grid envelope vertices', () => {
    const { context, rules } = fixture();
    context.sourceRelease.terrain = terrain(0);
    context.sourceRelease.terrain.supports = [];
    context.sourceRelease.terrain.grid.heights[10 * 21 + 10] = 0.5;
    context.targetRelease.terrain!.grid = grid(0, 40);
    context.targetRelease.terrain!.supports = [];
    rules.models[0].policy = { kind: 'unsupported', reason: 'needs an explicit support rule' };
    expect(planStaticTerrainPoses(context, rules).issues[0].message).toBe(
      'needs an explicit support rule',
    );
  });

  it('accepts equal affine surfaces represented by different grid resolutions', () => {
    const { context, rules, owner } = fixture();
    context.sourceRelease.terrain = terrain(0);
    context.sourceRelease.terrain.supports = [];
    context.targetRelease.terrain!.grid = grid(0, 5);
    context.targetRelease.terrain!.supports = [];
    for (const g of [context.sourceRelease.terrain.grid, context.targetRelease.terrain!.grid])
      g.heights = g.heights.map(
        (_, i) =>
          0.01 * (g.origin.x + (i % g.columns) * g.spacing) +
          0.02 * (g.origin.z + Math.floor(i / g.columns) * g.spacing),
      );
    rules.models[0].policy = { kind: 'unsupported', reason: 'no approved terrain adaptation' };
    const result = planStaticTerrainPoses(context, rules);
    expect(result.issues).toEqual([]);
    expect(result.targetSnapshot.instances[0]).toEqual(owner);
  });

  it('rejects a private grid registered against the wrong world coordinates', () => {
    const { context, rules } = fixture();
    context.sourceRelease.terrain = terrain(0);
    context.sourceRelease.terrain.grid.origin.x += 1;
    expect(() => planStaticTerrainPoses(context, rules)).toThrow('source terrain grid reference');
    context.sourceRelease.terrain = undefined;
    context.targetRelease.terrain!.grid.origin.z += 1;
    expect(() => planStaticTerrainPoses(context, rules)).toThrow('target terrain grid reference');
  });

  it('proves coverage by several flat slabs and rejects a gap between them', () => {
    const { context, rules } = fixture();
    const ground = context.sourceWorld.entities.find((e) => e.entityId === 'ground-01')!;
    context.sourceWorld.entities = context.sourceWorld.entities.filter((e) => e !== ground);
    context.sourceWorld.entities.push(
      ...[-1, 1].map((side) => ({
        ...structuredClone(ground),
        entityId: `ground-${side}`,
        position: { x: side * 10, y: -0.5, z: 0 },
        size: { x: 20, y: 1, z: 40 },
      })),
    );
    rules.sourceGroundIds = ['ground--1', 'ground-1'];
    expect(planStaticTerrainPoses(context, rules).issues).toEqual([]);
    context.sourceWorld.entities.at(-1)!.position.x += 0.02;
    expect(() => planStaticTerrainPoses(context, rules)).toThrow('does not cover the world');
  });

  it('rejects a false flat height and unknown ground IDs before transforming any pose', () => {
    const { context, rules } = fixture();
    rules.sourceFlatGroundY = 0.1;
    expect(() => planStaticTerrainPoses(context, rules)).toThrow('different surface');
    rules.sourceFlatGroundY = 0;
    rules.sourceGroundIds.push('missing-ground');
    expect(() => planStaticTerrainPoses(context, rules)).toThrow(
      'Unknown or editable source ground',
    );
    rules.sourceGroundIds = ['ground-01'];
    rules.targetGroundIds = ['building-a'];
    expect(() => planStaticTerrainPoses(context, rules)).toThrow(
      'Unknown or editable target ground',
    );
  });

  it('combines the saved static snapshot with independent item-pose planning', async () => {
    const { context, rules } = fixture();
    // Disabled rows stay unchanged; use an empty enabled scene to isolate the
    // real publication/item integration from this fixture's arbitrary houses.
    context.sourceSnapshot.instances.forEach((i) => {
      i.enabled = false;
    });
    context.sourceWorld.buildings = [];
    context.sourceItems = [
      initialItemState({
        seedId: 'saved-item',
        typeId: 'wooden-crate',
        position: { x: 0, y: 0.52, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      }),
    ];
    const result = await prepareTerrainPoses(context, rules);
    expect(result.issues).toEqual([]);
    expect(result.targetItems[0].position.y).toBeCloseTo(1.52, 4);
    expect(result.targetItems[0].safePose.position.y).toBeCloseTo(1.52, 4);
    expect(result.targetSnapshot.instances).toEqual(context.sourceSnapshot.instances);
    expect(result.audit).toMatchObject({
      statics: expect.any(Array),
      items: [
        expect.objectContaining({ pose: 'current' }),
        expect.objectContaining({ pose: 'safePose' }),
      ],
    });
  });

  it('returns publication failures as blocking plan diagnostics', async () => {
    const { context, rules } = fixture();
    context.sourceSnapshot.instances.forEach((i) => {
      i.enabled = false;
    });
    context.sourceWorld.buildings = [];
    context.targetRelease.definition.spawnPoints[0].y = 0;
    const result = await prepareTerrainPoses(context, rules);
    expect(result.issues).toEqual([
      expect.objectContaining({
        kind: 'target-geometry',
        message: expect.stringContaining('spawn intersects ground-01'),
      }),
    ]);
    expect(result.targetItems).toEqual(context.sourceItems);
  });
});
