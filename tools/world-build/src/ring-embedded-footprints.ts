import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '@su/contracts';
import { compileGeneratedAsset } from '@su/terrain-build/assets';
import type { AuthoringRelease } from '../../../apps/server/src/layout/release.js';
import type { TerrainPoseRules } from '../../../apps/server/src/layout/terrain-poses.js';
import { generateFootprint, type FootprintRecipe } from './city.js';

/** Migration-only support for the existing expansion prisms. Runtime placement remains disabled.
 * A recipe is accepted only when it independently reproduces both releases' physical model. */
export async function readRingEmbeddedFootprintPolicies(
  source: AuthoringRelease,
  target: AuthoringRelease,
  directory = 'content/buildings/ring-block/expansion',
): Promise<TerrainPoseRules['models']> {
  const models: TerrainPoseRules['models'] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    const descriptor = JSON.parse(await readFile(join(path, 'asset.json'), 'utf8'));
    if (
      descriptor.assetId !== entry.name ||
      descriptor.source?.kind !== 'footprint' ||
      descriptor.source.file !== 'source.json'
    )
      throw new Error(`Unreviewed embedded model descriptor: ${entry.name}`);
    const recipe = JSON.parse(await readFile(join(path, 'source.json'), 'utf8')) as FootprintRecipe;
    if (
      recipe.formatVersion !== 1 ||
      recipe.windows !== false ||
      recipe.sections?.length ||
      recipe.heightScale !== undefined ||
      !Array.isArray(recipe.outline) ||
      !Number.isFinite(recipe.height) ||
      recipe.height <= 0
    )
      throw new Error(`Embedded footprint is not an unchanged plain prism: ${entry.name}`);
    const assetId = descriptor.assetId as string;
    const expected = compileGeneratedAsset(assetId, generateFootprint(assetId, recipe)).physics;
    for (const [label, release] of [
      ['source', source],
      ['target', target],
    ] as const) {
      const asset = release.definition.buildingAssets[assetId];
      if (!asset || canonicalJson(asset) !== canonicalJson(expected))
        throw new Error(`${label} embedded model differs from its committed recipe: ${assetId}`);
    }
    models.push({
      assetId,
      policy: {
        kind: 'embedded-footprint',
        components: [{ outline: structuredClone(recipe.outline) }],
        minimumBurialMetres: 0.3,
      },
    });
  }
  return models;
}
