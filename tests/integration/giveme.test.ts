import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { createGameServer } from '../helpers/game-server.js';
import { createAccountFixture, loginAccount, responseCookie } from '../helpers/account-fixture.js';
import { ItemStore } from '../../apps/server/src/items/store.js';
import type { WorldState } from '../../packages/protocol/src/index.js';
import type { ActionResult, InventoryView, WorldInfo } from '../../packages/contracts/src/index.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let n = 0; n < 250; n++) {
    if (predicate()) return;
    await wait(15);
  }
  throw new Error('Timed out waiting for chat command');
}

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('private item creation through chat', () => {
  let fixture: Awaited<ReturnType<typeof createAccountFixture>>;
  let app: Awaited<ReturnType<typeof createGameServer>>;
  let info: WorldInfo;
  const rooms = new Set<Room<WorldState>>();
  async function start(itemCreationEnabled = true) {
    app = await createGameServer({ port: 0, accounts: fixture, itemCreationEnabled });
    fixture.config.publicOrigin = app.url;
    info = await fetch(app.url + '/api/world').then((r) => r.json());
  }
  async function login(subject: string) {
    const { result } = await loginAccount(app.url, subject);
    return responseCookie(result, 'su_session');
  }
  async function join(cookie?: string, ready = true) {
    const room = await new Client(
      app.url,
      cookie ? { headers: { Cookie: cookie } } : {},
    ).joinById<WorldState>(info.roomId, { ...info, accountMode: cookie ? 'account' : 'guest' });
    const inventories: InventoryView[] = [],
      results: ActionResult[] = [];
    room.reconnection.enabled = false;
    room.onMessage('inventory', (value) => inventories.push(value));
    room.onMessage('actionResult', (value) => results.push(value));
    room.onMessage('problem', () => {});
    room.onMessage('resync', () => {});
    rooms.add(room);
    if (ready) {
      room.send('clientReady');
      await until(() => !!room.state?.players?.has(room.sessionId));
    }
    return {
      room,
      inventories,
      results,
      send(text: string, requestId: number, worldEpoch = info.worldEpoch) {
        room.send('requestChat', { requestId, worldEpoch, text });
      },
    };
  }
  async function leaveAll() {
    await Promise.allSettled([...rooms].map((room) => room.leave()));
    rooms.clear();
  }
  beforeEach(async () => {
    fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL!);
    await start();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await leaveAll();
    await app?.close();
    await fixture?.close();
  });

  it('grants exactly once for in-flight and acknowledged duplicates, and keeps commands and feedback private', async () => {
    const observer = await join();
    const owner = await join(await login('creator'));
    const countBefore = app.room.state.items.size;
    const original = ItemStore.prototype.operation;
    let committed = false,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(ItemStore.prototype, 'operation').mockImplementationOnce(async function (
      this: ItemStore,
      ...args
    ) {
      const result = await original.apply(this, args);
      committed = result.ok;
      await gate;
      return result;
    });
    try {
      owner.send('/giveme wooden-crate', 1);
      await until(() => committed);
      owner.send('/giveme wooden-crate', 1);
      owner.send('/giveme missing', 1);
      await wait(100);
      expect(owner.results).toEqual([]);
      release();
      await until(
        () => owner.results.length === 1 && owner.inventories.at(-1)?.slots[0]?.items.length === 1,
      );
    } finally {
      release();
      spy.mockRestore();
    }
    expect(owner.results[0]).toMatchObject({
      ok: true,
      message: 'Получен предмет: Деревянный ящик ×1.',
    });
    owner.send('/giveme wooden-crate', 1);
    await until(() => owner.results.length === 2);
    expect(owner.results[1]).toEqual(owner.results[0]);
    expect(
      (await fixture.pool.query('SELECT count(*)::int AS count FROM item_operations')).rows[0]
        .count,
    ).toBe(1);
    expect(
      (await fixture.pool.query('SELECT result FROM item_operations')).rows[0].result.itemId,
    ).toBe(owner.inventories.at(-1)!.slots[0].items[0].itemId);
    expect(app.room.state.items.size).toBe(countBefore);
    expect(observer.results).toEqual([]);
    expect(observer.inventories).toEqual([]);
    expect(app.room.state.players.get(owner.room.sessionId)!.chatSequence).toBe(0);
    expect(observer.room.state.players.get(owner.room.sessionId)!.chatText).toBe('');

    owner.send('/giveme wooden-crate', 2);
    await until(() => owner.results.length === 3);
    expect(owner.results[2]).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 2000 });
    observer.send('Привет!', 1);
    await until(
      () => owner.room.state.players.get(observer.room.sessionId)?.chatText === 'Привет!',
    );
  });

  it('keeps an active animation while an inventory-only grant commits', async () => {
    const owner = await join(await login('animated-creator'));
    const player = () => app.room.state.players.get(owner.room.sessionId)!;
    await until(() => player().grounded);
    owner.room.send('requestAnimation', {
      requestId: 1,
      worldEpoch: info.worldEpoch,
      animationId: 'wave',
    });
    await until(() => owner.results.length === 1);
    expect(owner.results[0].ok).toBe(true);
    const end = player().animationEndsAtTick;
    const bodies = app.room.diagnostics().bodies;
    owner.send('/giveme wooden-crate', 2);
    await until(
      () => owner.results.length === 2 && owner.inventories.at(-1)?.slots[0]?.items.length === 1,
    );
    expect(owner.results[1].ok).toBe(true);
    expect(player().animationId).toBe('wave');
    expect(player().animationSequence).toBe(1);
    expect(player().animationEndsAtTick).toBe(end);
    expect(player().chatText).toBe('');
    expect(app.room.state.paused).toBe(false);
    expect(app.room.diagnostics().bodies).toBe(bodies);
  });

  it('rejects guests, stale requests, malformed commands and unknown catalog types without broadcasting them', async () => {
    const guest = await join();
    guest.send('/giveme wooden-crate', 1);
    await until(() => guest.results.length === 1);
    expect(guest.results[0]).toMatchObject({
      code: 'AUTH_REQUIRED',
      message: expect.stringContaining('Telegram'),
    });
    const owner = await join(await login('invalid-commands'), false);
    owner.send('/giveme wooden-crate', 1);
    await until(() => owner.results.length === 1);
    expect(owner.results[0].code).toBe('WORLD_NOT_READY');
    owner.room.send('clientReady');
    await until(() => owner.room.state.players.has(owner.room.sessionId));
    owner.send('/giveme wooden-crate', 2, 'old-epoch');
    await until(() => owner.results.length === 2);
    expect(owner.results[1].code).toBe('STALE_WORLD');
    const bad = [
      '/giveme',
      '/giveme wooden-crate 2',
      '/giveme missing',
      '/other',
      '/giveme __proto__',
    ];
    for (let n = 0; n < bad.length; n++) {
      owner.send(bad[n], n + 3);
      await until(() => owner.results.length === n + 3);
      expect(owner.results.at(-1)!.ok).toBe(false);
      expect(owner.results.at(-1)!.message).toBeTruthy();
    }
    expect(
      (await fixture.pool.query('SELECT count(*)::int AS count FROM item_operations')).rows[0]
        .count,
    ).toBe(0);
    expect(app.room.state.players.get(owner.room.sessionId)!.chatSequence).toBe(0);
    owner.send('  /giveme\twooden-crate  ', 8);
    await until(() => owner.results.length === 8);
    expect(owner.results.at(-1)!.ok).toBe(true);
    expect(guest.results).toHaveLength(1);
    expect(guest.inventories).toEqual([]);
  });

  it('enforces the cooldown across new sessions of the same account while allowing another account', async () => {
    const cookie = await login('same-account');
    const first = await join(cookie);
    first.send('/giveme wooden-crate', 1);
    await until(() => first.results.length === 1);
    expect(first.results[0].ok).toBe(true);
    await first.room.leave();
    rooms.delete(first.room);
    const second = await join(cookie);
    second.send('/giveme wooden-crate', 1);
    await until(() => second.results.length === 1);
    expect(second.results[0].code).toBe('RATE_LIMITED');
    const other = await join(await login('other-account'));
    other.send('/giveme wooden-crate', 1);
    await until(() => other.results.length === 1);
    expect(other.results[0].ok).toBe(true);
    expect(second.inventories.at(-1)!.slots[0].items).toHaveLength(1);
  });

  it('restores issued items with creation disabled and continues to support ordinary chat', async () => {
    const cookie = await login('disabled-creation');
    const owner = await join(cookie);
    owner.send('/giveme wooden-crate', 1);
    await until(() => owner.results.length === 1);
    const inventory = owner.inventories.at(-1)!;
    await leaveAll();
    await app.close();
    await start(false);
    const restored = await join(cookie),
      observer = await join();
    await until(() => restored.inventories.length > 0);
    expect(restored.inventories.at(-1)).toEqual(inventory);
    restored.send('/giveme wooden-crate', 1);
    await until(() => restored.results.length === 1);
    expect(restored.results[0].code).toBe('COMMAND_DISABLED');
    expect(restored.inventories.at(-1)).toEqual(inventory);
    restored.send('Вещи остались!', 2);
    await until(
      () => observer.room.state.players.get(restored.room.sessionId)?.chatText === 'Вещи остались!',
    );
    expect(observer.inventories).toEqual([]);
  });
});
