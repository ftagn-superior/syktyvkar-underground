import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATIC_PLACEMENT_ASSET_ID } from '../../packages/contracts/src/index.js';
import { readAuthoringRelease } from '../../apps/server/src/layout/release.js';
import { terrainPoseRules } from '../../tools/world-build/src/terrain-pose-rules.js';
import { buildTerrainPlacementWorld } from '../helpers/terrain-placement-world.js';

let temporary: string;
let source: Awaited<ReturnType<typeof readAuthoringRelease>>;
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'su-terrain-pose-rules-'));
  source = await readAuthoringRelease(await buildTerrainPlacementWorld(temporary));
});
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe('terrain pose rule authoring', () => {
  it('uses verified placement policies and exact ground owners, without a saved layout', () => {
    const target = structuredClone(source);
    target.terrain!.grid.heights = target.terrain!.grid.heights.map((y) => y + 2);
    // Boundaries and generated supports are fixed too, but are not walking ground inputs.
    target.metadata.fixedInstanceIds.push('boundary-west', 'support-house');
    const rules = terrainPoseRules(source, target);
    expect(rules).toEqual({
      formatVersion: 1,
      algorithmVersion: 'terrain-poses/1',
      sourceGroundIds: ['placement-terrain'],
      targetGroundIds: ['placement-terrain'],
      models: [
        {
          assetId: STATIC_PLACEMENT_ASSET_ID,
          policy: { kind: 'foundation', maximumVisibleHeight: 1 },
        },
      ],
    });
    rules.models[0].policy = { kind: 'absolute', reason: 'separate manual review' };
    expect(terrainPoseRules(source, target).models[0].policy.kind).toBe('foundation');
  });

  it('rejects changed model geometry before producing generic migration rules', () => {
    const target = structuredClone(source);
    target.definition.buildingAssets[STATIC_PLACEMENT_ASSET_ID].bounds.max.y += 1;
    expect(() => terrainPoseRules(source, target)).toThrow('unchanged model');
  });

  it('rejects a different coordinate reference and unverified ground declarations', () => {
    const moved = structuredClone(source);
    moved.definition.bounds.min.x -= 1;
    expect(() => terrainPoseRules(source, moved)).toThrow('unchanged X/Z');
    const invalidGround = structuredClone(source);
    if (invalidGround.terrain?.formatVersion !== 2) throw new Error('Expected terrain v2');
    invalidGround.terrain.placementGroundIds = ['some-editable-owner'];
    expect(() => terrainPoseRules(source, invalidGround)).toThrow('immutable ground owner');
  });

  it('requires explicit target policies instead of silently inferring placement from bounds', () => {
    const target = structuredClone(source);
    if (target.terrain?.formatVersion !== 2) throw new Error('Expected terrain v2');
    delete target.terrain.placementModels;
    expect(() => terrainPoseRules(source, target)).toThrow('explicit terrain placement policies');
  });
});
