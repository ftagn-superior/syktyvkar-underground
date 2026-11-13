import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  validateWorldModelCategories,
  validateWorldModelDescriptor,
  validateWorldModelCatalog,
  validateWorldModelCatalogIndex,
  worldModelCatalogIdentity,
  type WorldManifest,
  type WorldModelCatalog,
  type WorldModelCatalogEntry,
  type WorldModelDescriptor,
} from '@su/contracts';
import { hash, jsonBytes } from '@su/world-release';

const readJson = async (path: string | URL): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8'));
const categoriesFile = new URL('../../../content/buildings/categories.json', import.meta.url);
export interface WorldModelSources {
  categories: WorldModelCatalog['categories'];
  models: Record<string, { descriptor: WorldModelDescriptor; path: string }>;
}
export async function readWorldModelSources(catalogPath: string): Promise<WorldModelSources> {
  const categories = validateWorldModelCategories(await readJson(categoriesFile)).categories;
  const catalog: any = await readJson(catalogPath);
  if (
    catalog?.formatVersion !== 1 ||
    !catalog.assets ||
    typeof catalog.assets !== 'object' ||
    Array.isArray(catalog.assets)
  )
    throw new Error(`Invalid building asset catalog: ${catalogPath}`);
  const models: WorldModelSources['models'] = {};
  for (const [assetId, file] of Object.entries(catalog.assets)) {
    if (
      typeof file !== 'string' ||
      file.includes('\\') ||
      !file.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    )
      throw new Error(`Invalid model descriptor path: ${assetId}`);
    const path = resolve(dirname(catalogPath), file);
    try {
      const descriptor = validateWorldModelDescriptor(await readJson(path), assetId, categories);
      await readFile(resolve(dirname(path), descriptor.source.file));
      if (descriptor.source.kind === 'glb')
        await readFile(resolve(dirname(path), descriptor.source.collisionFile!));
      models[assetId] = { descriptor, path };
    } catch (error) {
      throw new Error(`World model ${assetId} (${path}): ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  if (Object.keys(models).length === 0 || Object.keys(models).length > 10_000)
    throw new Error(`Invalid model count: ${catalogPath}`);
  return { categories, models };
}

export function createWorldModelCatalog(
  sources: WorldModelSources,
  manifest: WorldManifest,
  assetReleaseVersion: string,
  runtimeAssetIds: Record<string, string[]>,
): WorldModelCatalog {
  const models: Record<string, WorldModelCatalogEntry> = {};
  for (const assetId of Object.keys(sources.models).sort()) {
    const { descriptor } = sources.models[assetId];
    models[assetId] = {
      assetId,
      metadata: { ...descriptor.metadata, tags: [...descriptor.metadata.tags].sort() },
      sourceKind: descriptor.source.kind,
      runtimeAssetIds: [...(runtimeAssetIds[assetId] ?? [])].sort(),
    };
  }
  const catalog: WorldModelCatalog = {
    formatVersion: 1,
    worldId: manifest.worldId,
    assetReleaseVersion,
    catalogVersion: '0'.repeat(64),
    categories: sources.categories,
    models,
  };
  catalog.catalogVersion = hash(canonicalJson(worldModelCatalogIdentity(catalog)));
  return validateWorldModelCatalog(catalog, manifest);
}

/** Separate from immutable layout publications and their identity/cleanup. */
export async function writeWorldModelCatalog(catalog: WorldModelCatalog, directory: string) {
  validateWorldModelCatalog(catalog);
  if (hash(canonicalJson(worldModelCatalogIdentity(catalog))) !== catalog.catalogVersion)
    throw new Error('World model catalog hash mismatch');
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `catalog.${catalog.catalogVersion}.json`);
  const bytes = jsonBytes(catalog);
  try {
    await writeFile(file, bytes, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await readFile(file)).equals(Buffer.from(bytes)))
      throw new Error(`World model catalog file changed: ${file}`);
  }
  const index = {
    formatVersion: 1,
    worldId: catalog.worldId,
    assetReleaseVersion: catalog.assetReleaseVersion,
    catalogVersion: catalog.catalogVersion,
  };
  const temporary = resolve(directory, `.index.${randomUUID()}.tmp`);
  await writeFile(temporary, jsonBytes(index));
  await rename(temporary, resolve(directory, 'index.json'));
}

export async function readWorldModelCatalog(
  directory: string,
  manifest: WorldManifest,
  assetReleaseVersion: string,
): Promise<WorldModelCatalog> {
  const index = validateWorldModelCatalogIndex(await readJson(resolve(directory, 'index.json')));
  const catalog = validateWorldModelCatalog(
    await readJson(resolve(directory, `catalog.${index.catalogVersion}.json`)),
    manifest,
  );
  if (
    catalog.assetReleaseVersion !== assetReleaseVersion ||
    canonicalJson(index) !==
      canonicalJson({
        formatVersion: catalog.formatVersion,
        worldId: catalog.worldId,
        assetReleaseVersion: catalog.assetReleaseVersion,
        catalogVersion: catalog.catalogVersion,
      }) ||
    hash(canonicalJson(worldModelCatalogIdentity(catalog))) !== catalog.catalogVersion
  )
    throw new Error('World model catalog version/release mismatch');
  return catalog;
}
