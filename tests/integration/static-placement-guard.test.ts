import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  initialItemState,
  type ItemState,
  type PlaceStaticRequest,
  type WorldLayoutSnapshot,
} from '../../packages/contracts/src/index.js';
import { LayoutPublications, LiveStaticPlacement } from '../../apps/server/src/layout/live.js';
import * as releases from '../../apps/server/src/layout/release.js';
import { StaticLayoutStore } from '../../apps/server/src/layout/store.js';
import type { ItemRuntime } from '../../apps/server/src/items/runtime.js';
import type { AuthoritativeWorld } from '../../packages/simulation/src/server.js';
import { rectangle, terrainPatch, terrainSolid } from '../../packages/terrain-build/src/index.js';
import { buildStaticPlacementWorld } from '../helpers/static-placement-world.js';
import { readPlacementCatalog } from '../../apps/server/src/layout/placement-catalog.js';

describe('live single-box publication guard', () => {
  let temporary: string;
  let release: releases.AuthoringRelease;
  const createPublication = releases.createLayoutPublication;
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'su-live-publication-guard-'));
    release = await releases.readAuthoringRelease(await buildStaticPlacementWorld(temporary));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  async function fixture() {
    const snapshot: WorldLayoutSnapshot = {
      formatVersion: 1,
      worldId: release.definition.worldId,
      assetReleaseVersion: release.metadata.assetReleaseVersion,
      seedVersion: release.metadata.seedVersion,
      revision: 2,
      instances: [],
    };
    const publication = await createPublication(release, snapshot);
    const prepared = {
      release,
      definition: publication.world,
      manifest: publication.publication.manifest,
      directory: release.directory,
      snapshot,
      layoutHash: publication.hash,
    } as ConstructorParameters<typeof LayoutPublications>[0];
    const publications = new LayoutPublications(prepared);
    const write = vi.spyOn(publications, 'write');
    const activate = vi.spyOn(publications, 'activate');
    const read = vi.spyOn(StaticLayoutStore.prototype, 'readCandidate').mockResolvedValue({
      initialized: true,
      previousRelease: snapshot.assetReleaseVersion,
      snapshot: structuredClone(snapshot),
    });
    vi.spyOn(StaticLayoutStore.prototype, 'replayGame').mockResolvedValue(undefined);
    vi.spyOn(StaticLayoutStore.prototype, 'gameRateLimited').mockResolvedValue(false);
    const commit = vi.spyOn(StaticLayoutStore.prototype, 'createGame').mockResolvedValue(3);
    const runtime = {
      store: { ownership: {}, definition: publication.world },
      layoutPaused: false,
      unavailable: false,
      closing: false,
      setLayoutPaused: vi.fn((paused: boolean) => {
        runtime.layoutPaused = paused;
      }),
      placeStatic: (run: (flush: () => Promise<void>) => Promise<unknown>) => run(async () => {}),
    };
    const world = {
      checkStaticPlacement: () => undefined,
      getSnapshot: vi.fn(() => ({ items: [] as ItemState[], players: [] })),
      prepareStaticReplacement: vi.fn(() => ({ commit: vi.fn(), dispose: vi.fn() })),
    };
    const changed = vi.fn();
    const live = new LiveStaticPlacement(
      publications,
      runtime as unknown as ItemRuntime,
      world as unknown as AuthoritativeWorld,
      'guard-epoch',
      changed,
      () => {},
      await readPlacementCatalog(release, join(release.directory, 'model-catalog')),
    );
    const request: PlaceStaticRequest = {
      operationId: '12345678-1234-1234-1234-123456789abc',
      assetId: 'bench-0152a250d22ef0a9',
      placementCatalogVersion: live.catalog!.reference.placementCatalogVersion,
      worldEpoch: 'guard-epoch',
      assetReleaseVersion: snapshot.assetReleaseVersion,
      expectedLayoutRevision: snapshot.revision,
      position: { x: 10, z: 10 },
      yawStep: 0,
    };
    return { live, publications, runtime, world, request, write, activate, commit, read, changed };
  }

  it('keeps the existing one-box addition publishable and activatable', async () => {
    const f = await fixture();
    expect(f.live.effect()).toBeDefined();
    expect(await f.live.place('account', f.request, () => undefined)).toMatchObject({ ok: true });
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.world.prepareStaticReplacement).toHaveBeenCalledTimes(1);
    expect(f.world.prepareStaticReplacement.mock.results[0].value.commit).toHaveBeenCalledTimes(1);
    expect(f.activate).toHaveBeenCalledTimes(1);
    await f.publications.close();
  });

  it('rejects extra derived instances before publication writes, database commit or physics activation', async () => {
    const f = await fixture();
    const before = canonicalJson(f.publications.current);
    vi.spyOn(releases, 'createLayoutPublication').mockImplementation(async (authored, snapshot) =>
      createPublication(authored, {
        ...snapshot,
        instances: [
          ...snapshot.instances,
          {
            ...snapshot.instances[0],
            entityId: 'derived-support',
            position: { x: -10, y: 0, z: 10 },
          },
        ],
      }),
    );
    expect(await f.live.place('account', f.request, () => undefined)).toMatchObject({
      ok: false,
      code: 'COMMAND_DISABLED',
    });
    expect(f.runtime.layoutPaused).toBe(false);
    expect(canonicalJson(f.publications.current)).toBe(before);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.world.prepareStaticReplacement).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('checks spawn obstruction against the complete static candidate with real ground support', async () => {
    const f = await fixture();
    f.request.position = { x: -12, z: -10 };
    expect(await f.live.place('account', f.request, () => undefined)).toMatchObject({
      ok: false,
      code: 'BLOCKED',
    });
    expect(f.runtime.layoutPaused).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rejects a new box over an existing safePose even when its item is airborne elsewhere', async () => {
    const f = await fixture();
    const item = initialItemState({
      seedId: 'airborne',
      typeId: 'wooden-crate',
      position: { x: 0, y: 5, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    item.safePose = { position: { x: 10, y: 0.52, z: 10 }, rotation: item.rotation };
    f.world.getSnapshot.mockReturnValue({ items: [item], players: [] });
    expect(await f.live.place('account', f.request, () => undefined)).toMatchObject({
      ok: false,
      code: 'BLOCKED',
    });
    expect(f.runtime.layoutPaused).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rejects a changed prior resource even when instance poses and physics are unchanged', async () => {
    const f = await fixture();
    vi.spyOn(releases, 'createLayoutPublication').mockImplementation(async (...args) => {
      const candidate = await createPublication(...args);
      const file = Object.values(candidate.publication.manifest.assets)[0].modelFile!;
      candidate.publication.manifest.files[file] = 'f'.repeat(64);
      return candidate;
    });
    expect(await f.live.place('account', f.request, () => undefined)).toMatchObject({
      ok: false,
      code: 'COMMAND_DISABLED',
    });
    expect(f.runtime.layoutPaused).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.world.prepareStaticReplacement).not.toHaveBeenCalled();
  });

  it('keeps placement disabled when the ground is represented only by terrain meshes', async () => {
    const f = await fixture();
    // The existing effect recognizes flat box slabs only; a terrain mesh is not that contract.
    f.publications.current.definition.entities = [];
    const grid = {
      formatVersion: 1 as const,
      origin: { x: -20, z: -20 },
      spacing: 10,
      columns: 5,
      rows: 5,
      heights: Array(25).fill(0),
      bottom: -1,
    };
    const ground = terrainSolid(
      'mesh-ground',
      terrainPatch(grid, rectangle(0, 0, 40, 40)),
      () => 0,
      () => -1,
      '#888888',
    );
    f.publications.current.definition.buildingAssets['mesh-ground'] = ground.physics;
    f.publications.current.definition.buildings = [
      {
        entityId: 'mesh-ground',
        assetId: 'mesh-ground',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    ];
    expect(f.live.effect()).toBeUndefined();
    expect(await f.live.place('account', f.request, () => undefined)).toMatchObject({
      ok: false,
      code: 'COMMAND_DISABLED',
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });
});
