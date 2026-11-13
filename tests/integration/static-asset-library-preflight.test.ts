import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabasePool } from '../../apps/server/src/database.js';
import {
  staticAssetLibraryHash,
  validateStaticAssetRemapRules,
  type StaticAssetRemapRules,
} from '../../packages/world-release/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { readWorldModelCatalog } from '../../tools/world-build/src/model-catalog.js';
import {
  assetRemapLibraryIssues,
  migrateStaticAssets,
} from '../../apps/server/src/layout/asset-remap.js';
import { WorldOwnership } from '../../apps/server/src/world-ownership.js';
import { reviewedLightingFlatRelease } from '../helpers/reviewed-ring-lighting.js';
import {
  readAuthoringRelease,
  type AuthoringRelease,
} from '../../apps/server/src/layout/release.js';

describe('compiled static-library migration preflight', () => {
  let directory: string;
  let release: AuthoringRelease;
  let rules: StaticAssetRemapRules;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'su-static-library-preflight-'));
    await buildWorld('content/worlds/ring-block/world.json', directory, { terrainRelease: false });
    release = await readAuthoringRelease(directory);
    const input: unknown = JSON.parse(
      await readFile('content/migrations/ring-block/static-library-v1.json', 'utf8'),
    );
    validateStaticAssetRemapRules(input);
    rules = input;
  }, 60_000);
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('accepts the actual ring-block GLB Float32 bounds, release hash, library checksum and section physics', () => {
    expect(release.metadata.assetReleaseVersion).toBe(
      reviewedLightingFlatRelease.assetReleaseVersion,
    );
    expect(staticAssetLibraryHash(rules, release.manifest.assets)).toBe(
      reviewedLightingFlatRelease.libraryHash,
    );
    expect(rules.targetAssetReleaseVersion).toBe(
      '4972394673ec2847e880e4b1262f937cc88a59c1366408af9801104ba915e0c3',
    );
    expect(rules.targetLibraryHash).toBe(
      'b7be9e7efc2597b927eaacbfcb84928332dec525c25c7c47d78dd435db722db3',
    );
    expect(Object.keys(rules.vegetation).length).toBeGreaterThan(0);
    expect(assetRemapLibraryIssues(rules, release)).toEqual([]);
  });

  it('rejects historical migration approval for the lighting release before any database access', async () => {
    const pool = createDatabasePool('postgresql://unused@127.0.0.1/unused');
    const connect = vi.spyOn(pool, 'connect').mockImplementation(() => {
      throw new Error('Unexpected database access');
    });
    const ownership = new WorldOwnership(pool, 'ring-block', 'unconnected-preflight');
    try {
      await expect(
        migrateStaticAssets(directory, ownership, rules, { dryRun: true }),
      ).rejects.toThrow('Asset remap target release differs from the built release');
      await expect(
        migrateStaticAssets(
          directory,
          ownership,
          {
            ...rules,
            targetAssetReleaseVersion: release.metadata.assetReleaseVersion,
          },
          { dryRun: true },
        ),
      ).rejects.toThrow('Asset remap target library checksum differs from the built release');
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await pool.end();
    }
  });

  it('maps authoring cards to every runtime model while keeping ground tiles in one card', async () => {
    const catalog = await readWorldModelCatalog(
      join(directory, 'model-catalog'),
      release.manifest,
      release.metadata.assetReleaseVersion,
    );
    expect(Object.keys(catalog.models)).toHaveLength(222);
    expect(catalog.models['ring-block-ground'].sourceKind).toBe('ground');
    expect(catalog.models['ring-block-ground'].runtimeAssetIds).toHaveLength(40);
    expect(catalog.models['tree-birch-small'].runtimeAssetIds).toEqual(['tree-birch-small']);
    expect(release.manifest.assets['tree-birch-small'].modelFile).toBeUndefined();
    expect(
      Object.values(catalog.models)
        .flatMap((model) => model.runtimeAssetIds)
        .sort(),
    ).toEqual(Object.keys(release.manifest.assets).sort());
    expect(Object.keys(release.manifest.files).some((file) => file.includes('model-catalog'))).toBe(
      false,
    );
  });

  it('allows only tiny coordinate rounding and independently rejects actual dimension changes over ten percent', () => {
    const [source, planting] = Object.entries(rules.vegetation)[0];
    const assetId = rules.assetMap[source];
    const rounded = structuredClone(release);
    rounded.manifest.assets[assetId].bounds.min.x += 1e-6;
    rounded.manifest.assets[assetId].bounds.max.x += 1e-6;
    expect(assetRemapLibraryIssues(rules, rounded)).toEqual([]);
    rounded.manifest.assets[assetId].bounds.max.x += 0.01;
    expect(
      assetRemapLibraryIssues(rules, rounded).some((issue) => issue.kind === 'vegetation-bounds'),
    ).toBe(true);
    const tooWide = structuredClone(release);
    const actual = tooWide.manifest.assets[assetId].bounds;
    actual.max.x = actual.min.x + (planting.bounds.max.x - planting.bounds.min.x) * 1.11;
    expect(
      assetRemapLibraryIssues(rules, tooWide).some(
        (issue) => issue.kind === 'vegetation-tolerance',
      ),
    ).toBe(true);
  });
});
