import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { initialItemState, type ItemCommand, type ItemState } from '@su/contracts';
import type { AuthoritativeWorld } from '@su/simulation/server';
import { physicsFixture } from '../../../../packages/simulation/src/test-fixture.js';
import type { WorldOwnership } from '../world-ownership.js';
import { ItemStore, ItemRejection } from './store.js';
import { ItemRuntime, type ItemSound } from './runtime.js';

describe('item sounds respect durable operation identity', () => {
  it('calls the cosmetic callback only after a fresh successful COMMIT, never on ledger replay', async () => {
    const rows = new Map<string, { request: unknown; result: unknown }>();
    let staged: [string, { request: unknown; result: unknown }] | undefined;
    let loseCommitResponse = false;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT request,result')) {
        const row = rows.get(String(params![1]));
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.startsWith('INSERT INTO item_operations'))
        staged = [String(params![1]), { request: params![3], result: params![4] }];
      if (sql === 'COMMIT' && staged) {
        rows.set(...staged);
        staged = undefined;
        if (loseCommitResponse) {
          loseCommitResponse = false;
          throw new Error('Lost COMMIT response');
        }
      }
      return { rowCount: 0, rows: [] };
    });
    const store = new ItemStore({} as Pool, physicsFixture(), 'epoch', {
      db: { query } as unknown as PoolClient,
    } as WorldOwnership);
    const apply = vi
      .spyOn(store as unknown as { applyAction: () => Promise<undefined> }, 'applyAction')
      .mockResolvedValue(undefined);
    const callback = vi.fn(() => {
      expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    });
    const action = { kind: 'pickup' as const, itemId: 'crate-01' };
    expect(await store.operation('account', 'op-1', action, () => undefined, callback)).toEqual({
      operationId: 'op-1',
      ok: true,
    });
    expect(callback).toHaveBeenCalledTimes(1);
    await store.operation('account', 'op-1', action, () => 'AUTH_REQUIRED', callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);

    loseCommitResponse = true;
    await expect(
      store.operation('account', 'op-2', action, () => undefined, callback),
    ).rejects.toThrow('Lost COMMIT response');
    await store.operation('account', 'op-2', action, () => undefined, callback);
    expect(callback).toHaveBeenCalledTimes(1);

    apply.mockRejectedValueOnce(new ItemRejection('BLOCKED'));
    expect((await store.operation('account', 'op-3', action, () => undefined, callback)).ok).toBe(
      false,
    );
    expect(callback).toHaveBeenCalledTimes(1);
    await expect(
      store.operation(
        'account',
        'op-4',
        action,
        () => undefined,
        () => {
          throw new Error('audio failed');
        },
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it('publishes pickup/place metadata after reconciliation and skips successful retries', async () => {
    const definition = physicsFixture();
    const initial = initialItemState(definition.initialItems[0]);
    let stored = [initial],
      live = [initial];
    const completed = new Set<string>();
    const world = {
      getSnapshot: () => ({ scope: 'authoritative', players: [], items: live }),
      replaceItems: (items: ItemState[]) => {
        live = items;
      },
      reconcileItems: (items: ItemState[]) => {
        live = items;
      },
      checkPickup: () => undefined,
      checkPlacement: () => undefined,
    } as unknown as AuthoritativeWorld;
    const store = {
      initialize: async () => stored,
      connect: async () => {},
      close: async () => {},
      save: async () => {},
      worldItems: async () => stored,
      operation: async (
        _account: string,
        id: string,
        action: ItemCommand['action'],
        validate: (action: ItemCommand['action'], typeId?: string) => unknown,
        fresh: () => void,
      ) => {
        if (!completed.has(id)) {
          validate(action);
          validate(action, initial.typeId);
          if (action.kind === 'pickup') stored = [];
          if (action.kind === 'place')
            stored = [
              { ...initial, ...action.pose, placementVersion: initial.placementVersion + 1 },
            ];
          completed.add(id);
          fresh();
        }
        return { operationId: id, ok: true };
      },
    } as unknown as ItemStore;
    const sounds: ItemSound[] = [];
    const runtime = new ItemRuntime(
      store,
      world,
      () => {},
      (sound) => {
        expect(live.some((item) => item.entityId === initial.entityId)).toBe(
          sound.kind === 'place',
        );
        sounds.push(sound);
      },
    );
    await runtime.initialize();
    try {
      const pickup: ItemCommand = {
        operationId: 'pickup',
        worldEpoch: 'epoch',
        action: { kind: 'pickup', itemId: initial.entityId },
      };
      await runtime.command('account', 'actor-entity', pickup, () => undefined);
      await runtime.command('account', 'actor-entity', pickup, () => undefined);
      const place: ItemCommand = {
        operationId: 'place',
        worldEpoch: 'epoch',
        action: {
          kind: 'place',
          itemId: initial.entityId,
          pose: { position: { x: 2, y: 0.52, z: 3 }, rotation: initial.rotation },
        },
      };
      await runtime.command('account', 'actor-entity', place, () => undefined);
      await runtime.command('account', 'actor-entity', place, () => undefined);
      expect(sounds).toHaveLength(2);
      expect(sounds[0]).toMatchObject({
        kind: 'pickup',
        entityId: initial.entityId,
        typeId: initial.typeId,
        position: initial.position,
        operationId: 'pickup',
        actorId: 'actor-entity',
        strength: 1,
      });
      expect(sounds[1]).toMatchObject({
        kind: 'place',
        operationId: 'place',
        position: { x: 2, y: 0.52, z: 3 },
      });
    } finally {
      await runtime.close();
    }
  });
});
