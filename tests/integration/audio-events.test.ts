import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ItemStore } from '../../apps/server/src/items/store.js';
import { ItemRuntime, type ItemSound } from '../../apps/server/src/items/runtime.js';
import { createAuthoritativeWorld } from '../../packages/simulation/src/server.js';
import { physicsFixture } from '../../packages/simulation/src/test-fixture.js';
import { createDatabaseFixture } from '../helpers/database-fixture.js';
import type { ItemCommand } from '../../packages/contracts/src/index.js';

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'durable item sound publication (isolated PostgreSQL)',
  () => {
    it('publishes fresh pickup and place once, keeps metadata, and does not sound an uncertain commit replay', async () => {
      const database = await createDatabaseFixture();
      const definition = physicsFixture();
      definition.initialItems[0].position.z = 2;
      const world = await createAuthoritativeWorld({ ...definition, initialItems: [] });
      const accountId = randomUUID(),
        epoch = randomUUID();
      const store = new ItemStore(database.pool, definition, epoch);
      const sounds: ItemSound[] = [];
      const runtime = new ItemRuntime(
        store,
        world,
        () => {},
        (sound) => {
          expect(world.getSnapshot().items.some((item) => item.entityId === sound.entityId)).toBe(
            sound.kind === 'place',
          );
          sounds.push(sound);
        },
      );
      try {
        await database.pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
        await runtime.initialize();
        expect(world.addPlayer('actor')).toBeDefined();
        const initial = world.getSnapshot().items[0];
        const pickup: ItemCommand = {
          operationId: randomUUID(),
          worldEpoch: epoch,
          action: { kind: 'pickup', itemId: initial.entityId },
        };
        expect((await runtime.command(accountId, 'actor', pickup, () => undefined)).ok).toBe(true);
        await runtime.command(accountId, 'actor', pickup, () => 'AUTH_REQUIRED');
        expect(sounds).toHaveLength(1);
        expect(sounds[0]).toMatchObject({
          kind: 'pickup',
          actorId: 'actor',
          entityId: initial.entityId,
          typeId: 'wooden-crate',
          operationId: pickup.operationId,
          position: initial.position,
        });

        const place: ItemCommand = {
          operationId: randomUUID(),
          worldEpoch: epoch,
          action: {
            kind: 'place',
            itemId: initial.entityId,
            pose: { position: initial.position, rotation: initial.rotation },
          },
        };
        expect((await runtime.command(accountId, 'actor', place, () => undefined)).ok).toBe(true);
        await runtime.command(accountId, 'actor', place, () => undefined);
        expect(sounds).toHaveLength(2);
        expect(sounds[1]).toMatchObject({
          kind: 'place',
          typeId: 'wooden-crate',
          position: initial.position,
          operationId: place.operationId,
        });

        const original = store.operation.bind(store);
        const spy = vi.spyOn(store, 'operation').mockImplementationOnce(async (...args) => {
          await original(...args);
          throw new Error('Lost successful operation response');
        });
        try {
          const recovered = await runtime.command(
            accountId,
            'actor',
            { ...pickup, operationId: randomUUID() },
            () => undefined,
          );
          expect(recovered.ok).toBe(true);
          expect(world.getSnapshot().items).toEqual([]);
          expect(sounds).toHaveLength(2);
        } finally {
          spy.mockRestore();
        }
      } finally {
        await runtime.close();
        world.dispose();
        await database.close();
      }
    });
  },
);
