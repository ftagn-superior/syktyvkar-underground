import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PlayerPositionRuntime } from './position-runtime.js';
import type {
  PlayerPositionSnapshot,
  PositionLoadResult,
  PositionWriteResult,
} from './position-store.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<ConstructorParameters<typeof PlayerPositionRuntime>[0]> = {}) {
  const store = {
    load: vi.fn<(accountId: string, worldId: string) => Promise<PositionLoadResult>>(async () => ({
      status: 'missing',
    })),
    save: vi.fn<(snapshot: PlayerPositionSnapshot) => Promise<PositionWriteResult>>(
      async () => 'saved',
    ),
    abort: vi.fn(),
  };
  const onOwnershipLost = vi.fn();
  const runtime = new PlayerPositionRuntime({
    pool: {} as Pool,
    worldId: 'position-unit-world',
    writeEpoch: randomUUID(),
    isAccountActive: () => false,
    onOwnershipLost,
    store,
    retryMs: 30,
    loadTimeoutMs: 30,
    closeTimeoutMs: 500,
    ...overrides,
  });
  return { runtime, store, onOwnershipLost };
}

describe('player position coalescing runtime', () => {
  it('copies captured positions and gives immediate re-entry the latest uncommitted snapshot', async () => {
    const { runtime } = fixture();
    const account = randomUUID();
    const position = { x: 12, y: 0.92, z: -4 };
    const returned = runtime.capture(account, position);
    position.x = 99;
    returned.position.x = 88;
    expect(await runtime.loadForJoin(account)).toMatchObject({
      status: 'found',
      snapshot: { position: { x: 12, y: 0.92, z: -4 }, writeSequence: 1 },
    });
    await runtime.close();
    expect(runtime.diagnostics()).toMatchObject({ pendingAccounts: 0, writes: 1 });
  });

  it('coalesces writes and does not let an old acknowledgement delete the new snapshot', async () => {
    const { runtime, store } = fixture();
    const first = deferred<PositionWriteResult>();
    store.save.mockImplementationOnce(() => first.promise);
    const account = randomUUID();
    runtime.capture(account, { x: 1, y: 1, z: 1 });
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    runtime.capture(account, { x: 2, y: 1, z: 1 });
    runtime.capture(account, { x: 3, y: 1, z: 1 });
    first.resolve('saved');
    await runtime.close();
    expect(store.save.mock.calls).toHaveLength(2);
    expect(
      store.save.mock.calls.map((args) => (args[0] as { writeSequence: number }).writeSequence),
    ).toEqual([1, 3]);
  });

  it('retains the newest position after a failed write and waits before retrying', async () => {
    const { runtime, store } = fixture({ retryMs: 100 });
    store.save.mockRejectedValueOnce(new Error('temporary storage failure'));
    const account = randomUUID();
    runtime.capture(account, { x: 1, y: 1, z: 1 });
    await vi.waitFor(() => expect(runtime.diagnostics().writeErrors).toBe(1));
    runtime.capture(account, { x: 2, y: 1, z: 1 });
    expect(store.save).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.save.mock.calls[1][0]).toMatchObject({ position: { x: 2 } });
    expect(runtime.diagnostics()).toMatchObject({ retries: 1, pendingAccounts: 0 });
  });

  it('expires queued reads without starting SQL and keeps one operation active after an outer timeout', async () => {
    const { runtime, store } = fixture();
    const blocked = deferred<PositionWriteResult>();
    store.save.mockImplementationOnce(() => blocked.promise);
    runtime.capture(randomUUID(), { x: 1, y: 1, z: 1 });
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    expect(await runtime.loadForJoin(randomUUID())).toEqual({
      status: 'unavailable',
      reason: 'timeout',
    });
    expect(store.load).not.toHaveBeenCalled();
    expect(runtime.diagnostics().busy).toBe(true);
    blocked.resolve('saved');
    await runtime.close();
  });

  it('ignores a late read result and holds the worker slot until SQL actually completes', async () => {
    const { runtime, store } = fixture();
    const blocked = deferred<PositionLoadResult>();
    store.load.mockImplementationOnce(() => blocked.promise);
    const loaded = runtime.loadForJoin(randomUUID());
    await vi.waitFor(() => expect(store.load).toHaveBeenCalledTimes(1));
    expect(await loaded).toEqual({ status: 'unavailable', reason: 'timeout' });
    runtime.capture(randomUUID(), { x: 2, y: 1, z: 1 });
    expect(store.save).not.toHaveBeenCalled();
    blocked.resolve({ status: 'missing' });
    await runtime.close();
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(runtime.diagnostics()).toMatchObject({ readTimeouts: 1, pendingAccounts: 0 });
  });

  it('bounds pending accounts, evicts the oldest inactive snapshot and protects active players', async () => {
    const active = randomUUID();
    const { runtime } = fixture({ maxPendingAccounts: 3, isAccountActive: (id) => id === active });
    const inactive = [randomUUID(), randomUUID(), randomUUID()];
    runtime.capture(active, { x: 0, y: 1, z: 1 });
    for (const [index, account] of inactive.entries())
      runtime.capture(account, { x: index + 1, y: 1, z: 1 });
    expect(runtime.diagnostics()).toMatchObject({ pendingAccounts: 3, dropped: 1 });
    expect(await runtime.loadForJoin(active)).toMatchObject({ status: 'found' });
    expect(await runtime.loadForJoin(inactive[0])).toEqual({ status: 'missing' });
    await runtime.close();
  });

  it('stops retries and notifies the room once when the world epoch no longer belongs to it', async () => {
    const { runtime, store, onOwnershipLost } = fixture();
    store.save.mockResolvedValue('ownership-lost');
    runtime.capture(randomUUID(), { x: 1, y: 1, z: 1 });
    await vi.waitFor(() => expect(onOwnershipLost).toHaveBeenCalledTimes(1));
    await expect(runtime.close()).rejects.toThrow('ownership lost');
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(runtime.diagnostics()).toMatchObject({ ownershipLost: true });
  });

  it('bounds final flush, aborts the active operation and reuses the same close promise', async () => {
    const { runtime, store } = fixture({ closeTimeoutMs: 30 });
    const blocked = deferred<PositionWriteResult>();
    store.save.mockImplementationOnce(() => blocked.promise);
    store.abort.mockImplementation(() => blocked.reject(new Error('connection destroyed')));
    runtime.capture(randomUUID(), { x: 1, y: 1, z: 1 });
    const close = runtime.close();
    expect(runtime.close()).toBe(close);
    await expect(close).rejects.toThrow('exceeded deadline');
    expect(store.abort).toHaveBeenCalledTimes(1);
    expect(runtime.diagnostics().lastCloseError).toContain('exceeded deadline');
    expect(() => runtime.capture(randomUUID(), { x: 1, y: 1, z: 1 })).toThrow('closed');
  });

  it('cancels a pool checkout at shutdown and releases a late connection without issuing SQL', async () => {
    let completeCheckout!: (error: Error | null, client?: PoolClient) => void;
    const connect = vi.fn((callback: typeof completeCheckout) => {
      completeCheckout = callback;
    });
    const { runtime } = fixture({
      pool: { connect } as unknown as Pool,
      store: undefined,
      closeTimeoutMs: 30,
    });
    runtime.capture(randomUUID(), { x: 1, y: 1, z: 1 });
    const closing = runtime.close();
    await expect(closing).rejects.toThrow('exceeded deadline');
    expect(connect).toHaveBeenCalledTimes(1);
    const release = vi.fn();
    const query = vi.fn();
    completeCheckout(null, { release, query } as unknown as PoolClient);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(query).not.toHaveBeenCalled();
    expect(runtime.diagnostics()).toMatchObject({ busy: false });
  });
});
