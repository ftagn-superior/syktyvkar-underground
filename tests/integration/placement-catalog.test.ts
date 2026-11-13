import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  placementCatalogIdentity,
  MAX_EDITABLE_STATIC_INSTANCES,
  placedStaticInstance,
  type PlaceStaticRequest,
  type StaticObjectInstance,
} from '../../packages/contracts/src/index.js';
import { hash } from '../../packages/world-release/src/index.js';
import type { AuthoritativeWorld } from '../../packages/simulation/src/server.js';
import { readAuthoringRelease } from '../../apps/server/src/layout/release.js';
import { LayoutPublications, LiveStaticPlacement } from '../../apps/server/src/layout/live.js';
import { StaticLayoutStore } from '../../apps/server/src/layout/store.js';
import type { ItemRuntime } from '../../apps/server/src/items/runtime.js';
import {
  hasPlacementGround,
  readPlacementCatalog,
} from '../../apps/server/src/layout/placement-catalog.js';
import { createGameServer } from '../helpers/game-server.js';
import { buildStaticPlacementWorld } from '../helpers/static-placement-world.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';

describe('verified server placement catalog', () => {
  let temporary: string, worldDirectory: string;
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'su-placement-catalog-'));
    worldDirectory = await buildStaticPlacementWorld(temporary);
  });
  afterAll(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it('derives one canonical snapshot and validates its adopted release and foundation', async () => {
    const release = await readAuthoringRelease(worldDirectory);
    const snapshot = (await readPlacementCatalog(release, join(worldDirectory, 'model-catalog')))!;
    expect(snapshot.catalog.models.map((m) => m.assetId)).toEqual(['bench-0152a250d22ef0a9']);
    expect(snapshot.body).toBe(canonicalJson(snapshot.catalog));
    expect(snapshot.reference.placementCatalogVersion).toBe(
      hash(canonicalJson(placementCatalogIdentity(snapshot.catalog))),
    );
    expect(snapshot.reference.assetReleaseVersion).toBe(release.metadata.assetReleaseVersion);
    expect(hasPlacementGround(release.definition, release.manifest)).toBe(true);
    expect(
      hasPlacementGround({ ...release.definition, buildings: [], entities: [] }, release.manifest),
    ).toBe(false);
    expect(
      await readPlacementCatalog(release, join(temporary, 'legacy-without-policy')),
    ).toBeUndefined();
  });

  it('fails startup for explicitly enabled incomplete or mismatched artifacts', async () => {
    const directory = join(worldDirectory, 'model-catalog');
    const policyFile = join(directory, 'placement-policy.json');
    const bytes = await readFile(policyFile);
    const release = await readAuthoringRelease(worldDirectory);
    try {
      await rm(policyFile);
      await expect(readPlacementCatalog(release, directory)).rejects.toThrow();
      const policy = JSON.parse(bytes.toString());
      await writeFile(
        policyFile,
        JSON.stringify({ ...policy, assetReleaseVersion: 'e'.repeat(64) }),
      );
      await expect(readPlacementCatalog(release, directory)).rejects.toThrow('release mismatch');
      await writeFile(policyFile, JSON.stringify({ ...policy, assetIds: ['unknown-model'] }));
      await expect(readPlacementCatalog(release, directory)).rejects.toThrow('unknown-model');
    } finally {
      await writeFile(policyFile, bytes);
    }
  });

  it('counts disabled editable rows at the shared limit before physics or a write', async () => {
    const release = await readAuthoringRelease(worldDirectory);
    const catalog = (await readPlacementCatalog(release, join(worldDirectory, 'model-catalog')))!;
    const request: PlaceStaticRequest = {
      operationId: '12345678-1234-1234-1234-123456789abc',
      worldEpoch: 'test',
      assetReleaseVersion: release.metadata.assetReleaseVersion,
      placementCatalogVersion: catalog.reference.placementCatalogVersion,
      expectedLayoutRevision: 1,
      assetId: catalog.catalog.models[0].assetId,
      position: { x: 10, z: 10 },
      yawStep: 0,
    };
    const instances: StaticObjectInstance[] = Array.from(
      { length: MAX_EDITABLE_STATIC_INSTANCES },
      (_, index) => ({
        ...placedStaticInstance(request),
        entityId: `disabled_${index}`,
        enabled: false,
      }),
    );
    const snapshot = {
      formatVersion: 1 as const,
      worldId: release.definition.worldId,
      assetReleaseVersion: release.metadata.assetReleaseVersion,
      seedVersion: release.metadata.seedVersion,
      revision: 1,
      instances,
    };
    const prepared = {
      release,
      definition: release.definition,
      manifest: release.manifest,
      directory: worldDirectory,
      snapshot,
      layoutHash: 'a'.repeat(64),
    } as ConstructorParameters<typeof LayoutPublications>[0];
    const physics = vi.fn();
    const paused = vi.fn();
    const items = {
      store: { ownership: {} },
      layoutPaused: false,
      unavailable: false,
      closing: false,
      setLayoutPaused: paused,
      placeStatic: async <T>(run: (flush: () => Promise<void>) => Promise<T>) =>
        run(async () => {}),
    } as unknown as ItemRuntime;
    const spies = [
      vi.spyOn(StaticLayoutStore.prototype, 'replayGame').mockResolvedValue(undefined),
      vi.spyOn(StaticLayoutStore.prototype, 'gameRateLimited').mockResolvedValue(false),
      vi
        .spyOn(StaticLayoutStore.prototype, 'readCandidate')
        .mockResolvedValue({ snapshot, initialized: true }),
      vi.spyOn(StaticLayoutStore.prototype, 'createGame'),
    ];
    try {
      const live = new LiveStaticPlacement(
        new LayoutPublications(prepared),
        items,
        { checkStaticPlacement: physics } as unknown as AuthoritativeWorld,
        'test',
        () => {},
        () => {},
        catalog,
      );
      expect(await live.place('account', request, () => undefined)).toMatchObject({
        ok: false,
        code: 'CONTENT_LIMIT',
      });
      expect(physics).not.toHaveBeenCalled();
      expect(spies[3]).not.toHaveBeenCalled();
      expect(paused).toHaveBeenLastCalledWith(false);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it.skipIf(!process.env.SU_TEST_DATABASE_URL)(
    'publishes only the exact verified immutable snapshot over GET and HEAD',
    async () => {
      const fixture = await createDatabaseFixture();
      const app = await createGameServer({ port: 0, worldDirectory, pool: fixture.pool });
      try {
        const info = await fetch(app.url + '/api/world').then((response) => response.json());
        const reference = info.placementCatalog;
        expect(reference).toBeTruthy();
        const response = await fetch(app.url + reference.url);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        const body = await response.text();
        const catalog = JSON.parse(body);
        expect(body).toBe(canonicalJson(catalog));
        expect(hash(canonicalJson(placementCatalogIdentity(catalog)))).toBe(
          reference.placementCatalogVersion,
        );
        const head = await fetch(app.url + reference.url, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        for (const path of [
          reference.url.replace(reference.placementCatalogVersion, 'f'.repeat(64)),
          '/worlds/static-placement-lab/placement-catalogs/index.json',
          '/worlds/static-placement-lab/model-catalog/placement-policy.json',
        ])
          expect((await fetch(app.url + path)).status).toBe(404);
        expect((await fetch(app.url + reference.url, { method: 'POST' })).status).toBe(404);
      } finally {
        await app.close();
        await fixture.close();
      }
    },
  );
});
