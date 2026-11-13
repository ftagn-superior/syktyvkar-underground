import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createWorldLayoutPatch,
  type WorldLayoutSnapshot,
} from '../../packages/contracts/src/index.js';
import {
  hash,
  jsonBytes,
  writeAuthoringMetadata,
  writeWorldPublication,
} from '../../packages/world-release/src/index.js';
import type { FoundationSupportRuleV2 } from '../../packages/terrain-build/src/private-data.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import {
  createLayoutPublication,
  editableStaticAssetIds,
  readAuthoringRelease,
  terrainSupportId,
  type AuthoringRelease,
} from '../../apps/server/src/layout/release.js';
import { readWorldDirectory } from '../../apps/server/src/world-bundle.js';
import { prepareLayoutWorld } from '../../apps/server/src/layout/prepare.js';
import { applyStaticLayoutPatch } from '../../apps/server/src/layout/patch.js';
import { StaticLayoutStore } from '../../apps/server/src/layout/store.js';
import { WorldOwnership } from '../../apps/server/src/world-ownership.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';

const placedId = 'placed_12345678-1234-1234-1234-123456789abc';
const defaultRule: FoundationSupportRuleV2 = {
  kind: 'foundation-v2',
  assetId: 'house-a',
  components: [
    {
      outline: [
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
      ],
      holes: [
        [
          [-0.5, -0.5],
          [-0.5, 0.5],
          [0.5, 0.5],
          [0.5, -0.5],
        ],
      ],
    },
  ],
  jointY: 0,
  clearance: 0.1,
  burial: 0.05,
  color: '#8b8580',
  approaches: [
    {
      id: 'entry',
      edge: [
        [-1, -2],
        [1, -2],
      ],
      outward: [0, -1],
      length: 2,
      targetY: 0,
      color: '#b5afa1',
    },
  ],
};
const smallRule: FoundationSupportRuleV2 = {
  ...defaultRule,
  components: [
    {
      outline: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
    },
  ],
  approaches: [],
  color: '#667788',
};
let temporary: string, plain: AuthoringRelease, release: AuthoringRelease;
const sidecar = (supports: FoundationSupportRuleV2[]) => ({
  formatVersion: 2,
  generatorVersion: 'terrain-build/2',
  worldId: plain.definition.worldId,
  grid: {
    formatVersion: 1,
    origin: { x: -20, z: -20 },
    spacing: 2,
    columns: 21,
    rows: 21,
    heights: Array(21 * 21).fill(0),
    bottom: -2,
  },
  supports,
});

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'database terrain support lifecycle on a disposable fixture',
  () => {
    let database: Awaited<ReturnType<typeof createDatabaseFixture>>;
    let snapshot: WorldLayoutSnapshot;
    async function owned<T>(run: (owner: WorldOwnership) => Promise<T>) {
      const owner = new WorldOwnership(database.pool, release.definition.worldId, randomUUID());
      try {
        return await run(owner);
      } finally {
        await owner.close();
      }
    }
    async function edit(mutator: (snapshot: WorldLayoutSnapshot) => void) {
      const next = structuredClone(snapshot);
      mutator(next);
      const patch = createWorldLayoutPatch(snapshot, next);
      const result = await owned((owner) =>
        applyStaticLayoutPatch(release.directory, owner, patch),
      );
      snapshot = result.snapshot;
      return result;
    }
    async function restart() {
      return owned(async (owner) => {
        const prepared = await prepareLayoutWorld(release.directory, owner);
        await prepared.items.initialize();
        return prepared;
      });
    }
    async function state() {
      return {
        layout: (await database.pool.query('SELECT * FROM world_layouts ORDER BY world_id')).rows,
        instances: (
          await database.pool.query('SELECT * FROM world_static_instances ORDER BY entity_id')
        ).rows,
        operations: (
          await database.pool.query(
            'SELECT * FROM world_static_operations ORDER BY layout_revision,entity_id',
          )
        ).rows,
        items: (await database.pool.query('SELECT * FROM item_instances ORDER BY id')).rows,
        slots: (await database.pool.query('SELECT * FROM inventory_slots ORDER BY id')).rows,
        worlds: (await database.pool.query('SELECT * FROM persistent_worlds ORDER BY id')).rows,
      };
    }
    beforeEach(async () => {
      database = await createDatabaseFixture();
      snapshot = await owned(async (owner) => {
        const prepared = await prepareLayoutWorld(plain.directory, owner);
        await prepared.items.initialize();
        return structuredClone(prepared.snapshot);
      });
      const raised = structuredClone(snapshot);
      raised.instances.find((i) => i.entityId === 'building-a')!.position.y = 2;
      await owned((owner) =>
        applyStaticLayoutPatch(plain.directory, owner, createWorldLayoutPatch(snapshot, raised)),
      );
      snapshot = await owned(async (owner) => {
        const prepared = await prepareLayoutWorld(release.directory, owner, true);
        await prepared.items.migrateGeometry(prepared.commit);
        return structuredClone(prepared.snapshot);
      });
    });
    afterEach(async () => {
      await database?.close();
    });

    it('rebuilds current owner changes after restart without storing derived rows or reseeding a deletion', async () => {
      const initialSeedVersion = snapshot.seedVersion;
      const initial = await restart();
      const firstVersion = initial.manifest.assets[derivedIds()[0]].version;
      await edit((next) => {
        const owner = next.instances.find((i) => i.entityId === 'building-a')!;
        owner.position = { x: -6, y: 2.5, z: -8 };
        owner.rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
      });
      expect((await restart()).manifest.assets[derivedIds()[0]].version).not.toBe(firstVersion);
      await edit((next) => {
        next.instances.find((i) => i.entityId === 'building-a')!.enabled = false;
      });
      expect((await restart()).manifest.assets[derivedIds()[0]]).toBeUndefined();
      await edit((next) => {
        next.instances.find((i) => i.entityId === 'building-a')!.enabled = true;
      });
      expect((await restart()).manifest.assets[derivedIds()[0]]).toBeDefined();
      await edit((next) => {
        next.instances.find((i) => i.entityId === 'building-a')!.assetId = 'house-b';
      });
      expect((await restart()).manifest.assets[derivedIds()[0]]).toBeUndefined();
      await edit((next) => {
        next.instances = next.instances.filter((i) => i.entityId !== 'building-a');
      });
      const deleted = await restart();
      expect(deleted.snapshot.instances.some((i) => i.entityId === 'building-a')).toBe(false);
      expect(deleted.definition.buildings.some((i) => i.entityId === 'building-a')).toBe(false);
      await edit((next) => {
        next.instances.push({
          entityId: placedId,
          assetId: 'house-a',
          position: { x: 0, y: 2, z: 10 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          instanceRevision: 1,
          enabled: true,
        });
      });
      const placed = await restart();
      expect(placed.manifest.assets[derivedIds(placedId)[0]]).toBeDefined();
      expect(placed.snapshot.seedVersion).toBe(initialSeedVersion);
      const rows = (
        await database.pool.query('SELECT entity_id FROM world_static_instances ORDER BY entity_id')
      ).rows;
      expect(rows.map((row) => row.entity_id)).toEqual(['building-b', placedId].sort());
      expect(rows.some((row) => row.entity_id.startsWith('support-'))).toBe(false);
    });

    it('keeps rows, compatibility and saved items unchanged on low-pose rejection and an injected write failure', async () => {
      const before = await state();
      const low = structuredClone(snapshot);
      low.instances.find((i) => i.entityId === 'building-a')!.position.y = 0;
      const lowPatch = createWorldLayoutPatch(snapshot, low);
      for (const dryRun of [true, false])
        await expect(
          owned((owner) => applyStaticLayoutPatch(release.directory, owner, lowPatch, dryRun)),
        ).rejects.toThrow(/support|pose|minimum|clearance|height/i);
      expect(await state()).toEqual(before);
      const moved = structuredClone(snapshot);
      moved.instances.find((i) => i.entityId === 'building-a')!.position.x += 1;
      const patch = createWorldLayoutPatch(snapshot, moved);
      await database.pool
        .query(`CREATE FUNCTION reject_support_move() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.entity_id='building-a' THEN RAISE EXCEPTION 'injected support move failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_support_move AFTER UPDATE ON world_static_instances
        FOR EACH ROW EXECUTE FUNCTION reject_support_move();`);
      try {
        await expect(
          owned((owner) => applyStaticLayoutPatch(release.directory, owner, patch)),
        ).rejects.toThrow('injected support move failure');
      } finally {
        await database.pool.query(
          'DROP TRIGGER reject_support_move ON world_static_instances; DROP FUNCTION reject_support_move();',
        );
      }
      expect(await state()).toEqual(before);
      const current = await owned(async (owner) => {
        await owner.connect();
        return new StaticLayoutStore(owner, release).readCandidate();
      });
      expect(current.snapshot).toEqual(snapshot);
    });
  },
);
async function releaseWithRules(name: string, rules: FoundationSupportRuleV2[]) {
  const directory = join(temporary, name);
  await cp(plain.directory, directory, { recursive: true });
  await writeAuthoringMetadata(
    plain.definition,
    plain.manifest,
    plain.metadata.fixedInstanceIds,
    directory,
    jsonBytes(sidecar(rules)),
  );
  return readAuthoringRelease(directory);
}
function snapshotFor(authored = release): WorldLayoutSnapshot {
  const instances = structuredClone(authored.seed);
  for (const instance of instances) instance.position.y = 2;
  return {
    formatVersion: 1,
    worldId: authored.definition.worldId,
    assetReleaseVersion: authored.metadata.assetReleaseVersion,
    seedVersion: authored.metadata.seedVersion,
    revision: 5214,
    instances,
  };
}
const derivedIds = (owner = 'building-a') => [
  terrainSupportId(release.definition.worldId, owner, 'foundation'),
  terrainSupportId(release.definition.worldId, owner, 'approach:entry'),
];
const generated = (prepared: Awaited<ReturnType<typeof createLayoutPublication>>) =>
  prepared.world.buildings.filter(
    (instance) => !Object.hasOwn(plain.manifest.assets, instance.assetId),
  );

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'su-terrain-support-release-'));
  const directory = join(temporary, 'plain');
  await buildWorld('content/worlds/physics-lab/world.json', directory);
  plain = await readAuthoringRelease(directory);
  release = await releaseWithRules('derived', [defaultRule]);
});
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe('current-snapshot terrain support lifecycle', () => {
  it('keeps dynamic supports out of the authored seed/catalog and publishes deterministic private-free resources', async () => {
    const snapshot = snapshotFor();
    const before = canonicalJson({ snapshot, seed: release.seed, definition: release.definition });
    const first = await createLayoutPublication(release, snapshot);
    const reordered = { ...snapshot, instances: [...snapshot.instances].reverse() };
    const second = await createLayoutPublication(release, reordered);
    expect(second.publication.manifest).toEqual(first.publication.manifest);
    expect(second.publication.payloads).toEqual(first.publication.payloads);
    expect(canonicalJson({ snapshot, seed: release.seed, definition: release.definition })).toBe(
      before,
    );
    expect(release.seed).toEqual(plain.seed);
    expect(release.metadata.seedVersion).toBe(plain.metadata.seedVersion);
    expect(release.manifest).toEqual(plain.manifest);
    expect(editableStaticAssetIds(release)).toEqual(editableStaticAssetIds(plain));
    expect(
      generated(first)
        .map((i) => i.entityId)
        .sort(),
    ).toEqual(derivedIds().sort());
    for (const instance of generated(first)) {
      expect(instance.entityId).toMatch(/^[a-z0-9-]{1,80}$/);
      expect(instance.assetId).toBe(instance.entityId);
      expect(instance.position).toEqual({ x: 0, y: 0, z: 0 });
      expect(instance.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
      expect(first.publication.manifest.assets[instance.assetId]).toBeDefined();
    }
    expect(
      Object.keys(first.publication.manifest.files).some((path) => path.startsWith('private/')),
    ).toBe(false);
    const output = join(temporary, 'published-current');
    await writeWorldPublication(first.publication, output);
    const loaded = await readWorldDirectory(output);
    expect(loaded.manifest).toEqual(first.publication.manifest);
    expect(loaded.definition.buildings.map((i) => i.entityId).sort()).toEqual(
      first.world.buildings.map((i) => i.entityId).sort(),
    );
  });

  it('rebuilds a moved and rotated owner under stable IDs without old poses or resource versions', async () => {
    const initial = snapshotFor();
    const first = await createLayoutPublication(release, initial);
    const moved = structuredClone(initial);
    const owner = moved.instances.find((i) => i.entityId === 'building-a')!;
    owner.position = { x: -6, y: 2.5, z: -8 };
    owner.rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    owner.instanceRevision++;
    moved.revision++;
    const second = await createLayoutPublication(release, moved);
    expect(
      generated(second)
        .map((i) => i.entityId)
        .sort(),
    ).toEqual(derivedIds().sort());
    expect(second.world.buildings.find((i) => i.entityId === owner.entityId)?.position).toEqual(
      owner.position,
    );
    for (const id of derivedIds()) {
      const old = first.publication.manifest.assets[id];
      const current = second.publication.manifest.assets[id];
      expect(current.version).not.toBe(old.version);
      expect(Object.hasOwn(second.publication.manifest.files, old.modelFile!)).toBe(false);
      expect(second.world.buildingAssets[id].bounds).not.toEqual(
        first.world.buildingAssets[id].bounds,
      );
    }
    expect(release.seed).toEqual(plain.seed);
    expect((await createLayoutPublication(release, initial)).publication.manifest).toEqual(
      first.publication.manifest,
    );
  });

  it.each(['disable', 'delete', 'model swap'] as const)(
    'removes owner supports on %s and never repopulates them from the seed',
    async (operation) => {
      const snapshot = snapshotFor();
      const first = await createLayoutPublication(release, snapshot);
      const edited = structuredClone(snapshot);
      const owner = edited.instances.find((i) => i.entityId === 'building-a')!;
      if (operation === 'disable') owner.enabled = false;
      else if (operation === 'delete')
        edited.instances = edited.instances.filter((i) => i !== owner);
      else owner.assetId = 'house-b';
      const result = await createLayoutPublication(release, edited);
      expect(generated(result)).toEqual([]);
      for (const id of derivedIds()) {
        expect(result.world.buildingAssets[id]).toBeUndefined();
        expect(result.publication.manifest.assets[id]).toBeUndefined();
        expect(
          Object.hasOwn(
            result.publication.manifest.files,
            first.publication.manifest.assets[id].modelFile!,
          ),
        ).toBe(false);
      }
      expect(result.publication.manifest.assets['house-a']).toEqual(
        release.manifest.assets['house-a'],
      );
      expect(edited.seedVersion).toBe(snapshot.seedVersion);
      if (operation === 'disable') {
        owner.enabled = true;
        expect((await createLayoutPublication(release, edited)).publication.manifest).toEqual(
          first.publication.manifest,
        );
      }
    },
  );

  it('uses the replacement model rule after model swap and drops obsolete approaches', async () => {
    const authored = await releaseWithRules('two-models', [
      defaultRule,
      { ...smallRule, assetId: 'house-b' },
    ]);
    const snapshot = snapshotFor(authored);
    snapshot.instances = snapshot.instances.filter((i) => i.entityId === 'building-a');
    const before = await createLayoutPublication(authored, snapshot);
    snapshot.instances[0].assetId = 'house-b';
    const after = await createLayoutPublication(authored, snapshot);
    const [foundation, approach] = derivedIds();
    expect(generated(after).map((i) => i.entityId)).toEqual([foundation]);
    expect(after.publication.manifest.assets[foundation].version).not.toBe(
      before.publication.manifest.assets[foundation].version,
    );
    expect(after.publication.manifest.assets[approach]).toBeUndefined();
  });

  it('supports a newly placed UUID and selects its matching owner override ahead of the model default', async () => {
    const authored = await releaseWithRules('placed-override', [
      defaultRule,
      { ...smallRule, ownerId: placedId },
    ]);
    const snapshot = snapshotFor(authored);
    snapshot.instances.push({
      ...structuredClone(snapshot.instances[0]),
      entityId: placedId,
      position: { x: 0, y: 2, z: 10 },
      sourceRef: { provider: 'manual', type: 'house', id: 'saved-owner' },
    });
    const result = await createLayoutPublication(authored, snapshot);
    const [foundation, approach] = derivedIds(placedId);
    expect(result.publication.manifest.assets[foundation]).toBeDefined();
    expect(result.publication.manifest.assets[approach]).toBeUndefined();
    const bounds = result.world.buildingAssets[foundation].bounds;
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(2, 5);
    expect(result.world.buildings.find((i) => i.entityId === placedId)?.sourceRef).toEqual(
      snapshot.instances.at(-1)!.sourceRef,
    );
    expect(authored.seed.some((i) => i.entityId === placedId)).toBe(false);
  });

  it('rejects a low absolute pose without mutating Y and allows disabling the invalid owner', async () => {
    const snapshot = snapshotFor();
    snapshot.instances[0].position.y = 0;
    const before = canonicalJson(snapshot);
    await expect(createLayoutPublication(release, snapshot)).rejects.toThrow(
      /support|pose|minimum|clearance|height/i,
    );
    expect(canonicalJson(snapshot)).toBe(before);
    snapshot.instances[0].enabled = false;
    expect(generated(await createLayoutPublication(release, snapshot))).toEqual([]);
  });

  it('rejects generated ID collisions with independent owners, including disabled records', async () => {
    const snapshot = snapshotFor();
    snapshot.instances.push({
      ...structuredClone(snapshot.instances[1]),
      entityId: derivedIds()[0],
      enabled: false,
    });
    await expect(createLayoutPublication(release, snapshot)).rejects.toThrow(
      'Reserved/duplicate terrain support ID',
    );
  });

  it('rejects using a generated support asset as an editable model', async () => {
    const snapshot = snapshotFor();
    const built = await createLayoutPublication(release, snapshot);
    snapshot.instances.push({
      ...structuredClone(snapshot.instances[1]),
      entityId: 'independent-copy',
      assetId: generated(built)[0].assetId,
    });
    await expect(createLayoutPublication(release, snapshot)).rejects.toThrow(
      'Unknown static asset',
    );
  });

  it('bundles the server generator and rebuilds from only dist release files in an empty working directory', async () => {
    const sandbox = join(temporary, 'standalone');
    const empty = join(sandbox, 'empty');
    const distRelease = join(sandbox, 'dist', 'worlds', release.definition.worldId);
    await mkdir(empty, { recursive: true });
    await cp(release.directory, distRelease, { recursive: true });
    const snapshot = snapshotFor();
    const layoutFile = join(sandbox, 'snapshot.json');
    await writeFile(layoutFile, jsonBytes(snapshot));
    const expected = await createLayoutPublication(release, snapshot);
    const entry = join(sandbox, 'server.mjs');
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
        import { readFile } from 'node:fs/promises';
        import { readAuthoringRelease, createLayoutPublication } from ${JSON.stringify(resolve('apps/server/src/layout/release.ts'))};
        const release = await readAuthoringRelease(process.argv[2]);
        const snapshot = JSON.parse(await readFile(process.argv[3], 'utf8'));
        const result = await createLayoutPublication(release, snapshot);
        console.log(JSON.stringify({ manifest: result.publication.manifest, world: result.world }));
      `,
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      outfile: entry,
      metafile: true,
    });
    expect(
      Object.keys(bundle.metafile!.inputs).some((path) => /(?:^|\/)(tools|content)\//.test(path)),
    ).toBe(false);
    expect(
      Object.keys(bundle.metafile!.inputs).some((path) =>
        path.endsWith('terrain-build/src/supports.ts'),
      ),
    ).toBe(true);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [entry, distRelease, layoutFile],
      { cwd: empty, maxBuffer: 8 * 1024 * 1024 },
    );
    const actual = JSON.parse(stdout);
    expect(actual.manifest).toEqual(expected.publication.manifest);
    expect(actual.world).toEqual(expected.world);
    expect(hash(await readFile(layoutFile))).toBe(hash(jsonBytes(snapshot)));
  });
});
