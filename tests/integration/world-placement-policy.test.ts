import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../packages/contracts/src/index.js';
import {
  readWorldModelCatalog,
  readWorldPlacementPolicy,
} from '../../packages/world-release/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import {
  readPlacementPolicySource,
  readWorldModelSources,
} from '../../tools/world-build/src/model-catalog.js';
const selected = ['bench-0152a250d22ef0a9', 'fence-short', 'tree-spruce-small'];
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n');
async function fixture(run: (root: string, source: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'su-placement-policy-'));
  try {
    await cp('content', join(root, 'content'), { recursive: true });
    const catalogFile = join(root, 'content/buildings/catalog.json');
    const catalog = await json(catalogFile);
    for (const assetId of selected)
      catalog.assets[assetId] = `ring-block/objects/${assetId}/asset.json`;
    await writeJson(catalogFile, catalog);
    await run(root, join(root, 'content/worlds/physics-lab/world.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
describe('world placement policy build and startup artifacts', () => {
  it('keeps geometry, physics, release and seed identity on policy changes and detects missing enabled artifacts', async () =>
    fixture(async (root, source) => {
      const output = join(root, 'world');
      const before = await buildWorld(source, output);
      const authoringBefore = await json(join(output, 'authoring.json'));
      const directory = join(output, 'model-catalog');
      const catalogBefore = await readWorldModelCatalog(
        directory,
        before,
        authoringBefore.assetReleaseVersion,
      );
      expect(
        await readWorldPlacementPolicy(directory, before, authoringBefore.assetReleaseVersion),
      ).toBeUndefined();
      const world = await json(source);
      world.placementPolicy = 'placement.json';
      await writeJson(source, world);
      await writeJson(join(root, 'content/worlds/physics-lab/placement.json'), {
        formatVersion: 1,
        assetIds: [...selected].reverse(),
      });
      const after = await buildWorld(source, output);
      expect(after).toEqual(before);
      expect(await json(join(output, 'authoring.json'))).toEqual(authoringBefore);
      expect(
        await readWorldModelCatalog(directory, after, authoringBefore.assetReleaseVersion),
      ).toEqual(catalogBefore);
      const policy = await readWorldPlacementPolicy(
        directory,
        after,
        authoringBefore.assetReleaseVersion,
      );
      expect(policy?.assetIds).toEqual([...selected].sort());
      expect(canonicalJson(after)).not.toContain('placementPolicy');
      await expect(readWorldPlacementPolicy(directory, after, 'f'.repeat(64))).rejects.toThrow(
        'release mismatch',
      );
      await rm(join(directory, 'placement-policy.json'));
      await expect(
        readWorldPlacementPolicy(directory, after, authoringBefore.assetReleaseVersion),
      ).rejects.toThrow();
      await buildWorld(source, output);
      delete world.placementPolicy;
      await writeJson(source, world);
      expect(await buildWorld(source, output)).toEqual(before);
      expect(
        await readWorldPlacementPolicy(directory, after, authoringBefore.assetReleaseVersion),
      ).toBeUndefined();
      await expect(readFile(join(directory, 'placement-policy.json'))).rejects.toThrow();
    }));
  it('rejects invalid policies before publishing and names the world and chosen asset', async () =>
    fixture(async (root, source) => {
      const world = await json(source);
      world.placementPolicy = 'placement.json';
      await writeJson(source, world);
      const policyFile = join(root, 'content/worlds/physics-lab/placement.json');
      for (const assetIds of [[], ['missing'], [selected[0], selected[0]], ['house-a']]) {
        await writeJson(policyFile, { formatVersion: 1, assetIds });
        await expect(buildWorld(source, join(root, 'invalid'))).rejects.toThrow(
          /World physics-lab/,
        );
        await expect(readFile(join(root, 'invalid/manifest.json'))).rejects.toThrow();
      }
      const sources = await readWorldModelSources(join(root, 'content/buildings/catalog.json'));
      sources.models[selected[0]].descriptor.source.kind = 'ground';
      await writeJson(policyFile, { formatVersion: 1, assetIds: [selected[0]] });
      await expect(readPlacementPolicySource(source, world, sources)).rejects.toThrow(
        `${selected[0]} is ground`,
      );
      await expect(
        readPlacementPolicySource(
          source,
          { ...world, placementPolicy: '../placement.json' },
          sources,
        ),
      ).rejects.toThrow('invalid placementPolicy path');
    }));
});
