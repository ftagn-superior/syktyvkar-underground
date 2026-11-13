import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildWorld } from '../../tools/world-build/src/index.js';
import {
  createLayoutPublication,
  readAuthoringRelease,
} from '../../apps/server/src/layout/release.js';
import { repackAuthoringPhysics } from '../terrain/repack-physics.js';

it('preserves legacy publication bytes and propagates only explicit physics-pack authoring opt-in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'su-physics-packs-'));
  try {
    const originalDirectory = join(directory, 'original');
    await buildWorld('content/worlds/physics-lab/world.json', originalDirectory);
    const legacyBytes = await readFile(join(originalDirectory, 'manifest.json'));
    const original = await readAuthoringRelease(originalDirectory);
    const makeSnapshot = (release: typeof original) => ({
      formatVersion: 1 as const,
      worldId: release.definition.worldId,
      assetReleaseVersion: release.metadata.assetReleaseVersion,
      seedVersion: release.metadata.seedVersion,
      revision: 1,
      instances: release.seed,
    });
    const old = await createLayoutPublication(original, makeSnapshot(original));
    expect(old.publication.manifest).toEqual(original.manifest);
    expect(old.publication.manifest.cells.every((cell) => cell.physicsPacks === undefined)).toBe(
      true,
    );
    const packed = await repackAuthoringPhysics(originalDirectory, join(directory, 'packed'));
    expect(packed.definition).toEqual(original.definition);
    expect(packed.manifest.assets).toEqual(original.manifest.assets);
    expect(packed.manifest.simulationConfigHash).toBe(original.manifest.simulationConfigHash);
    expect(packed.manifest.mapVersion).not.toBe(original.manifest.mapVersion);
    expect(packed.manifest.cells.some((cell) => cell.physicsPacks?.length)).toBe(true);
    const next = await createLayoutPublication(packed, makeSnapshot(packed));
    expect(next.publication.manifest).toEqual(packed.manifest);
    const fromBuilder = await buildWorld(
      'content/worlds/physics-lab/world.json',
      join(directory, 'built-packed'),
      { physicsPacks: true },
    );
    expect(fromBuilder).toEqual(packed.manifest);
    expect(await readFile(join(originalDirectory, 'manifest.json'))).toEqual(legacyBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
