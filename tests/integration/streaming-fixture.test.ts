import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { ItemStore } from '../../apps/server/src/items/store.js';
import { worldCellAt } from '../../packages/contracts/src/index.js';
import { buildStreamingFixture, seedStreamingItemProfile } from '../helpers/streaming-world.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';

const directories: string[] = [];
// Each city profile compiles the complete world twice. Spread also traverses
// eight routes with the real capsule controller across the modular fence bodies.
const cityFixtureTimeout = 120_000;
async function directory() {
  const path = await mkdtemp('/tmp/su-streaming-profile-test-');
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

it('keeps the existing synthetic profile reproducible and records its real item and scene counts', async () => {
  const first = await buildStreamingFixture(await directory(), 'spread');
  const repeated = await buildStreamingFixture(await directory(), 'spread');
  expect(first.manifest).toEqual(repeated.manifest);
  expect(first.profile.items).toBe('existing');
  expect(first.profile.seedItems).toHaveLength(1);
  expect(first.profile.seedItems[0].typeId).toBe('wooden-crate');
  expect(first.profile.scene).toMatchObject({
    buildings: 1600,
    statics: 256,
    assets: 4,
    cells: 256,
  });
});

it(
  'creates eight dispersed city seam routes after testing their complete capsule traversal',
  async () => {
    const fixture = await buildStreamingFixture(await directory(), 'spread', {
      content: 'ring-block',
    });
    expect(fixture.header.spawnPoints).toHaveLength(8);
    expect(Object.keys(fixture.profile.routes)).toHaveLength(8);
    expect(fixture.profile.cityRouteSamples).toBe(8 * 4 * 33);
    expect(fixture.profile.routeValidation).toContain('complete authoritative capsule traversal');
    for (const route of Object.values(fixture.profile.routes)) {
      const cells = new Set(
        route.map((point) => worldCellAt(fixture.manifest.bounds, fixture.manifest.grid, point)),
      );
      expect(cells.has(undefined)).toBe(false);
      expect(cells.size).toBeGreaterThanOrEqual(2);
    }
  },
  cityFixtureTimeout,
);

it.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'restores all city item types and several simultaneous moving snapshots from an isolated persistent store',
  async () => {
    const fixture = await buildStreamingFixture(await directory(), 'crowd', {
      content: 'ring-block',
      items: 'all-types',
    });
    const database = await createDatabaseFixture();
    const restored = new ItemStore(database.pool, fixture.definition, randomUUID());
    try {
      const evidence = await seedStreamingItemProfile(database.pool, fixture);
      expect(fixture.profile.cityRouteSamples).toBeGreaterThan(300);
      expect(fixture.profile.routeValidation).toContain('5m crowd disk');
      expect(new Set(evidence.initialSnapshots.map((item) => item.typeId))).toEqual(
        new Set(Object.keys(fixture.definition.itemCatalog.types)),
      );
      expect(evidence.itemCount).toBe(5);
      expect(evidence.initialMovingItems).toHaveLength(4);
      const items = await restored.initialize();
      expect(items).toEqual(evidence.initialSnapshots);
      for (const item of items.filter((item) =>
        evidence.initialMovingItems.includes(item.entityId),
      )) {
        expect(item.velocity.y).toBe(1);
        expect(item.position.y - item.safePose.position.y).toBeCloseTo(0.4);
      }
      expect(
        (await database.pool.query('SELECT count(*)::int AS n FROM item_instances')).rows[0].n,
      ).toBe(5);
    } finally {
      await restored.close();
      await database.close();
    }
  },
  cityFixtureTimeout,
);
