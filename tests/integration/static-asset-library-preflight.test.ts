import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  staticAssetLibraryHash,
  validateStaticAssetRemapRules,
  type StaticAssetRemapRules,
} from '../../packages/world-release/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { assetRemapLibraryIssues } from '../../apps/server/src/layout/asset-remap.js';
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
    await buildWorld('content/worlds/ring-block/world.json', directory);
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
    expect(release.metadata.assetReleaseVersion).toBe(rules.targetAssetReleaseVersion);
    expect(staticAssetLibraryHash(rules, release.manifest.assets)).toBe(rules.targetLibraryHash);
    expect(Object.keys(rules.vegetation).length).toBeGreaterThan(0);
    expect(assetRemapLibraryIssues(rules, release)).toEqual([]);
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
