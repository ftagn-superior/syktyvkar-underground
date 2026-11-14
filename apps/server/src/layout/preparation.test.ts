import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { placedStaticInstance, STATIC_PLACEMENT_ASSET_ID } from '@su/contracts';
import { buildStaticPlacementWorld } from '../../../../tests/helpers/static-placement-world.js';
import {
  createLayoutPublication,
  createReleaseLayoutPublisher,
  readAuthoringRelease,
} from './release.js';
import { LayoutPreparation } from './preparation.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(timeout?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'su-worker-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const worldDirectory = await buildStaticPlacementWorld(directory);
  const release = await readAuthoringRelease(worldDirectory);
  const worker = new LayoutPreparation(
    worldDirectory,
    release.metadata.assetReleaseVersion,
    timeout,
  );
  cleanup.push(() => worker.close());
  const snapshot = {
    formatVersion: 1 as const,
    worldId: release.definition.worldId,
    assetReleaseVersion: release.metadata.assetReleaseVersion,
    seedVersion: release.metadata.seedVersion,
    revision: 1,
    instances: release.seed,
  };
  return { directory, worldDirectory, release, worker, snapshot };
}
describe('background layout publisher', () => {
  it('publishes identical validated bytes for creation and removal without blocking room timers', async () => {
    const { release, worker, snapshot } = await fixture();
    const placed = placedStaticInstance({
      operationId: '12345678-1234-4567-8123-123456789abc',
      worldEpoch: 'epoch',
      assetReleaseVersion: snapshot.assetReleaseVersion,
      expectedLayoutRevision: 1,
      placementCatalogVersion: 'a'.repeat(64),
      assetId: STATIC_PLACEMENT_ASSET_ID,
      position: { x: 10, z: 10 },
      yawStep: 0,
    });
    let ticks = 0;
    const interval = setInterval(() => ticks++, 5);
    try {
      for (const instances of [
        [...snapshot.instances, placed],
        [...snapshot.instances, { ...placed, enabled: false }],
      ]) {
        const candidate = { ...snapshot, instances };
        const result = await worker.prepare(candidate, placed.entityId, 'epoch');
        const expected = await createLayoutPublication(release, candidate);
        expect(result.manifest).toEqual(expected.publication.manifest);
        expect(result.layoutHash).toBe(expected.hash);
        expect(result.fileCount).toBe(expected.publication.payloads.size + 1);
        expect(await readdir(result.stagingDirectory)).toContain('manifest.json');
        await rm(result.stagingDirectory, { recursive: true, force: true });
      }
      expect(ticks).toBeGreaterThan(5);
    } finally {
      clearInterval(interval);
    }
  }, 20_000);
  it('pins previously verified asset bytes while still validating every candidate', async () => {
    const { release, snapshot } = await fixture();
    const publish = createReleaseLayoutPublisher(release);
    const original = await publish(snapshot);
    const descriptor = Object.values(release.manifest.assets)[0];
    await writeFile(join(release.directory, descriptor.collisionFile), 'corrupt');
    // The running publisher owns the immutable bytes it verified before the source changed.
    expect((await publish(snapshot)).publication.manifest).toEqual(original.publication.manifest);
    await expect(createLayoutPublication(release, snapshot)).rejects.toThrow('resource changed');
    await expect(publish({ ...snapshot, revision: 0 })).rejects.toThrow('Invalid layout snapshot');
  });
  it('enforces the complete static-change guard in the worker before writing candidate files', async () => {
    const { release, worker, snapshot, worldDirectory } = await fixture();
    const owner = placedStaticInstance({
      operationId: '12345678-1234-4567-8123-123456789abc',
      worldEpoch: 'epoch',
      assetReleaseVersion: snapshot.assetReleaseVersion,
      expectedLayoutRevision: 1,
      placementCatalogVersion: 'a'.repeat(64),
      assetId: STATIC_PLACEMENT_ASSET_ID,
      position: { x: 10, z: 10 },
      yawStep: 0,
    });
    const before = await createLayoutPublication(release, snapshot);
    const manifest = structuredClone(before.publication.manifest);
    manifest.files[Object.values(manifest.assets)[0].modelFile!] = 'f'.repeat(64);
    const next = { ...snapshot, revision: 2, instances: [...snapshot.instances, owner] };
    await expect(
      worker.prepare(next, owner.entityId, 'epoch', {
        beforeSnapshot: snapshot,
        beforeManifest: manifest,
        owner,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_DISABLED' });
    expect(
      (await readdir(join(worldDirectory, 'layouts')).catch(() => [])).some((name) =>
        name.startsWith('.pending-'),
      ),
    ).toBe(false);
    const accepted = await worker.prepare(next, owner.entityId, 'epoch', {
      beforeSnapshot: snapshot,
      beforeManifest: before.publication.manifest,
      owner,
    });
    expect(accepted.geometryDelta!.buildings.map((i) => i.entityId)).toEqual([owner.entityId]);
    expect(Object.keys(accepted.geometryDelta!.assets)).toHaveLength(0);
    await rm(accepted.stagingDirectory, { recursive: true, force: true });
  });
  it('terminates timed-out preparation before removing only its owned staging directory', async () => {
    const { worldDirectory, worker, snapshot } = await fixture(1);
    await expect(worker.prepare(snapshot, 'timeout', 'epoch')).rejects.toThrow('timed out');
    const directories = await readdir(join(worldDirectory, 'layouts')).catch(() => []);
    expect(directories.some((name) => name.startsWith('.pending-'))).toBe(false);
    // The authored release remains intact and can still be validated.
    await expect(readAuthoringRelease(worldDirectory)).resolves.toHaveProperty('manifest');
  });
  it('discards a crashed publisher and recreates it for the next explicit request', async () => {
    const { worker, snapshot, worldDirectory } = await fixture();
    const pending = worker.prepare(snapshot, 'crash', 'epoch');
    const rejected = expect(pending).rejects.toThrow('Publisher exited');
    await (worker as unknown as { worker: Worker }).worker.terminate();
    await rejected;
    expect(
      (await readdir(join(worldDirectory, 'layouts')).catch(() => [])).some((name) =>
        name.startsWith('.pending-'),
      ),
    ).toBe(false);
    const result = await worker.prepare(snapshot, 'retry', 'epoch');
    expect(result.operationId).toBe('retry');
    await rm(result.stagingDirectory, { recursive: true, force: true });
  }, 15_000);
  it('waits for publisher shutdown before discarding an unfinished operation', async () => {
    const { worker, snapshot, worldDirectory } = await fixture();
    const pending = worker.prepare(snapshot, 'shutdown', 'epoch');
    const rejected = expect(pending).rejects.toThrow('shutting down');
    await worker.close();
    await rejected;
    expect(
      (await readdir(join(worldDirectory, 'layouts')).catch(() => [])).some((name) =>
        name.startsWith('.pending-'),
      ),
    ).toBe(false);
  });
  it('rejects obsolete asset releases and refuses new work after shutdown', async () => {
    const { worldDirectory, snapshot } = await fixture();
    const worker = new LayoutPreparation(worldDirectory, 'f'.repeat(64));
    cleanup.push(() => worker.close());
    await expect(worker.prepare(snapshot, 'mismatch', 'epoch')).rejects.toThrow(
      'asset release changed',
    );
    await worker.close();
    await expect(worker.prepare(snapshot, 'late', 'epoch')).rejects.toThrow('unavailable');
  }, 15_000);
});
