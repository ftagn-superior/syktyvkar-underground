import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson,
  validateWorldLayoutSnapshot,
  type WorldLayoutSnapshot,
} from '../../packages/contracts/src/index.js';
import {
  readAuthoringRelease,
  editableStaticAssetIds,
  layoutHash,
  createLayoutPublication,
} from '../../apps/server/src/layout/release.js';
import { ItemStore } from '../../apps/server/src/items/store.js';
import { WorldOwnership } from '../../apps/server/src/world-ownership.js';
import { createGameServer } from './game-server.js';
import { createAccountFixture } from './account-fixture.js';

/** Exact saved static state, synthetic empty dynamics/accounts, fresh disposable SQL schema. */
export async function createSavedTerrainServer(options: {
  worldDirectory: string;
  snapshotFile: string;
  expectedMapVersion: string;
}) {
  assert.ok(process.env.SU_TEST_DATABASE_URL);
  const snapshot: WorldLayoutSnapshot = JSON.parse(await readFile(options.snapshotFile, 'utf8'));
  validateWorldLayoutSnapshot(snapshot);
  const temporary = await mkdtemp(join(tmpdir(), 'su-saved-terrain-controls-'));
  const directory = join(temporary, 'world');
  const accounts = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
  let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
  try {
    await cp(options.worldDirectory, directory, { recursive: true });
    const authored = await readAuthoringRelease(directory);
    assert.equal(authored.metadata.assetReleaseVersion, snapshot.assetReleaseVersion);
    assert.equal(authored.manifest.worldId, snapshot.worldId);
    const exact = await createLayoutPublication(authored, snapshot);
    assert.equal(exact.publication.manifest.mapVersion, options.expectedMapVersion);
    const ownership = new WorldOwnership(accounts.pool, snapshot.worldId, randomUUID());
    try {
      const items = new ItemStore(
        accounts.pool,
        { ...exact.world, initialItems: [] },
        ownership.epoch,
        ownership,
      );
      assert.deepEqual(await items.initialize(), []);
      const db = ownership.db;
      await db.query('BEGIN');
      try {
        await db.query(
          `INSERT INTO world_layouts(world_id,asset_release_version,seed_version,asset_ids,fixed_entity_ids,revision,validated_revision,validated_hash) VALUES($1,$2,$3,$4,$5,$6,$6,$7)`,
          [
            snapshot.worldId,
            snapshot.assetReleaseVersion,
            snapshot.seedVersion,
            editableStaticAssetIds(authored),
            [
              ...authored.metadata.fixedInstanceIds,
              ...authored.definition.entities.map((i) => i.entityId),
            ],
            snapshot.revision,
            layoutHash(snapshot),
          ],
        );
        await db.query('ALTER TABLE world_static_instances DISABLE TRIGGER USER');
        await db.query(
          `INSERT INTO world_static_instances(world_id,entity_id,asset_id,position_x,position_y,position_z,rotation_x,rotation_y,rotation_z,rotation_w,instance_revision,enabled,source_ref)
          SELECT $1,x->>'entityId',x->>'assetId',(x->'position'->>'x')::double precision,(x->'position'->>'y')::double precision,(x->'position'->>'z')::double precision,(x->'rotation'->>'x')::double precision,(x->'rotation'->>'y')::double precision,(x->'rotation'->>'z')::double precision,(x->'rotation'->>'w')::double precision,(x->>'instanceRevision')::integer,(x->>'enabled')::boolean,x->'sourceRef' FROM jsonb_array_elements($2::jsonb) x`,
          [snapshot.worldId, canonicalJson(snapshot.instances)],
        );
        await db.query('ALTER TABLE world_static_instances ENABLE TRIGGER USER');
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    } finally {
      await ownership.close();
    }
    app = await createGameServer({ port: 0, accounts, worldDirectory: directory });
    accounts.config.publicOrigin = app.url;
    const info = await fetch(`${app.url}/api/world`).then((r) => r.json());
    assert.equal(
      info.mapVersion,
      options.expectedMapVersion,
      'Fixture served a different static map',
    );
    let closing: Promise<void> | undefined;
    const server = app;
    return {
      ...server,
      accounts,
      info,
      close: () =>
        (closing ??= server.close().finally(async () => {
          await accounts.close();
          await rm(temporary, { recursive: true, force: true });
        })),
    };
  } catch (error) {
    await app?.close();
    await accounts.close();
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
