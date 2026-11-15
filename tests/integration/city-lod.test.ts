import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cityLodFixture } from '../fixtures/city-lod.js';
import {
  writeWorldPublication,
  writeAuthoringMetadata,
  jsonBytes,
  hash,
} from '../../packages/world-release/src/index.js';
import {
  changedWorldGraphicsGroups,
  GRAPHICS_POLICY_VERSION,
} from '../../packages/contracts/src/index.js';
import {
  createReleaseLayoutPublisher,
  createLayoutPublication,
  readAuthoringRelease,
} from '../../apps/server/src/layout/release.js';
import {
  expectedStaticChange,
  staticChangeIds,
} from '../../apps/server/src/layout/static-change.js';
import { TERRAIN_GENERATOR_VERSION_V2 } from '../../packages/terrain-build/src/private-data.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';
import { prepareLayoutWorld } from '../../apps/server/src/layout/prepare.js';
import { WorldOwnership } from '../../apps/server/src/world-ownership.js';
import { worldCompatibility } from '../../apps/server/src/items/store.js';
import { readCachedPublication } from '../../apps/server/src/layout/cached-publication.js';
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-city-lod-'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
describe('current layout graphics', () => {
  it('rebuilds owner/support groups from the current snapshot, keeps unrelated bytes and survives restart', async () => {
    const f = cityLodFixture(),
      dir = join(directory, 'supports');
    f.world.buildings.forEach((i) => (i.position.y = 0.2));
    f.world.buildings[0].position.x = -124;
    f.publication = f.publish();
    const terrain = {
      formatVersion: 2,
      generatorVersion: TERRAIN_GENERATOR_VERSION_V2,
      worldId: f.world.worldId,
      grid: {
        formatVersion: 1,
        origin: { x: -250, z: -250 },
        spacing: 20,
        columns: 27,
        rows: 27,
        bottom: -2,
        heights: Array(27 * 27).fill(0),
      },
      supports: [
        {
          kind: 'foundation-v2',
          assetId: 'house',
          components: [
            {
              outline: [
                [-6, -4],
                [6, -4],
                [6, 4],
                [-6, 4],
              ],
              holes: [],
            },
          ],
          jointY: 0,
          clearance: 0.1,
          burial: 0.05,
          color: '#888888',
          approaches: [
            {
              id: 'entry',
              edge: [
                [-1, -4],
                [1, -4],
              ],
              outward: [0, -1],
              length: 2,
              targetY: 0,
              color: '#999999',
            },
          ],
        },
      ],
    };
    await writeWorldPublication(f.publication, dir);
    await writeAuthoringMetadata(
      f.world,
      f.publication.manifest,
      [],
      dir,
      jsonBytes(terrain),
      jsonBytes(f.source),
    );
    const release = await readAuthoringRelease(dir),
      publisher = createReleaseLayoutPublisher(release);
    const snapshot = {
      formatVersion: 1 as const,
      worldId: f.world.worldId,
      assetReleaseVersion: release.metadata.assetReleaseVersion,
      seedVersion: release.metadata.seedVersion,
      revision: 1,
      instances: release.seed,
    };
    const before = await publisher(snapshot),
      owner = snapshot.instances[0];
    expect(Object.keys(before.publication.manifest.generatedSupports!)).toHaveLength(4);
    const nextSnapshot = structuredClone(snapshot);
    nextSnapshot.revision++;
    nextSnapshot.instances[0].enabled = false;
    const after = await publisher(nextSnapshot);
    for (const [id, support] of Object.entries(before.publication.manifest.generatedSupports!))
      if (support.ownerId !== owner.entityId)
        expect(after.world.buildingAssets[id]).toBe(before.world.buildingAssets[id]);
    const active = join(dir, 'layouts', release.metadata.assetReleaseVersion, before.hash);
    await writeWorldPublication(before.publication, active);
    const cached = await readCachedPublication(release, snapshot, before.publication.manifest);
    expect(cached!.world).toEqual(before.world);
    const seeded = createReleaseLayoutPublisher(release, {
      graphics: cached!.publication.manifest.graphics!,
      payloads: cached!.publication.payloads,
    });
    expect((await seeded(nextSnapshot)).publication.manifest).toEqual(after.publication.manifest);
    const file = before.publication.manifest.graphics!.groups[0].far.resources[0].modelFile;
    const corrupt = Uint8Array.from(before.publication.payloads.get(file)!);
    corrupt[0] ^= 1;
    await writeFile(join(active, file), corrupt);
    await expect(
      readCachedPublication(release, snapshot, before.publication.manifest),
    ).rejects.toThrow('Cached resource hash');
    expect(
      expectedStaticChange(
        release,
        { definition: before.world, manifest: before.publication.manifest },
        after,
        owner,
      ),
    ).toBe(true);
    expect(after.world.buildings.some((b) => staticChangeIds(release, owner).has(b.entityId))).toBe(
      false,
    );
    const changed = new Set(
      changedWorldGraphicsGroups(before.publication.manifest, after.publication.manifest),
    );
    for (const g of before.publication.manifest.graphics!.groups)
      if (!changed.has(g.groupId)) {
        expect(
          after.publication.manifest.graphics!.groups.find((n) => n.groupId === g.groupId),
        ).toEqual(g);
        for (const r of g.far.resources)
          expect(after.publication.payloads.get(r.modelFile)).toEqual(
            before.publication.payloads.get(r.modelFile),
          );
      }
    const restarted = await createLayoutPublication(await readAuthoringRelease(dir), nextSnapshot);
    expect(restarted.publication.manifest).toEqual(after.publication.manifest);
    const corrupted = structuredClone(after);
    const unaffected = corrupted.publication.manifest.graphics!.groups.find(
      (g) => !changed.has(g.groupId),
    )!;
    unaffected.version = hash('unrelated-edit');
    expect(
      expectedStaticChange(
        release,
        { definition: before.world, manifest: before.publication.manifest },
        corrupted,
        owner,
      ),
    ).toBe(false);
  });
  it('validates private graphics hash/path/limits and includes it in authoring identity only', async () => {
    const f = cityLodFixture(),
      dir = join(directory, 'private');
    await writeWorldPublication(f.publication, dir);
    await writeAuthoringMetadata(
      f.world,
      f.publication.manifest,
      [],
      dir,
      undefined,
      jsonBytes(f.source),
    );
    const release = await readAuthoringRelease(dir);
    expect(release.manifest.graphics!.policyVersion).toBe(GRAPHICS_POLICY_VERSION);
    const meta = JSON.parse(await readFile(join(dir, 'authoring.json'), 'utf8'));
    meta.visual.file = '../source.json';
    await writeFile(join(dir, 'authoring.json'), jsonBytes(meta));
    await expect(readAuthoringRelease(dir)).rejects.toThrow('private visual reference');
  });
});
it.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'migrates a graphics-only release on a disposable database copy without reseeding or moving saved data',
  async () => {
    const detail = join(directory, 'detail'),
      lod = join(directory, 'lod');
    const beforeManifest = await buildWorld('content/worlds/physics-lab/world.json', detail);
    const nextManifest = await buildWorld('content/worlds/physics-lab/world.json', lod, {
      graphicsPolicy: 'two-level',
    });
    expect(nextManifest.simulationConfigHash).toBe(beforeManifest.simulationConfigHash);
    const fixture = await createDatabaseFixture(),
      owners: WorldOwnership[] = [];
    const prepare = async (dir: string, allow = false) => {
      const owner = new WorldOwnership(fixture.pool, 'physics-lab', randomUUID());
      owners.push(owner);
      return prepareLayoutWorld(dir, owner, allow);
    };
    const saved = async () => ({
      instances: (
        await fixture.pool.query('SELECT * FROM world_static_instances ORDER BY entity_id')
      ).rows,
      items: (await fixture.pool.query('SELECT * FROM item_instances ORDER BY id')).rows,
      slots: (await fixture.pool.query('SELECT * FROM inventory_slots ORDER BY id')).rows,
      positions: (await fixture.pool.query('SELECT * FROM player_positions ORDER BY account_id'))
        .rows,
      schema: (await fixture.pool.query('SELECT * FROM su_schema_migrations ORDER BY version'))
        .rows,
    });
    try {
      const initial = await prepare(detail);
      const items = await initial.items.initialize(),
        accountId = randomUUID();
      await fixture.pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
      await initial.items.operation(
        accountId,
        randomUUID(),
        { kind: 'pickup', itemId: items[0].entityId },
        () => undefined,
      );
      await fixture.pool.query(
        'INSERT INTO player_positions(account_id,world_id,x,y,z,write_epoch,write_sequence) VALUES($1,$2,0,0,-10,$3,3)',
        [accountId, 'physics-lab', owners.at(-1)!.epoch],
      );
      const state = await saved();
      const snapshot = structuredClone(initial.snapshot),
        compatibility = worldCompatibility(initial.definition);
      await initial.items.close();
      await owners.at(-1)!.close();
      await expect(prepare(lod)).rejects.toThrow('Asset release changed');
      await owners.at(-1)!.close();
      const migration = await prepare(lod, true);
      expect(migration.snapshot.instances).toEqual(snapshot.instances);
      expect(migration.release.metadata.assetReleaseVersion).not.toBe(
        initial.release.metadata.assetReleaseVersion,
      );
      expect(worldCompatibility(migration.definition)).toBe(compatibility);
      await migration.items.migrateGeometry(migration.commit);
      expect(await saved()).toEqual(state);
      await migration.items.close();
      await owners.at(-1)!.close();
      const restart = await prepare(lod);
      await restart.items.initialize();
      expect(await saved()).toEqual(state);
      expect(restart.manifest.graphics!.groups).toHaveLength(nextManifest.graphics!.groups.length);
      await restart.items.close();
    } finally {
      for (const owner of owners) await owner.close();
      await fixture.close();
    }
  },
);
