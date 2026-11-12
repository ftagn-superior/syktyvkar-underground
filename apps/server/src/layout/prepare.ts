import { resolve } from 'node:path';
import { writeWorldPublication } from '@su/world-release';
import { createAuthoritativeWorld } from '@su/simulation/server';
import { ItemStore } from '../items/store.js';
import { WorldOwnership } from '../world-ownership.js';
import { readAuthoringRelease, createLayoutPublication } from './release.js';
import { StaticLayoutStore } from './store.js';

/** All callers keep the same ownership session until the room or offline operation ends. */
export async function prepareLayoutWorld(
  directory: string,
  ownership: WorldOwnership,
  allowReleaseChange = false,
  preparedRelease?: Awaited<ReturnType<typeof readAuthoringRelease>>,
) {
  const release = preparedRelease ?? (await readAuthoringRelease(directory));
  await ownership.connect();
  const layouts = new StaticLayoutStore(ownership, release);
  const candidate = await layouts.readCandidate(allowReleaseChange);
  const { world, publication, hash } = await createLayoutPublication(release, candidate.snapshot);
  const physics = await createAuthoritativeWorld({ ...world, initialItems: [] });
  try {
    for (const spawn of world.spawnPoints)
      if (!physics.findSpawn(undefined, [spawn]))
        throw new Error('Static placement blocks a spawn point');
  } finally {
    physics.dispose();
  }
  const output = resolve(directory, 'layouts', release.metadata.assetReleaseVersion, hash);
  const commit = () => layouts.commit(candidate, hash);
  const items = new ItemStore(ownership.pool, world, ownership.epoch, ownership, commit);
  await items.migrateGeometry(undefined, true);
  await writeWorldPublication(publication, output);
  return {
    definition: world,
    manifest: publication.manifest,
    directory: output,
    items,
    commit,
    snapshot: candidate.snapshot,
    layoutHash: hash,
    release,
  };
}
