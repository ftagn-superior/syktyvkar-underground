import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { applyWorldLayoutPatch, validateWorldLayoutPatch } from '@su/contracts';
import { writeWorldPublication } from '@su/world-release';
import { ItemStore } from '../items/store.js';
import type { WorldOwnership } from '../world-ownership.js';
import { validateLayoutSpawns } from './prepare.js';
import { createLayoutPublication, readAuthoringRelease } from './release.js';
import { StaticLayoutStore } from './store.js';

/** Offline only. Geometry compatibility, placements, revisions and audit share one transaction. */
export async function applyStaticLayoutPatch(
  directory: string,
  ownership: WorldOwnership,
  input: unknown,
  dryRun = false,
) {
  const patch: unknown = structuredClone(input);
  validateWorldLayoutPatch(patch);
  const release = await readAuthoringRelease(directory);
  if (release.definition.worldId !== ownership.worldId)
    throw new Error('World ownership differs from release');
  await ownership.connect();
  const layouts = new StaticLayoutStore(ownership, release);
  const before = await layouts.readCandidate();
  if (!before.initialized)
    throw new Error('World layout is not initialized; start or migrate the world first');
  const snapshot = applyWorldLayoutPatch(before.snapshot, patch);
  const { world, publication, hash } = await createLayoutPublication(release, snapshot);
  await validateLayoutSpawns(world);
  const items = new ItemStore(ownership.pool, world, ownership.epoch, ownership);
  const operationId = dryRun ? undefined : randomUUID();
  await items.migrateGeometry(async () => {
    // Publish before committing. An I/O failure rolls back all database changes;
    // immutable orphaned files after a later failure are never activated by the server.
    await writeWorldPublication(
      publication,
      resolve(directory, 'layouts', release.metadata.assetReleaseVersion, hash),
    );
    snapshot.revision = (await layouts.applyPatch(patch, hash, operationId!)).revision;
  }, dryRun);
  return {
    before: before.snapshot,
    snapshot,
    hash,
    operationId,
    cells: publication.manifest.cells.length,
  };
}
