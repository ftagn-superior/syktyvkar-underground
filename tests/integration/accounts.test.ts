import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { randomBytes } from 'node:crypto';
import { createGameServer } from '../helpers/game-server.js';
import { migrateDatabase } from '../../apps/server/src/migrations.js';
import {
  PROTOCOL_VERSION,
  type AccountResponse,
  type WorldInfo,
} from '../../packages/contracts/src/index.js';
import type { WorldState } from '../../packages/protocol/src/index.js';
import { createAccountFixture, loginAccount, responseCookie } from '../helpers/account-fixture.js';

const databaseUrl = process.env.SU_TEST_DATABASE_URL;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await wait(15);
  }
  throw new Error('Timed out waiting for account connection lifecycle');
}

describe.skipIf(!databaseUrl)(
  'PostgreSQL accounts with signed OIDC and actual Colyseus connections',
  () => {
    let fixture: Awaited<ReturnType<typeof createAccountFixture>>;
    let app: Awaited<ReturnType<typeof createGameServer>>;
    const rooms = new Set<Room<WorldState>>();
    async function start(worldDirectory?: string) {
      app = await createGameServer({
        port: 0,
        reconnectSeconds: 1,
        accounts: fixture,
        worldDirectory,
      });
      fixture.config.publicOrigin = app.url;
    }
    async function me(cookie: string): Promise<AccountResponse> {
      const response = await fetch(app.url + '/api/me', { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      return response.json();
    }
    async function login(subject: string) {
      const { result } = await loginAccount(app.url, subject);
      expect(result.headers.get('location')).toBe('/?login=success');
      const cookie = responseCookie(result, 'su_session');
      return { cookie, state: await me(cookie) };
    }
    async function join(cookie: string, ready = true) {
      const info: WorldInfo = await (await fetch(app.url + '/api/world')).json();
      const sdk = new Client(app.url, { headers: { Cookie: cookie } });
      const room = await sdk.joinById<WorldState>(info.roomId, { ...info, accountMode: 'account' });
      room.reconnection.enabled = false;
      room.onMessage('problem', () => {});
      room.onMessage('resync', () => {});
      room.onMessage('actionResult', () => {});
      room.onMessage('inventory', () => {});
      rooms.add(room);
      if (ready) {
        room.send('clientReady');
        await until(() => !!room.state?.players?.has(room.sessionId));
      }
      return room;
    }
    beforeAll(async () => {
      fixture = await createAccountFixture(databaseUrl!);
      await start();
    });
    afterAll(async () => {
      await Promise.allSettled([...rooms].map((room) => room.leave()));
      await app?.close();
      await fixture?.close();
    });

    it('migrates repeatedly and registers one identity under concurrent first logins', async () => {
      await migrateDatabase(fixture.pool);
      const identities = await Promise.all(
        Array.from({ length: 6 }, () =>
          fixture.store.login(
            { issuer: 'test-concurrent', subject: 'same-person' },
            randomBytes(32).toString('base64url'),
          ),
        ),
      );
      expect(new Set(identities.map((r) => r.account.accountId)).size).toBe(1);
      expect(
        (
          await fixture.pool.query(
            "SELECT count(*)::int AS n FROM account_identities WHERE issuer='test-concurrent'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await fixture.pool.query('SELECT current_schema() AS name')).rows[0].name).toBe(
        fixture.schema,
      );
    });

    it('binds a one-use callback to its browser and rejects altered state', async () => {
      const { result, callback, flowCookie } = await loginAccount(app.url, 'one-use');
      expect(result.headers.get('location')).toBe('/?login=success');
      const replay = await fetch(callback, { headers: { Cookie: flowCookie }, redirect: 'manual' });
      expect(replay.headers.get('location')).toBe('/?login=expired');
      const fresh = await fetch(app.url + '/api/auth/telegram', { redirect: 'manual' });
      const approved = await fetch(fresh.headers.get('location')!, { redirect: 'manual' });
      // A fresh, valid provider response cannot log in a browser without its flow cookie.
      expect(
        (await fetch(approved.headers.get('location')!, { redirect: 'manual' })).headers.get(
          'location',
        ),
      ).toBe('/?login=expired');
      expect(
        (
          await fetch(approved.headers.get('location')!, {
            headers: { Cookie: responseCookie(fresh, 'su_login') },
            redirect: 'manual',
          })
        ).headers.get('location'),
      ).toBe('/?login=success');
      const start = await fetch(app.url + '/api/auth/telegram', { redirect: 'manual' });
      const url = new URL(start.headers.get('location')!);
      const authorized = await fetch(url, { redirect: 'manual' });
      const altered = new URL(authorized.headers.get('location')!);
      altered.searchParams.set('state', 'forged');
      const invalid = await fetch(altered, {
        headers: { Cookie: responseCookie(start, 'su_login') },
        redirect: 'manual',
      });
      expect(invalid.headers.get('location')).toBe('/?login=failed');
    });

    it.each(['signature', 'audience', 'nonce', 'expired'])(
      'rejects an ID token with invalid %s',
      async (failure) => {
        const { result } = await loginAccount(app.url, 'invalid-' + failure, failure);
        expect(result.headers.get('location')).toBe('/?login=failed');
        expect(
          result.headers.getSetCookie().some((cookie) => cookie.startsWith('su_session=')),
        ).toBe(false);
      },
    );

    it('persists profile, detects stale writes and restores the same account after server restart', async () => {
      const { cookie, state } = await login('persistent');
      const request = (name: string, version = state.account!.profile.version) =>
        fetch(app.url + '/api/me/profile', {
          method: 'PATCH',
          headers: {
            Cookie: cookie,
            Origin: app.url,
            'X-CSRF-Token': state.csrfToken!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ displayName: name, colorId: 'coral', version }),
        });
      const results = await Promise.all([request('Сыктывкарец'), request('Игрок второй')]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const saved = (await me(cookie)).account!;
      expect(saved.profile.colorId).toBe('coral');
      await app.close();
      await start();
      expect((await me(cookie)).account).toEqual(saved);
      expect((await login('persistent')).state.account).toEqual(saved);
      const hashes = await fixture.pool.query('SELECT token_hash FROM auth_sessions');
      expect(hashes.rows.some((row) => row.token_hash === cookie.split('=')[1])).toBe(false);
    });

    it('rejects CSRF, invalid profiles and cross-origin WebSocket handshakes', async () => {
      const { cookie, state } = await login('validation');
      const headers = {
        Cookie: cookie,
        Origin: app.url,
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.csrfToken!,
      };
      const body = JSON.stringify({ displayName: 'Игрок', colorId: 'mint', version: 1 });
      expect(
        (
          await fetch(app.url + '/api/me/profile', {
            method: 'PATCH',
            headers: { ...headers, Origin: 'https://attacker.invalid' },
            body,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(app.url + '/api/me/profile', {
            method: 'PATCH',
            headers: { ...headers, 'X-CSRF-Token': 'wrong' },
            body,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(app.url + '/api/me/profile', {
            method: 'PATCH',
            headers,
            body: body.replace('Игрок', '\\u202eИгрок'),
          })
        ).status,
      ).toBe(400);
      const info: WorldInfo = await (await fetch(app.url + '/api/world')).json();
      const bad = new Client(app.url, {
        headers: { Origin: 'https://attacker.invalid', Cookie: cookie },
      });
      await expect(
        bad.joinById(info.roomId, { ...info, accountMode: 'account' }),
      ).rejects.toThrow();
    });

    it('uses saved appearance, admits one preparing player, reconnects, and revokes reserved seats on logout', async () => {
      const { cookie, state } = await login('room-player');
      await fetch(app.url + '/api/me/profile', {
        method: 'PATCH',
        headers: {
          Cookie: cookie,
          Origin: app.url,
          'X-CSRF-Token': state.csrfToken!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ displayName: 'Постоянный', colorId: 'coral', version: 1 }),
      });
      const attempts = await Promise.allSettled([join(cookie, false), join(cookie, false)]);
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const first = (
        attempts.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Room<WorldState>>
      ).value;
      first.send('clientReady');
      await until(() => !!first.state?.players?.get(first.sessionId));
      const player = first.state.players.get(first.sessionId)!;
      expect(player.name).toBe('Постоянный');
      expect(player.color).toBe('#e98b69');
      const entityId = player.entityId;
      const reconnectToken = first.reconnectionToken;
      first.connection.close(1000);
      await until(() => app.room.diagnostics().reserved === 1);
      const sdk = new Client(app.url);
      const restored = await sdk.reconnect<WorldState>(reconnectToken);
      restored.reconnection.enabled = false;
      restored.onMessage('resync', () => {});
      restored.onMessage('problem', () => {});
      rooms.delete(first);
      rooms.add(restored);
      await until(() => !!restored.state?.players?.get(restored.sessionId));
      expect(restored.state.players.get(restored.sessionId)!.entityId).toBe(entityId);
      const lastToken = restored.reconnectionToken;
      restored.connection.close(1000);
      await until(() => app.room.diagnostics().reserved === 1);
      const logout = await fetch(app.url + '/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: app.url, 'X-CSRF-Token': state.csrfToken! },
      });
      expect(logout.status).toBe(204);
      await until(() => app.room.diagnostics().sessions === 0);
      expect((await me(cookie)).account).toBeNull();
      await expect(sdk.reconnect(lastToken)).rejects.toThrow();
      rooms.delete(restored);
    });

    it('closes an active connection on logout and rejects a stale browser account', async () => {
      const { cookie, state } = await login('active-logout');
      const info: WorldInfo = await (await fetch(app.url + '/api/world')).json();
      const sdk = new Client(app.url, { headers: { Cookie: cookie } });
      await expect(
        sdk.joinById(info.roomId, {
          ...info,
          accountMode: 'account',
          expectedAccountId: 'different-account',
        }),
      ).rejects.toThrow('ACCOUNT_CHANGED');
      const room = await join(cookie);
      await fetch(app.url + '/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: app.url, 'X-CSRF-Token': state.csrfToken! },
      });
      await until(() => app.room.diagnostics().sessions === 0);
      await expect(join(cookie)).rejects.toThrow('AUTH_REQUIRED');
      rooms.delete(room);
    });

    it('revalidates a revoked session when reconnecting, independently of an in-memory logout notification', async () => {
      const { cookie } = await login('reconnect-revalidation');
      const auth = await fixture.store.authenticate(cookie.split('=')[1]);
      const room = await join(cookie);
      const token = room.reconnectionToken;
      room.connection.close(1000);
      await until(() => app.room.diagnostics().reserved === 1);
      await fixture.store.revokeSession(auth!.authSessionId);
      await expect(new Client(app.url).reconnect(token)).rejects.toThrow('AUTH_REQUIRED');
      await until(() => app.room.diagnostics().sessions === 0);
      rooms.delete(room);
    });
    it('rejects a room join whose authorization lookup was in flight when logout committed', async () => {
      const { cookie, state } = await login('logout-race');
      const original = fixture.store.authenticate.bind(fixture.store);
      let pending = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lookup = vi
        .spyOn(fixture.store, 'authenticate')
        .mockImplementationOnce(async (token) => {
          const snapshot = await original(token);
          pending = true;
          await gate;
          return snapshot;
        });
      let joining: ReturnType<typeof join> | undefined;
      try {
        joining = join(cookie);
        const rejected = expect(joining).rejects.toThrow('AUTH_REQUIRED');
        await until(() => pending);
        const logout = await fetch(app.url + '/api/auth/logout', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: app.url,
            'X-CSRF-Token': state.csrfToken!,
          },
        });
        expect(logout.status).toBe(204);
        release();
        await rejected;
        expect(app.room.diagnostics().sessions).toBe(0);
      } finally {
        release();
        await joining?.catch(() => {});
        lookup.mockRestore();
      }
    });

    it('serves the city world and joins it with the saved account profile', async () => {
      await app.close();
      await start('dist/worlds/ring-block');
      const { cookie, state } = await login('ring-block');
      const saved = await fetch(app.url + '/api/me/profile', {
        method: 'PATCH',
        headers: {
          Cookie: cookie,
          Origin: app.url,
          'X-CSRF-Token': state.csrfToken!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          displayName: 'Горожанин',
          colorId: 'indigo',
          version: state.account!.profile.version,
        }),
      });
      expect(saved.status).toBe(200);
      const info: WorldInfo = await (await fetch(app.url + '/api/world')).json();
      expect(info.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(info.manifestUrl).toBe('/worlds/ring-block/manifest.json');
      const manifest = await (await fetch(app.url + info.manifestUrl)).json();
      expect(manifest.worldId).toBe('ring-block');
      expect(manifest.mapVersion).toBe(info.mapVersion);
      const room = await join(cookie);
      try {
        expect(room.state.protocolVersion).toBe(PROTOCOL_VERSION);
        expect(room.state.players.get(room.sessionId)).toMatchObject({
          name: 'Горожанин',
          color: '#8c9eff',
        });
        expect((await fetch(app.url + '/health/ready')).status).toBe(200);
      } finally {
        await room.leave();
        rooms.delete(room);
      }
    });

    it('returns 503 without acknowledging a save when account pool is exhausted while the world writer remains available', async () => {
      const { cookie, state } = await login('database-unavailable');
      const room = await join(cookie);
      const tick = app.room.state.serverTick;
      const held = await Promise.all(Array.from({ length: 4 }, () => fixture.pool.connect()));
      try {
        const [save, readiness] = await Promise.all([
          fetch(app.url + '/api/me/profile', {
            method: 'PATCH',
            headers: {
              Cookie: cookie,
              Origin: app.url,
              'X-CSRF-Token': state.csrfToken!,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ displayName: 'Не сохранено', colorId: 'coral', version: 1 }),
          }),
          fetch(app.url + '/health/ready'),
        ]);
        expect(save.status).toBe(503);
        expect(readiness.status).toBe(503);
        expect(app.room.state.serverTick).toBeGreaterThan(tick + 50);
      } finally {
        held.forEach((client) => client.release());
      }
      expect((await me(cookie)).account!.profile).toEqual(state.account!.profile);
      expect((await fetch(app.url + '/health/ready')).status).toBe(200);
      await room.leave();
      rooms.delete(room);
      await until(() => app.room.diagnostics().sessions === 0);
    });
  },
);
