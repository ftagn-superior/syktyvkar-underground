import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  placedStaticInstance,
  STATIC_PLACEMENT_ASSET_ID,
  type PlaceStaticRequest,
} from '@su/contracts';
import { writeWorldPublication } from '@su/world-release';
import { createAuthoritativeWorld } from '@su/simulation/server';
import { buildStaticPlacementWorld } from '../../../../tests/helpers/static-placement-world.js';
import { ItemRuntime } from '../items/runtime.js';
import type { ItemStore } from '../items/store.js';
import { createLayoutPublication, readAuthoringRelease } from './release.js';
import { readPlacementCatalog } from './placement-catalog.js';
import { LayoutPublications, LiveStaticPlacement } from './live.js';
import { LayoutPreparation } from './preparation.js';
import { StaticLayoutStore } from './store.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const until = async (condition: () => boolean) => {
  for (let n = 0; n < 1000; n++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('Timed out waiting for preparation');
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'su-live-unit-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const worldDirectory = await buildStaticPlacementWorld(directory);
  const release = await readAuthoringRelease(worldDirectory);
  const snapshot = {
    formatVersion: 1 as const,
    worldId: release.definition.worldId,
    assetReleaseVersion: release.metadata.assetReleaseVersion,
    seedVersion: release.metadata.seedVersion,
    revision: 1,
    instances: release.seed,
  };
  const publication = await createLayoutPublication(release, snapshot);
  const publicationDirectory = join(
    worldDirectory,
    'layouts',
    release.metadata.assetReleaseVersion,
    publication.hash,
  );
  await writeWorldPublication(publication.publication, publicationDirectory, 8);
  const publications = new LayoutPublications({
    definition: publication.world,
    manifest: publication.publication.manifest,
    directory: publicationDirectory,
    snapshot,
    layoutHash: publication.hash,
    release,
  } as ConstructorParameters<typeof LayoutPublications>[0]);
  const world = await createAuthoritativeWorld(publication.world);
  cleanup.push(() => world.dispose());
  const flush = vi.fn(async () => {});
  const store = {
    ownership: {},
    definition: publication.world,
    connect: async () => {},
    save: flush,
    worldItems: async () => world.getSnapshot().items,
    close: async () => {},
  } as unknown as ItemStore;
  const items = new ItemRuntime(store, world, () => {});
  cleanup.push(() => items.close());
  const catalog = await readPlacementCatalog(release, join(worldDirectory, 'model-catalog'));
  const changed = vi.fn();
  const live = new LiveStaticPlacement(
    publications,
    items,
    world,
    'epoch',
    changed,
    () => {},
    catalog,
  );
  cleanup.push(() => publications.close());
  cleanup.push(() => live.close());
  vi.spyOn(StaticLayoutStore.prototype, 'replayGame').mockResolvedValue(undefined);
  vi.spyOn(StaticLayoutStore.prototype, 'replayRemoval').mockResolvedValue(undefined);
  vi.spyOn(StaticLayoutStore.prototype, 'gameRateLimited').mockResolvedValue(false);
  const create = vi.spyOn(StaticLayoutStore.prototype, 'createGame').mockResolvedValue(2);
  const remove = vi.spyOn(StaticLayoutStore.prototype, 'removeGame').mockResolvedValue(3);
  const request: PlaceStaticRequest = {
    operationId: '12345678-1234-4567-8123-123456789abc',
    worldEpoch: 'epoch',
    assetReleaseVersion: release.metadata.assetReleaseVersion,
    expectedLayoutRevision: 1,
    placementCatalogVersion: catalog!.reference.placementCatalogVersion,
    assetId: STATIC_PLACEMENT_ASSET_ID,
    position: { x: 10, z: 10 },
    yawStep: 0,
  };
  return { live, items, world, publications, create, remove, request, changed, flush };
}
describe('live layout phases', () => {
  it('leaves the writer free during preparation, commits once, then holds only the editor slot', async () => {
    const { live, items, publications, create, remove, request, changed, flush } = await fixture();
    const prepare = vi.spyOn(LayoutPreparation.prototype, 'prepare');
    const old = publications.current;
    const result = live.place('account', request, () => undefined);
    const duplicate = live.place('account', request, () => undefined);
    await until(() => prepare.mock.calls.length > 0);
    expect(live.busy).toBe(true);
    expect(items.layoutPaused).toBe(false);
    await expect(items.placeStatic(async () => 'inventory served')).resolves.toBe(
      'inventory served',
    );
    await expect(result).resolves.toMatchObject({ ok: true, layoutRevision: 2 });
    await expect(duplicate).resolves.toEqual(await result);
    expect(create).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(request.operationId);
    expect(flush).toHaveBeenCalledOnce();
    expect(items.layoutPaused).toBe(false);
    expect(live.busy).toBe(true);
    expect(old.definition.buildings).toHaveLength(0);
    expect(publications.current.definition.buildings).toHaveLength(1);
    await expect(
      live.place(
        'account',
        { ...request, operationId: '22345678-1234-4567-8123-123456789abc' },
        () => undefined,
      ),
    ).resolves.toMatchObject({ code: 'WORLD_NOT_READY' });
    await live.finishTransition();
    expect(live.busy).toBe(false);
    await expect(
      live.remove(
        'account',
        {
          operationId: '32345678-1234-4567-8123-123456789abc',
          worldEpoch: 'epoch',
          assetReleaseVersion: request.assetReleaseVersion,
          expectedLayoutRevision: 2,
          entityId: `placed_${request.operationId}`,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({ ok: true, layoutRevision: 3 });
    expect(remove).toHaveBeenCalledOnce();
    expect(publications.previous!.definition.buildings).toHaveLength(1);
    expect(publications.current.definition.buildings).toHaveLength(0);
    await live.finishTransition();
  }, 20_000);
  it('defers redundant staging cleanup until clients have applied the publication', async () => {
    const { live, publications, request } = await fixture();
    const prepare = vi.spyOn(LayoutPreparation.prototype, 'prepare');
    await expect(live.place('account', request, () => undefined)).resolves.toMatchObject({
      ok: true,
    });
    await live.finishTransition();
    await expect(
      live.remove(
        'account',
        {
          operationId: '52345678-1234-4567-8123-123456789abc',
          worldEpoch: 'epoch',
          assetReleaseVersion: request.assetReleaseVersion,
          expectedLayoutRevision: 2,
          entityId: `placed_${request.operationId}`,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({ ok: true });
    const prepared = await prepare.mock.results.at(-1)!.value;
    await expect(access(prepared.stagingDirectory)).resolves.toBeUndefined();
    expect(publications.current.directory).toBe(publications.prepared.directory);
    expect(live.metrics!.workerReturnMs).toBeGreaterThanOrEqual(0);
    expect(live.metrics!.adoptMs).toBeGreaterThanOrEqual(0);
    await live.finishTransition();
    await expect(access(prepared.stagingDirectory)).rejects.toThrow();
    await expect(access(publications.current.directory)).resolves.toBeUndefined();
    expect(live.metrics!.cleanupMs).toBeGreaterThanOrEqual(0);
  }, 20_000);
  it('preserves confirmed current and previous directories on shutdown while removing candidates and staging', async () => {
    const { live, publications, request, create } = await fixture();
    await expect(live.place('account', request, () => undefined)).resolves.toMatchObject({
      ok: true,
    });
    await live.finishTransition();
    create.mockResolvedValue(3);
    const nextRequest = {
      ...request,
      operationId: '62345678-1234-4567-8123-123456789abc',
      expectedLayoutRevision: 2,
      position: { x: 10, z: 14 },
    };
    await expect(live.place('account', nextRequest, () => undefined)).resolves.toMatchObject({
      ok: true,
    });
    const current = publications.current.directory,
      previous = publications.previous!.directory;
    const release = publications.prepared.release;
    const worker = new LayoutPreparation(release.directory, release.metadata.assetReleaseVersion);
    cleanup.push(() => worker.close());
    const instance = placedStaticInstance({
      ...nextRequest,
      operationId: '72345678-1234-4567-8123-123456789abc',
      expectedLayoutRevision: 3,
      position: { x: 10, z: 18 },
    });
    const snapshot = {
      ...publications.current.snapshot,
      revision: 4,
      instances: [...publications.current.snapshot.instances, instance],
    };
    const pending = await worker.prepare(snapshot, 'unconfirmed', 'epoch');
    const candidate = await publications.adopt(pending, snapshot, {
      ...publications.current.definition,
      buildings: [...publications.current.definition.buildings, instance],
    });
    const redundant = await worker.prepare(publications.current.snapshot, 'duplicate', 'epoch');
    await publications.adopt(
      redundant,
      publications.current.snapshot,
      publications.current.definition,
    );
    await publications.close();
    await expect(access(current)).resolves.toBeUndefined();
    await expect(access(previous)).resolves.toBeUndefined();
    await expect(access(candidate.directory)).rejects.toThrow();
    await expect(access(redundant.stagingDirectory)).rejects.toThrow();
  }, 20_000);
  it('releases the editor slot when obsolete publication cleanup fails', async () => {
    const { live, publications, request, remove } = await fixture();
    await expect(live.place('account', request, () => undefined)).resolves.toMatchObject({
      ok: true,
    });
    vi.spyOn(publications, 'cleanup').mockImplementationOnce(async () => {
      publications.previous = undefined;
      throw new Error('Injected directory cleanup failure');
    });
    await expect(live.finishTransition()).rejects.toThrow('directory cleanup failure');
    expect(live.busy).toBe(false);
    await expect(
      live.remove(
        'account',
        {
          operationId: '42345678-1234-4567-8123-123456789abc',
          worldEpoch: 'epoch',
          assetReleaseVersion: request.assetReleaseVersion,
          expectedLayoutRevision: 2,
          entityId: `placed_${request.operationId}`,
        },
        () => undefined,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(remove).toHaveBeenCalledOnce();
    await live.finishTransition();
  }, 20_000);
  it('retries a rolled-back write under the safe pause, and resolves a lost commit acknowledgement once', async () => {
    const { live, items, create, request } = await fixture();
    create.mockRejectedValueOnce(new Error('SQL rolled back'));
    const result = live.place('account', request, () => undefined);
    await until(() => items.unavailable);
    expect(items.layoutPaused).toBe(true);
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(items.layoutPaused).toBe(false);
    await live.finishTransition();
  }, 20_000);
  it('applies committed geometry after a lost acknowledgement without a second write', async () => {
    const { live, items, create, request, publications } = await fixture();
    create.mockImplementationOnce(async () => {
      vi.mocked(StaticLayoutStore.prototype.replayGame).mockResolvedValue({
        operationId: request.operationId,
        ok: true,
        entityId: `placed_${request.operationId}`,
        layoutRevision: 2,
      });
      throw new Error('Lost COMMIT acknowledgement');
    });
    const result = live.place('account', request, () => undefined);
    await until(() => items.unavailable);
    expect(items.layoutPaused).toBe(true);
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledOnce();
    expect(publications.current.definition.buildings).toHaveLength(1);
    expect(items.layoutPaused).toBe(false);
    await live.finishTransition();
  }, 20_000);
  it('rejects a player who occupied the place during worker preparation without writing SQL', async () => {
    const { live, items, world, create, request, publications } = await fixture();
    const prepare = vi.spyOn(LayoutPreparation.prototype, 'prepare');
    const old = publications.current;
    const result = live.place('account', request, () => undefined);
    await until(() => prepare.mock.calls.length > 0);
    world.addPlayer('arrived-during-build', { x: 10, y: 0, z: 10 });
    await expect(result).resolves.toMatchObject({ code: 'BLOCKED' });
    expect(create).not.toHaveBeenCalled();
    expect(publications.current).toBe(old);
    expect(items.layoutPaused).toBe(false);
    expect(live.busy).toBe(false);
  }, 20_000);
});
