import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, worldModelCatalogIdentity } from '../../packages/contracts/src/index.js';
import { hash } from '../../packages/world-release/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import {
  readWorldModelSources,
  readWorldModelCatalog,
  writeWorldModelCatalog,
} from '../../tools/world-build/src/model-catalog.js';
import {
  createLayoutPublication,
  readAuthoringRelease,
} from '../../apps/server/src/layout/release.js';

async function withContent(run: (root: string, source: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'su-model-catalog-'));
  try {
    await cp('content', join(root, 'content'), { recursive: true });
    await run(root, join(root, 'content/worlds/physics-lab/world.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n');

describe('published world model catalog', () => {
  it('catalogs all authored descriptors, including unused models, without inventing display data', async () => {
    const paths = new Set<string>();
    for (const path of [
      'content/buildings/catalog.json',
      'content/buildings/ring-block/catalog.json',
      'content/buildings/terrain-lab/catalog.json',
    ]) {
      const sources = await readWorldModelSources(path);
      for (const { descriptor, path: file } of Object.values(sources.models)) {
        expect(descriptor.metadata.name).toBeTruthy();
        expect(descriptor.metadata.description).toBeTruthy();
        paths.add(file);
      }
    }
    async function descriptors(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      return (
        await Promise.all(
          entries.map((entry) =>
            entry.isDirectory()
              ? descriptors(join(directory, entry.name))
              : entry.name === 'asset.json'
                ? [join(directory, entry.name)]
                : [],
          ),
        )
      ).flat();
    }
    const files = await descriptors(join(process.cwd(), 'content/buildings'));
    expect(paths.size).toBe(files.length);
    expect(new Set(files)).toEqual(paths);
  });

  it('changes only catalog identity on card edits and preserves existing live-layout publications', async () =>
    withContent(async (root, source) => {
      const output = join(root, 'release');
      const before = await buildWorld(source, output);
      const releaseBefore = await readAuthoringRelease(output);
      const directory = join(output, 'model-catalog');
      const catalogBefore = await readWorldModelCatalog(
        directory,
        before,
        releaseBefore.metadata.assetReleaseVersion,
      );
      expect(Object.keys(catalogBefore.models)).toHaveLength(4);
      expect(catalogBefore.models['house-remote-a'].runtimeAssetIds).toEqual(['house-remote-a']);
      expect(catalogBefore.catalogVersion).toBe(
        hash(canonicalJson(worldModelCatalogIdentity(catalogBefore))),
      );
      const snapshot = {
        formatVersion: 1 as const,
        worldId: before.worldId,
        assetReleaseVersion: releaseBefore.metadata.assetReleaseVersion,
        seedVersion: releaseBefore.metadata.seedVersion,
        revision: 1,
        instances: releaseBefore.seed,
      };
      const liveBefore = await createLayoutPublication(releaseBefore, snapshot);
      const file = join(root, 'content/buildings/house-a/asset.json');
      const descriptor = await readJson(file);
      descriptor.metadata.name = 'Переименованный тестовый дом';
      descriptor.metadata.description += ' Новое описание для каталога.';
      await writeJson(file, descriptor);
      const after = await buildWorld(source, output);
      const releaseAfter = await readAuthoringRelease(output);
      const catalogAfter = await readWorldModelCatalog(
        directory,
        after,
        releaseAfter.metadata.assetReleaseVersion,
      );
      expect(after).toEqual(before);
      expect(releaseAfter.metadata).toEqual(releaseBefore.metadata);
      expect(catalogAfter.catalogVersion).not.toBe(catalogBefore.catalogVersion);
      expect(catalogAfter.models['house-a'].metadata.name).toBe(descriptor.metadata.name);
      expect(
        await readJson(join(directory, `catalog.${catalogBefore.catalogVersion}.json`)),
      ).toEqual(catalogBefore);
      const liveAfter = await createLayoutPublication(releaseAfter, snapshot);
      expect(liveAfter.hash).toBe(liveBefore.hash);
      expect(liveAfter.publication.manifest).toEqual(liveBefore.publication.manifest);
      expect(liveAfter.publication.payloads).toEqual(liveBefore.publication.payloads);
      await buildWorld(source, output);
      expect(
        await readWorldModelCatalog(directory, after, releaseAfter.metadata.assetReleaseVersion),
      ).toEqual(catalogAfter);
    }));

  it('rejects incomplete unused model cards before publishing a world', async () =>
    withContent(async (root, source) => {
      const file = join(root, 'content/buildings/house-remote-a/asset.json');
      const descriptor = await readJson(file);
      delete descriptor.metadata;
      await writeJson(file, descriptor);
      await expect(buildWorld(source, join(root, 'invalid'))).rejects.toThrow(
        /house-remote-a.*metadata/,
      );
      await expect(readFile(join(root, 'invalid/manifest.json'))).rejects.toThrow();
    }));

  it('detects altered catalog bytes, stale release bindings and inconsistent discovery indexes', async () =>
    withContent(async (root, source) => {
      const output = join(root, 'release');
      const manifest = await buildWorld(source, output);
      const release = await readAuthoringRelease(output);
      const version = release.metadata.assetReleaseVersion;
      const directory = join(output, 'model-catalog');
      const catalog = await readWorldModelCatalog(directory, manifest, version);
      await expect(readWorldModelCatalog(directory, manifest, 'c'.repeat(64))).rejects.toThrow(
        'version/release mismatch',
      );
      const file = join(directory, `catalog.${catalog.catalogVersion}.json`);
      const corrupt = structuredClone(catalog);
      corrupt.models['house-a'].metadata.name = 'Подменённое название';
      await writeJson(file, corrupt);
      await expect(readWorldModelCatalog(directory, manifest, version)).rejects.toThrow(
        'version/release mismatch',
      );
      await expect(writeWorldModelCatalog(catalog, directory)).rejects.toThrow('file changed');
      await writeFile(file, canonicalJson(catalog) + '\n');
      const index = await readJson(join(directory, 'index.json'));
      index.worldId = 'other';
      await writeJson(join(directory, 'index.json'), index);
      await expect(readWorldModelCatalog(directory, manifest, version)).rejects.toThrow(
        'version/release mismatch',
      );
    }));
});
