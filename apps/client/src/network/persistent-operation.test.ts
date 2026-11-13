import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseItemCommand,
  parseStoredPlaceStaticRequest,
  STATIC_PLACEMENT_ASSET_ID,
  LEGACY_PLACEMENT_CATALOG_VERSION,
  type ItemCommand,
} from '@su/contracts';
import { PersistentOperation } from './persistent-operation';

let storage: Map<string, string>;
const command: ItemCommand = {
  operationId: 'operation-1',
  worldEpoch: 'epoch',
  action: { kind: 'pickup', itemId: 'crate-1' },
};
const operation = () => new PersistentOperation('su:item-operation', parseItemCommand);
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('persistent item and placement delivery', () => {
  it('reconciles a v13 pending bench without changing its UUID or preconditions across accounts', () => {
    const legacy = {
      operationId: '11111111-1111-4111-8111-111111111111',
      worldEpoch: 'previous-epoch',
      assetReleaseVersion: 'a'.repeat(64),
      expectedLayoutRevision: 7,
      position: { x: 4, z: -3 },
      yawStep: 11,
    };
    storage.set('su:static-operation:alice', JSON.stringify(legacy));
    const pending = new PersistentOperation('su:static-operation', parseStoredPlaceStaticRequest);
    pending.restore('alice');
    const migrated = {
      ...legacy,
      assetId: STATIC_PLACEMENT_ASSET_ID,
      placementCatalogVersion: LEGACY_PLACEMENT_CATALOG_VERSION,
    };
    expect(pending.current).toEqual(migrated);
    const send = vi.fn();
    pending.sendIfDue(0, send);
    pending.sendIfDue(3000, send);
    expect(send.mock.calls).toEqual([[migrated], [migrated]]);
    pending.restore('bob');
    expect(pending.current).toBeUndefined();
    expect(storage.has('su:static-operation:alice')).toBe(true);
    pending.restore('alice');
    expect(pending.current).toEqual(migrated);
    pending.complete();
    expect(storage.has('su:static-operation:alice')).toBe(false);
  });
  it('retries the same ID with bounded frequency and restores it after a new session', () => {
    const first = operation();
    const send = vi.fn();
    first.begin(command, 'alice');
    first.sendIfDue(100, send);
    first.sendIfDue(3099, send);
    expect(send).toHaveBeenCalledTimes(1);
    first.sendIfDue(3100, send);
    expect(send).toHaveBeenNthCalledWith(2, command);
    first.reset();
    const restored = operation();
    restored.restore('alice');
    expect(restored.current).toEqual(command);
    restored.complete();
    expect(storage.has('su:item-operation:alice')).toBe(false);
    restored.sendIfDue(10_000, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retains live operations across reconnect when browser storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage unavailable');
      },
      removeItem: () => {
        throw new Error('storage unavailable');
      },
    });
    const pending = operation();
    pending.begin(command, 'alice');
    pending.restore('alice');
    expect(pending.current).toEqual(command);
    pending.complete();
    expect(pending.current).toBeUndefined();
  });

  it('never replays another account’s operation and ignores malformed saved data', () => {
    const pending = operation();
    pending.begin(command, 'alice');
    pending.restore('bob');
    expect(pending.current).toBeUndefined();
    storage.set('su:item-operation:bob', JSON.stringify({ operationId: 'broken' }));
    pending.restore('bob');
    expect(pending.current).toBeUndefined();
    pending.restore('alice');
    expect(pending.current).toEqual(command);
  });
});
