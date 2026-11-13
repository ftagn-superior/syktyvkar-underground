import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATIC_PLACEMENT_ASSET_ID, type PlaceStaticRequest } from '@su/contracts';
import { buildTerrainPlacementWorld } from '../../../../tests/helpers/terrain-placement-world.js';
import { readAuthoringRelease, type AuthoringRelease } from './release.js';
import { resolveStaticPlacement } from './placement-pose.js';
describe('server terrain placement datum', () => {
  let directory: string, release: AuthoringRelease;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'su-placement-datum-'));
    release = await readAuthoringRelease(await buildTerrainPlacementWorld(directory));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const request = (): PlaceStaticRequest => ({
    operationId: '12345678-1234-1234-1234-123456789abc',
    worldEpoch: 'datum',
    assetReleaseVersion: '1'.repeat(64),
    placementCatalogVersion: '2'.repeat(64),
    assetId: STATIC_PLACEMENT_ASSET_ID,
    expectedLayoutRevision: 1,
    position: { x: 10, z: 10 },
    yawStep: 6,
  });
  function anchored() {
    const authored = structuredClone(release);
    if (authored.terrain?.formatVersion !== 2) throw new Error('v2');
    authored.terrain.supports = [];
    const policy = {
      kind: 'ground-anchor' as const,
      anchor: { x: 0.5, y: 0.2, z: 0.25 },
      contactRadius: 0.5,
      maximumTerrainReliefMetres: 0.02,
      contactDatum: 'minimum' as const,
    };
    authored.terrain.placementModels = [{ assetId: STATIC_PLACEMENT_ASSET_ID, policy }];
    return { authored, policy };
  }
  it('uses the rotated local root and exact minimum over its terrain contact patch', () => {
    const { authored } = anchored();
    const result = resolveStaticPlacement(authored, request());
    // yaw=pi/2 => anchor X=10.25, footprint min X=9.75; terrain=0.5+(X+20)*0.01.
    expect(result.position.y).toBeCloseTo(0.5 + 29.75 * 0.01 - 0.2, 10);
    expect(result.position.x).toBe(10);
    expect(result.position.z).toBe(10);
  });
  it('rejects outside contact footprints, excessive planting relief and missing model policy', () => {
    const { authored, policy } = anchored();
    expect(() =>
      resolveStaticPlacement(authored, { ...request(), position: { x: 19.8, z: 10 } }),
    ).toThrow('footprint leaves terrain');
    policy.maximumTerrainReliefMetres = 0.001;
    expect(() => resolveStaticPlacement(authored, request())).toThrow('planting relief');
    expect(() => resolveStaticPlacement(authored, { ...request(), assetId: 'unknown' })).toThrow(
      'no terrain placement policy',
    );
  });
});
