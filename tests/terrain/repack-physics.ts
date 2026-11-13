import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readAuthoringRelease } from '../../apps/server/src/layout/release.js';
import {
  createWorldPublication,
  writeAuthoringMetadata,
  writeWorldPublication,
  type CompiledWorldAsset,
} from '../../packages/world-release/src/index.js';

/** Explicit transport-only acceptance candidate, written to a distinct authoring directory. */
export async function repackAuthoringPhysics(sourceDirectory: string, outputDirectory: string) {
  if (resolve(sourceDirectory) === resolve(outputDirectory))
    throw new Error('Physics-pack candidate requires a separate output directory');
  const source = await readAuthoringRelease(sourceDirectory);
  const compiled: Record<string, CompiledWorldAsset> = {};
  for (const [id, asset] of Object.entries(source.manifest.assets)) {
    compiled[id] = {
      version: asset.version,
      bounds: asset.bounds,
      physics: source.definition.buildingAssets[id],
      model: asset.modelFile ? await readFile(join(source.directory, asset.modelFile)) : undefined,
      collision: await readFile(join(source.directory, asset.collisionFile)),
      parts: await readFile(join(source.directory, asset.partsFile)),
    };
  }
  const publication = createWorldPublication(source.definition, source.manifest.grid, compiled, {
    physicsPacks: true,
  });
  await writeWorldPublication(publication, outputDirectory);
  await writeAuthoringMetadata(
    source.definition,
    publication.manifest,
    source.metadata.fixedInstanceIds,
    outputDirectory,
    source.metadata.terrain
      ? await readFile(join(source.directory, source.metadata.terrain.file))
      : undefined,
  );
  return readAuthoringRelease(outputDirectory);
}
