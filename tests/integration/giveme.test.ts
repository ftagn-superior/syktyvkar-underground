import { prepareSdk } from '../helpers/prepare.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { createGameServer } from '../helpers/game-server.js';
import {
  createAccountFixture,
  loginAccount,
  loginAdminAccount,
  responseCookie,
  setAccountAdmin,
} from '../helpers/account-fixture.js';
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
  async function login(subject: string, admin = true, name?: string) {
    const { result } = await (admin
      ? loginAdminAccount(app.url, subject, fixture.store)
      : loginAccount(app.url, subject));
    const cookie = responseCookie(result, 'su_session');
    if (name) {
      const account = await fixture.store.authenticate(cookie.split('=')[1]);
      await fixture.pool.query('UPDATE player_profiles SET display_name=$2 WHERE account_id=$1', [
        account!.accountId,
        name,
      ]);
    }
    return cookie;
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
      prepareSdk(room);
      await until(() => !!room.state?.players?.has(room.sessionId));
    }
    return {
      room,
      inventories,
      results,
      send(text: string, requestId: number, worldEpoch = info.worldEpoch) {
        room.send('requestChat', { requestId, worldEpoch, text });
      },
      async requestCommands() {
        return await new Promise<unknown>((resolve) => {
          room.onMessage('commands', (value) => resolve(value));
          room.send('requestCommands');
        });
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
      code: 'UNKNOWN_COMMAND',
      message: 'Неизвестная команда.',
    });
    const owner = await join(await login('invalid-commands'), false);
    owner.send('/giveme wooden-crate', 1);
    await until(() => owner.results.length === 1);
    expect(owner.results[0].code).toBe('WORLD_NOT_READY');
    prepareSdk(owner.room);
    await until(() => owner.room.state.players?.has(owner.room.sessionId));
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

  it('hides every admin command from guests and non-admin accounts, including forged privileges', async () => {
    const ordinary = await join(await login('ordinary-player', false));
    const guest = await join();
    const commands = [
      '/giveme wooden-crate',
      '/give --list',
      '/motherlode',
      '/place',
      '/vilievna',
      '/time',
      '/time --set 12',
      '/weather',
      '/weather --rain',
      '/weather --no-clouds',
      '/giveme',
      '/unknown-command',
      '/help',
      '/h',
      '/help time',
    ];
    const before = {
      offset: app.room.state.dayOffsetMs,
      frozen: app.room.state.dayFrozenHour,
      clouds: app.room.state.weatherClouds,
      precipitation: app.room.state.weatherPrecipitation,
      revision: app.room.state.layoutRevision,
      items: app.room.state.items.size,
    };
    for (const player of [ordinary, guest]) {
      for (const [index, text] of commands.entries()) {
        player.room.send('requestChat', {
          requestId: index + 1,
          worldEpoch: info.worldEpoch,
          text,
          isAdmin: true,
          is_admin: true,
        });
        await until(() => player.results.length === index + 1);
        // Без команд `/help` честно отвечает «нет доступа», остальное неотличимо от опечатки.
        expect(player.results[index]).toMatchObject(
          text === '/help' || text === '/h'
            ? { ok: false, code: 'ADMIN_REQUIRED', message: 'Нет доступных команд.' }
            : { ok: false, code: 'UNKNOWN_COMMAND', message: 'Неизвестная команда.' },
        );
        expect(player.results[index].effect).toBeUndefined();
      }
    }
    expect({
      offset: app.room.state.dayOffsetMs,
      frozen: app.room.state.dayFrozenHour,
      clouds: app.room.state.weatherClouds,
      precipitation: app.room.state.weatherPrecipitation,
      revision: app.room.state.layoutRevision,
      items: app.room.state.items.size,
    }).toEqual(before);
    expect(
      (await fixture.pool.query('SELECT count(*)::int AS n FROM item_operations')).rows[0].n,
    ).toBe(0);
    expect(app.room.state.players.get(ordinary.room.sessionId)!.chatText).toBe('');
    expect(app.room.state.players.get(guest.room.sessionId)!.chatText).toBe('');
    ordinary.send('Обычный чат работает', commands.length + 1);
    await until(
      () =>
        guest.room.state.players.get(ordinary.room.sessionId)?.chatText === 'Обычный чат работает',
    );
  });

  it('refreshes administrator privileges on a transport reconnect', async () => {
    const cookie = await login('demoted-admin');
    const owner = await join(cookie);
    owner.send('/time', 1);
    await until(() => owner.results.length === 1);
    expect(owner.results[0].ok).toBe(true);
    await setAccountAdmin(fixture.store, cookie, false);
    const token = owner.room.reconnectionToken;
    owner.room.connection.close(1000);
    await until(() => app.room.diagnostics().reserved === 1);
    const restored = await new Client(app.url).reconnect<WorldState>(token);
    rooms.delete(owner.room);
    rooms.add(restored);
    restored.reconnection.enabled = false;
    const results: ActionResult[] = [];
    restored.onMessage('actionResult', (result) => results.push(result));
    for (const message of ['problem', 'resync', 'inventory']) restored.onMessage(message, () => {});
    prepareSdk(restored);
    await until(() => restored.state?.players?.has(restored.sessionId));
    restored.send('requestChat', { requestId: 2, worldEpoch: info.worldEpoch, text: '/time' });
    await until(() => results.length === 1);
    expect(results[0]).toMatchObject({ ok: false, code: 'UNKNOWN_COMMAND' });
  });

  it('lets an administrator read weather, combine flags and open command help', async () => {
    const owner = await join(await login('weather-admin'));
    owner.send('/weather', 1);
    await until(() => owner.results.length === 1);
    expect(owner.results[0].ok).toBe(true);
    owner.send('/weather --no-clouds --fog', 2);
    await until(() => owner.results.length === 2);
    expect(owner.results[1].ok).toBe(true);
    expect(app.room.state.weatherClouds).toBe(false);
    expect(app.room.state.weatherFog).toBe(true);
    owner.send('/weather --help', 3);
    await until(() => owner.results.length === 3);
    expect(owner.results[2]).toMatchObject({
      ok: true,
      retryAfterMs: 0,
      effect: { kind: 'commandHelp', focus: 'weather' },
    });
    expect(owner.results[2].effect).toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({ name: 'give', aliases: ['giveme'] }),
      ]),
    });
    owner.send('/give --list', 4);
    await until(() => owner.results.length === 4);
    expect(owner.results[3]).toMatchObject({
      ok: true,
      message: expect.stringContaining('wooden-crate'),
    });
  });

  it('lets an administrator change their own speed and another player’s by @name', async () => {
    const guest = await join();
    const owner = await join(await login('speed-admin'));
    const guestName = app.room.state.players.get(guest.room.sessionId)!.name;
    owner.send(`/speed @"${guestName}" --set 2`, 1);
    await until(() => owner.results.length === 1);
    expect(owner.results[0]).toMatchObject({ ok: true, message: `Скорость ${guestName}: ×2.` });
    await until(() => guest.room.state.players.get(guest.room.sessionId)?.speedPercent === 200);
    owner.send('/speed', 2);
    await until(() => owner.results.length === 2);
    expect(owner.results[1]).toMatchObject({ ok: true, message: 'Ваша скорость: ×1.' });
    owner.send('/speed @nobody-here --set 2', 3);
    await until(() => owner.results.length === 3);
    expect(owner.results[2]).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    owner.send(`/speed @"${guestName}" --reset`, 4);
    await until(() => guest.room.state.players.get(guest.room.sessionId)?.speedPercent === 100);
    guest.send('/speed --set 3', 1);
    await until(() => guest.results.length === 1);
    expect(guest.results[0]).toMatchObject({ code: 'UNKNOWN_COMMAND' });
  });

  it('lets an administrator set, stop and reset the shared day clock, privately', async () => {
    const guest = await join();
    const owner = await join(await login('timekeeper'));
    guest.send('/time --set 12', 1);
    await until(() => guest.results.length === 1);
    expect(guest.results[0]).toMatchObject({ code: 'UNKNOWN_COMMAND' });
    expect(app.room.state.dayFrozenHour).toBe(-1);
    expect(app.room.state.dayOffsetMs).toBe(0);

    let worldNow = app.room.worldTimeMs();
    vi.spyOn(app.room, 'worldTimeMs').mockImplementation(() => worldNow);
    try {
      owner.send('/time --set 18:30', 1);
      await until(() => owner.results.length === 1);
      expect(owner.results[0]).toMatchObject({ ok: true, message: 'Время идёт: 18:30.' });
      await until(() => guest.room.state.dayOffsetMs === app.room.state.dayOffsetMs);
      expect(guest.room.state.dayFrozenHour).toBe(-1);

      owner.send('/time --stop', 2);
      await until(() => owner.results.length === 2);
      expect(owner.results[1]).toMatchObject({ code: 'RATE_LIMITED' });
      worldNow += 1000;
      owner.send('/time --stop', 3);
      await until(() => owner.results.length === 3);
      expect(owner.results[2]).toMatchObject({ ok: true, message: 'Время остановлено: 18:31.' });
      await until(() => guest.room.state.dayFrozenHour >= 0);
      expect(guest.room.state.dayFrozenHour).toBeCloseTo(18.5 + 1 / 60, 3);

      owner.send('/time', 4);
      await until(() => owner.results.length === 4);
      expect(owner.results[3]).toMatchObject({ ok: true, message: 'Время остановлено: 18:31.' });
      owner.send('/time --set 25', 5);
      await until(() => owner.results.length === 5);
      expect(owner.results[4]).toMatchObject({ ok: false, code: 'INVALID_INPUT' });

      worldNow += 1000;
      owner.send('/time --reset', 6);
      await until(() => owner.results.length === 6);
      expect(owner.results[5].ok).toBe(true);
      await until(() => guest.room.state.dayFrozenHour === -1);
      expect(guest.room.state.dayOffsetMs).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(guest.results).toHaveLength(1);
    expect(app.room.state.players.get(owner.room.sessionId)!.chatSequence).toBe(0);
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

  it('filters requestCommands by role and lets admins /give items to other accounts', async () => {
    const guest = await join();
    const ordinary = await join(await login('ordinary-catalog', false, 'Получатель'));
    const admin = await join(await login('admin-catalog', true, 'Администратор'));

    const guestCatalog = (await guest.requestCommands()) as { commands: { name: string }[] };
    expect(guestCatalog.commands.map((c) => c.name)).toEqual(['help']);
    const ordinaryCatalog = (await ordinary.requestCommands()) as { commands: { name: string }[] };
    expect(ordinaryCatalog.commands.map((c) => c.name)).toEqual(['help']);

    const adminCatalog = (await admin.requestCommands()) as {
      commands: { name: string; args: { choices?: string[] }[]; conflicts: string[][] }[];
    };
    expect(adminCatalog.commands.map((c) => c.name)).toContain('give');
    const giveEntry = adminCatalog.commands.find((c) => c.name === 'give')!;
    expect(giveEntry.args[1].choices).toContain('wooden-crate');
    expect(adminCatalog.commands.find((c) => c.name === 'time')!.conflicts).toContainEqual([
      'stop',
      'start',
    ]);

    const guestName = app.room.state.players.get(guest.room.sessionId)!.name;
    admin.send(`/give @"${guestName}" wooden-crate`, 1);
    await until(() => admin.results.length === 1);
    expect(admin.results[0]).toMatchObject({ ok: false, code: 'INVALID_INPUT' });

    const ordinaryName = app.room.state.players.get(ordinary.room.sessionId)!.name;
    admin.send(`/give @"${ordinaryName}" wooden-crate`, 2);
    await until(
      () => admin.results.length === 2 && ordinary.inventories.at(-1)?.slots[0]?.items.length === 1,
    );
    expect(admin.results[1].ok).toBe(true);
    expect(admin.inventories.flatMap((i) => i.slots)).toEqual([]);
  });

  it('rejects ambiguous /give targets without granting to either account', async () => {
    const first = await join(await login('duplicate-first', false, 'Тёзка'));
    const second = await join(await login('duplicate-second', false, 'Тёзка'));
    const admin = await join(await login('duplicate-admin', true, 'Администратор'));
    admin.send('/give @Тёзка wooden-crate', 1);
    await until(() => admin.results.length === 1);
    expect(admin.results[0]).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
      message: 'Под @Тёзка подходят: Тёзка, Тёзка. Уточните имя.',
    });
    expect(
      (await fixture.pool.query('SELECT count(*)::int AS count FROM item_operations')).rows[0]
        .count,
    ).toBe(0);
    expect(first.inventories.flatMap((inventory) => inventory.slots)).toEqual([]);
    expect(second.inventories.flatMap((inventory) => inventory.slots)).toEqual([]);
  });
});
