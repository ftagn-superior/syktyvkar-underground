import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  canonicalJson,
  validateWorldManifest,
  worldManifestIdentity,
  validateWorldPlacementAssets,
  validateBuildingParts,
  loadWorldBundle,
} from '@su/contracts';
import { hash, readWorldPlacementPolicy } from '@su/world-release';
import { WORLDS } from './index.js';
import {
  createWorldModelCatalog,
  readWorldModelCatalog,
  readWorldModelSources,
  readPlacementPolicySource,
} from './model-catalog.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--sources'))
  throw new Error('Usage: pnpm world:catalog:check [--sources]');
const sourceOnly = args.includes('--sources');
const registered = new Set<string>();
for (const worldId of WORLDS) {
  const worldFile = resolve(`content/worlds/${worldId}/world.json`);
  const world = JSON.parse(await readFile(worldFile, 'utf8'));
  const sources = await readWorldModelSources(resolve(dirname(worldFile), world.assetCatalog));
  for (const model of Object.values(sources.models)) registered.add(model.path);
  const policySource = await readPlacementPolicySource(worldFile, world, sources);
  if (!sourceOnly) {
    const directory = resolve(`dist/worlds/${worldId}`);
    const manifest = validateWorldManifest(
      JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')),
    );
    if (hash(canonicalJson(worldManifestIdentity(manifest))) !== manifest.mapVersion)
      throw new Error(`World manifest hash mismatch: ${worldId}`);
    const authoring = JSON.parse(await readFile(resolve(directory, 'authoring.json'), 'utf8'));
    const catalog = await readWorldModelCatalog(
      `dist/model-catalogs/${worldId}`,
      manifest,
      authoring.assetReleaseVersion,
    );
    const expected = createWorldModelCatalog(
      sources,
      manifest,
      authoring.assetReleaseVersion,
      Object.fromEntries(
        Object.entries(catalog.models).map(([id, model]) => [id, model.runtimeAssetIds]),
      ),
      catalog.generatedAssetIds,
    );
    const policy = await readWorldPlacementPolicy(
      `dist/model-catalogs/${worldId}`,
      manifest,
      authoring.assetReleaseVersion,
    );
    if (
      !!policy !== !!policySource ||
      (policy &&
        policySource &&
        canonicalJson([...policy.assetIds].sort()) !==
          canonicalJson([...policySource.assetIds].sort()))
    )
      throw new Error(`Placement policy is stale: ${worldId}. Run pnpm world:build.`);
    if (policy) {
      const readVerified = async (path: string, expectedHash: string) => {
        const bytes = await readFile(resolve(directory, path));
        if (hash(bytes) !== expectedHash)
          throw new Error(`World resource hash mismatch: ${worldId}/${path}`);
        return bytes;
      };
      const definition = await loadWorldBundle(manifest, readVerified);
      const parts = Object.fromEntries(
        await Promise.all(
          policy.assetIds.map(async (assetId) => {
            const path = manifest.assets[assetId].partsFile;
            return [
              assetId,
              validateBuildingParts(
                JSON.parse(
                  new TextDecoder().decode(await readVerified(path, manifest.files[path])),
                ),
              ),
            ];
          }),
        ),
      );
      validateWorldPlacementAssets(
        policy,
        catalog,
        manifest,
        definition,
        parts,
        authoring.fixedInstanceIds,
      );
    }
    if (canonicalJson(expected) !== canonicalJson(catalog))
      throw new Error(`Model catalog is stale: ${worldId}. Run pnpm world:build.`);
  }
  console.log(
    `${worldId}: ${Object.keys(sources.models).length} models, ${sourceOnly ? 'sources' : 'sources and published index'} verified`,
  );
}
async function checkRegistered(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) await checkRegistered(file);
    else if (entry.name === 'asset.json' && !registered.has(file))
      throw new Error(`Unregistered model descriptor: ${file}`);
  }
}
await checkRegistered(resolve('content/buildings'));
