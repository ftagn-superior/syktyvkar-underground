import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  canonicalJson,
  validateWorldModelCatalog,
  validateWorldModelCatalogIndex,
  validateWorldPlacementPolicy,
  worldModelCatalogIdentity,
  type WorldManifest,
  type WorldModelCatalog,
  type WorldPlacementPolicy,
} from '@su/contracts';
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
const digest = (input: string) => createHash('sha256').update(input).digest('hex');

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
        ...(index.placementPolicy ? { placementPolicy: true } : {}),
      }) ||
    digest(canonicalJson(worldModelCatalogIdentity(catalog))) !== catalog.catalogVersion
  )
    throw new Error('World model catalog version/release mismatch');
  return catalog;
}

/** Missing legacy index means disabled; explicitly enabled incomplete artifacts fail startup. */
export async function readWorldPlacementPolicy(
  directory: string,
  manifest: WorldManifest,
  assetReleaseVersion: string,
): Promise<WorldPlacementPolicy | undefined> {
  let json: unknown;
  try {
    json = await readJson(resolve(directory, 'index.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const index = validateWorldModelCatalogIndex(json);
  if (!index.placementPolicy) return;
  const policy = validateWorldPlacementPolicy(
    await readJson(resolve(directory, 'placement-policy.json')),
  );
  if (
    policy.worldId !== manifest.worldId ||
    policy.worldId !== index.worldId ||
    policy.assetReleaseVersion !== assetReleaseVersion ||
    policy.assetReleaseVersion !== index.assetReleaseVersion
  )
    throw new Error(`World ${manifest.worldId}: placement policy version/release mismatch`);
  return policy;
}
