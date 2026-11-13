import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import type {
  AccountResponse,
  PrepareArea,
  Vec3,
  WorldInfo,
  ActionResult,
  PlaceStaticResult,
} from '../../packages/contracts/src/index.js';
import { MoveInputSchema, type WorldState } from '../../packages/protocol/src/index.js';
import { PlayerPositionStore } from '../../apps/server/src/players/position-store.js';
import { createGameServer } from '../helpers/game-server.js';
import { createAccountFixture, loginAccount, responseCookie } from '../helpers/account-fixture.js';
import { prepareSdk } from '../helpers/prepare.js';
import { buildStaticPlacementWorld } from '../helpers/static-placement-world.js';

const databaseUrl = process.env.SU_TEST_DATABASE_URL;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>, timeout = 4000) {
  const startedAt = performance.now();
  while (!(await predicate())) {
    if (performance.now() - startedAt > timeout)
      throw new Error('Timed out waiting for player position lifecycle');
    await wait(15);
  }
}
const identity = (plan: PrepareArea) => ({
  prepareId: plan.prepareId,
  worldEpoch: plan.worldEpoch,
  mapVersion: plan.mapVersion,
  layoutRevision: plan.layoutRevision,
});

describe.skipIf(!databaseUrl)(
  'persistent player positions over PostgreSQL and real WebSockets',
  () => {
    let fixture: Awaited<ReturnType<typeof createAccountFixture>>;
    let app: Awaited<ReturnType<typeof createGameServer>>;
    let info: WorldInfo;
    let temporaryDirectory: string | undefined;
    const rooms = new Set<Room<WorldState>>();

    async function start(prepareTimeoutMs = 1400, worldDirectory?: string) {
      app = await createGameServer({
        port: 0,
        accounts: fixture,
        prepareTimeoutMs,
        reconnectSeconds: 0.35,
        testDiagnostics: true,
        worldDirectory,
      });
      fixture.config.publicOrigin = app.url;
      info = await (await fetch(app.url + '/api/world')).json();
    }
    async function login(subject: string) {
      const { result } = await loginAccount(app.url, subject);
      expect(result.headers.get('location')).toBe('/?login=success');
      const cookie = responseCookie(result, 'su_session');
      const state: AccountResponse = await (
        await fetch(app.url + '/api/me', { headers: { Cookie: cookie } })
      ).json();
      return { cookie, state, accountId: state.account!.accountId };
    }
    async function join(cookie?: string, automatic = true) {
      const sdk = new Client(app.url, cookie ? { headers: { Cookie: cookie } } : undefined);
      const room = await sdk.joinById<WorldState>(info.roomId, {
        ...info,
        accountMode: cookie ? 'account' : 'guest',
      });
      room.reconnection.enabled = false;
      for (const message of ['problem', 'resync', 'actionResult', 'inventory', 'layoutChanged'])
        room.onMessage(message, () => {});
      rooms.add(room);
      const preparation = prepareSdk(room, automatic);
      if (automatic) await until(() => !!room.state?.players?.has(room.sessionId));
      return { room, ...preparation };
    }
    async function leave(room: Room<WorldState>) {
      await room.leave();
      rooms.delete(room);
      await until(() => !app.room.state.players.has(room.sessionId));
    }
    function position(room: Room<WorldState>): Vec3 {
      const player = app.room.state.players.get(room.sessionId)!;
      return { x: player.x, y: player.y, z: player.z };
    }
    async function move(room: Room<WorldState>, duration = 450) {
      const input = room.input({ type: MoveInputSchema, mode: 'reliable' });
      input.data.moveX = -1;
      const started = performance.now();
      while (performance.now() - started < duration) {
        input.send();
        await wait(16);
      }
      input.data.moveX = 0;
      input.send();
      await until(() => Math.abs(app.room.state.players.get(room.sessionId)?.vx ?? 100) < 0.01);
      await wait(60);
      return position(room);
    }
    function expectSamePosition(actual: Vec3, expected: Vec3) {
      expect(Math.hypot(actual.x - expected.x, actual.z - expected.z)).toBeLessThan(0.04);
      expect(Math.abs(actual.y - expected.y)).toBeLessThan(0.05);
    }
    async function row(accountId: string) {
      return (
        await fixture.pool.query(
          'SELECT * FROM player_positions WHERE account_id=$1 AND world_id=$2',
          [accountId, 'physics-lab'],
        )
      ).rows[0];
    }
    async function savedPlayer(subject: string) {
      const account = await login(subject);
      const first = await join(account.cookie);
      const initial = position(first.room);
      const saved = await move(first.room);
      expect(saved.x).toBeLessThan(initial.x - 1.2);
      const entityId = first.room.state.players.get(first.room.sessionId)!.entityId;
      await leave(first.room);
      return { ...account, initial, saved, entityId };
    }
    async function seed(accountId: string, point: Vec3, sequence = '0') {
      // Fixture-only unsafe candidates; the positive scenario uses actual gameplay input.
      await fixture.pool.query(
        `INSERT INTO player_positions(account_id,world_id,x,y,z,write_epoch,write_sequence)
      VALUES($1,'physics-lab',$2,$3,$4,$5,$6)`,
        [accountId, point.x, point.y, point.z, randomUUID(), sequence],
      );
    }

    beforeAll(async () => {
      fixture = await createAccountFixture(databaseUrl!);
    });
    beforeEach(async () => {
      await start();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await Promise.allSettled([...rooms].map((room) => room.leave()));
      rooms.clear();
      await app?.close();
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    });
    afterAll(async () => {
      await fixture?.close();
    });

    it('saves real movement on explicit leave and immediately rejoins with a new body at the same center', async () => {
      const player = await savedPlayer('position-explicit');
      const restored = await join(player.cookie);
      expect(restored.plans.at(-1)?.spawnSource).toBe('saved');
      expect(restored.room.state.players.get(restored.room.sessionId)!.entityId).not.toBe(
        player.entityId,
      );
      expectSamePosition(position(restored.room), player.saved);
      expect(app.room.diagnostics().players).toBe(1);
      await until(async () => !!(await row(player.accountId)));
      expect((await row(player.accountId)).write_epoch).toBe(info.worldEpoch);
    });

    it('uses the newest memory snapshot while its SQL save is still pending', async () => {
      const player = await login('position-pending-save');
      const first = await join(player.cookie);
      await until(() => app.room.diagnostics().playerPositions.pendingAccounts === 0);
      const saved = await move(first.room);
      const original = PlayerPositionStore.prototype.save;
      let saving = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(PlayerPositionStore.prototype, 'save').mockImplementationOnce(async function (
        this: PlayerPositionStore,
        snapshot,
      ) {
        saving = true;
        await gate;
        return original.call(this, snapshot);
      });
      try {
        await leave(first.room);
        await until(() => saving);
        const restored = await join(player.cookie);
        expect(restored.plans.at(-1)?.spawnSource).toBe('saved');
        expectSamePosition(position(restored.room), saved);
      } finally {
        release();
      }
    });

    it.each([
      { name: 'missing', point: undefined, sequence: '0', reason: 'missing' },
      {
        name: 'invalid sequence',
        point: { x: -3, y: 0.92, z: 4 },
        sequence: '9007199254740992',
        reason: 'invalid_record',
      },
      {
        name: 'out of bounds',
        point: { x: 200, y: 0.92, z: 4 },
        sequence: '0',
        reason: 'OUT_OF_BOUNDS',
      },
      { name: 'airborne', point: { x: -3, y: 8, z: 4 }, sequence: '0', reason: 'NO_SUPPORT' },
    ])('falls back to ordinary spawn for $name', async ({ name, point, sequence, reason }) => {
      const account = await login('position-fallback-' + name);
      if (point) await seed(account.accountId, point, sequence);
      const restored = await join(account.cookie);
      expect(restored.plans.at(-1)?.spawnSource).toBe('default');
      expectSamePosition(position(restored.room), { x: -3, y: 0.92, z: 4 });
      expect(app.room.diagnostics().playerPositions.spawns.fallbacks[reason]).toBe(1);
    });

    it('isolates accounts, and rejects saved occupancy again after preparation', async () => {
      const saved = await savedPlayer('position-occupied');
      const other = await login('position-other-account');
      const restoring = await join(saved.cookie, false);
      await until(() => restoring.plans.length > 0);
      const savedPlan = restoring.plans.at(-1)!;
      expect(savedPlan.spawnSource).toBe('saved');
      const occupying = await join(other.cookie);
      expect(occupying.plans.at(-1)?.spawnSource).toBe('default');
      await move(occupying.room);
      restoring.ready(savedPlan);
      await until(() => restoring.plans.some((plan) => plan.spawnSource === 'default'));
      expect(app.room.state.players.has(restoring.room.sessionId)).toBe(false);
      restoring.ready(savedPlan); // late ready cannot create the saved body
      restoring.ready(restoring.plans.at(-1));
      await until(() => app.room.state.players.has(restoring.room.sessionId));
      expectSamePosition(position(restoring.room), { x: -3, y: 0.92, z: 4 });
      expect(app.room.diagnostics().players).toBe(2);
      expect(
        restoring.results.some(
          (result) => result.prepareId === savedPlan.prepareId && result.code === 'PLAN_REPLACED',
        ),
      ).toBe(true);
    });

    it('accepts areaFailed only for the active saved plan and ignores repeats and late ready', async () => {
      const player = await savedPlayer('position-area-failure');
      const restoring = await join(player.cookie, false);
      await until(() => restoring.plans.length > 0);
      const plan = restoring.plans.at(-1)!;
      restoring.room.send('areaFailed', {
        ...identity(plan),
        worldEpoch: 'wrong',
        code: 'RESOURCE_UNAVAILABLE',
      });
      restoring.room.send('areaFailed', {
        ...identity(plan),
        prepareId: randomUUID(),
        code: 'RESOURCE_UNAVAILABLE',
      });
      await wait(80);
      expect(restoring.plans.at(-1)?.prepareId).toBe(plan.prepareId);
      restoring.room.send('areaFailed', { ...identity(plan), code: 'RESOURCE_UNAVAILABLE' });
      await until(() => restoring.plans.at(-1)?.prepareId !== plan.prepareId);
      const defaultPlan = restoring.plans.at(-1)!;
      expect(defaultPlan.spawnSource).toBe('default');
      restoring.room.send('areaFailed', { ...identity(plan), code: 'RESOURCE_UNAVAILABLE' });
      restoring.ready(plan);
      await wait(80);
      expect(app.room.state.players.has(restoring.room.sessionId)).toBe(false);
      expect(restoring.plans.at(-1)?.prepareId).toBe(defaultPlan.prepareId);
      restoring.ready(defaultPlan);
      await until(() => app.room.state.players.has(restoring.room.sessionId));
      restoring.room.send('areaFailed', { ...identity(defaultPlan), code: 'RESOURCE_UNAVAILABLE' });
      restoring.ready(plan);
      await wait(50);
      expect(app.room.diagnostics().players).toBe(1);
      expect(app.room.diagnostics().playerPositions.spawns.fallbacks.area_unavailable).toBe(1);
    });

    it('bounds a saved preparation timeout and gives ordinary spawn exactly one new stage', async () => {
      const player = await savedPlayer('position-prepare-timeout');
      const restoring = await join(player.cookie, false);
      await until(() => restoring.plans.some((plan) => plan.spawnSource === 'saved'));
      const savedPlan = restoring.plans.at(-1)!;
      await until(() => restoring.plans.some((plan) => plan.spawnSource === 'default'), 2200);
      restoring.ready(savedPlan);
      restoring.ready(restoring.plans.at(-1));
      await until(() => app.room.state.players.has(restoring.room.sessionId));
      expect(app.room.diagnostics().playerPositions.spawns.fallbacks.prepare_timeout).toBe(1);
      expect(restoring.plans.filter((plan) => plan.spawnSource === 'saved')).toHaveLength(1);
    });

    it('reserves the account before asynchronous position reading and leaves unfinished joins unchanged', async () => {
      const player = await savedPlayer('position-read-race');
      await until(() => app.room.diagnostics().playerPositions.pendingAccounts === 0);
      const before = await row(player.accountId);
      const original = PlayerPositionStore.prototype.load;
      let reading = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(PlayerPositionStore.prototype, 'load').mockImplementationOnce(async function (
        this: PlayerPositionStore,
        ...args
      ) {
        reading = true;
        await gate;
        return original.apply(this, args);
      });
      try {
        const first = await join(player.cookie, false);
        await until(() => reading);
        await expect(join(player.cookie, false)).rejects.toThrow('ACCOUNT_IN_USE');
        await leave(first.room);
        release();
        await wait(80);
        expect(app.room.diagnostics().sessions).toBe(0);
        expect(app.room.diagnostics().players).toBe(0);
        expect(await row(player.accountId)).toEqual(before);
      } finally {
        release();
      }
    });

    it('ignores a successful SQL read that arrives after the join read budget', async () => {
      const player = await login('position-late-read');
      await seed(player.accountId, { x: -5, y: 0.92, z: 4 });
      const original = PlayerPositionStore.prototype.load;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(PlayerPositionStore.prototype, 'load').mockImplementationOnce(async function (
        this: PlayerPositionStore,
        ...args
      ) {
        const result = await original.apply(this, args);
        await gate;
        return result;
      });
      try {
        const restoring = await join(player.cookie, false);
        await until(() => restoring.plans.length > 0, 1800);
        const defaultPlan = restoring.plans.at(-1)!;
        expect(defaultPlan.spawnSource).toBe('default');
        release();
        await wait(60);
        expect(restoring.plans.at(-1)?.prepareId).toBe(defaultPlan.prepareId);
        restoring.ready(defaultPlan);
        await until(() => app.room.state.players.has(restoring.room.sessionId));
        expect(app.room.diagnostics().playerPositions.spawns.fallbacks.read_timeout).toBe(1);
      } finally {
        release();
      }
    });

    it('reconnects the existing body and preserves the drop snapshot through reconnect expiry', async () => {
      const player = await login('position-reconnect');
      const first = await join(player.cookie);
      await move(first.room);
      const entityId = first.room.state.players.get(first.room.sessionId)!.entityId;
      const token = first.room.reconnectionToken;
      first.room.connection.close(1000);
      await until(() => app.room.diagnostics().reserved === 1);
      const reconnect = await new Client(app.url).reconnect<WorldState>(token);
      reconnect.reconnection.enabled = false;
      for (const message of ['problem', 'resync', 'inventory', 'layoutChanged'])
        reconnect.onMessage(message, () => {});
      rooms.delete(first.room);
      rooms.add(reconnect);
      const preparation = prepareSdk(reconnect);
      await until(() => preparation.results.some((result) => result.ok));
      expect(reconnect.state.players.get(reconnect.sessionId)!.entityId).toBe(entityId);
      const disconnected = await move(reconnect, 180);
      reconnect.connection.close(1000);
      await until(() => app.room.diagnostics().reserved === 1);
      await until(() => app.room.diagnostics().playerPositions.pendingAccounts === 0);
      const dropped = await row(player.accountId);
      expectSamePosition({ x: dropped.x, y: dropped.y, z: dropped.z }, disconnected);
      await until(() => app.room.diagnostics().sessions === 0, 1500);
      rooms.delete(reconnect);
      expect((await row(player.accountId)).write_sequence).toBe(dropped.write_sequence);
      const restored = await join(player.cookie);
      expect(restored.room.state.players.get(restored.room.sessionId)!.entityId).not.toBe(entityId);
      expectSamePosition(position(restored.room), disconnected);
    });

    it('saves before logout revokes authorization and returns the account to its previous position', async () => {
      const player = await login('position-logout');
      const first = await join(player.cookie);
      const saved = await move(first.room);
      const result = await fetch(app.url + '/api/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: player.cookie,
          Origin: app.url,
          'X-CSRF-Token': player.state.csrfToken!,
        },
      });
      expect(result.status).toBe(204);
      await until(() => app.room.diagnostics().sessions === 0);
      rooms.delete(first.room);
      const loggedIn = await login('position-logout');
      expect(loggedIn.accountId).toBe(player.accountId);
      const restored = await join(loggedIn.cookie);
      expect(restored.plans.at(-1)?.spawnSource).toBe('saved');
      expectSamePosition(position(restored.room), saved);
    });

    it('saves the admitted body when authorization expires', async () => {
      const player = await login('position-auth-expiry');
      await fixture.pool.query('UPDATE auth_sessions SET expires_at=$2 WHERE account_id=$1', [
        player.accountId,
        new Date(Date.now() + 1600),
      ]);
      const first = await join(player.cookie);
      const saved = await move(first.room);
      await until(() => app.room.diagnostics().sessions === 0, 3000);
      rooms.delete(first.room);
      const loggedIn = await login('position-auth-expiry');
      const restored = await join(loggedIn.cookie);
      expect(restored.plans.at(-1)?.spawnSource).toBe('saved');
      expectSamePosition(position(restored.room), saved);
    });

    it('replaces the saved point immediately after a successful return to ordinary spawn', async () => {
      const player = await login('position-respawn');
      const first = await join(player.cookie);
      const initial = position(first.room);
      await move(first.room);
      first.room.send('requestRespawn', { requestId: 1, worldEpoch: info.worldEpoch });
      await until(() => first.room.state.players.get(first.room.sessionId)?.revision === 1);
      expect(first.plans.at(-1)?.reason).toBe('respawn');
      expectSamePosition(position(first.room), initial);
      await leave(first.room);
      const restored = await join(player.cookie);
      expectSamePosition(position(restored.room), initial);
    });

    it('flushes online positions before ownership release and restores across a new server epoch', async () => {
      const player = await login('position-shutdown');
      const first = await join(player.cookie);
      const saved = await move(first.room);
      const oldEpoch = info.worldEpoch;
      await app.close();
      rooms.delete(first.room);
      const stored = await row(player.accountId);
      expect(stored.write_epoch).toBe(oldEpoch);
      expectSamePosition({ x: stored.x, y: stored.y, z: stored.z }, saved);
      await start();
      expect(info.worldEpoch).not.toBe(oldEpoch);
      const restored = await join(player.cookie);
      expect(restored.plans.at(-1)?.spawnSource).toBe('saved');
      expectSamePosition(position(restored.room), saved);
    });

    it('checkpoints changed online positions without waiting for leave', async () => {
      const player = await login('position-checkpoint');
      const first = await join(player.cookie);
      const saved = await move(first.room);
      await until(async () => {
        const stored = await row(player.accountId);
        return !!stored && Math.abs(stored.x - saved.x) < 0.04;
      }, 6500);
      expect(app.room.diagnostics().sessions).toBe(1);
    });

    it('falls back on a storage read exception while leaving world gameplay available', async () => {
      const player = await login('position-read-error');
      vi.spyOn(PlayerPositionStore.prototype, 'load').mockRejectedValueOnce(
        new Error('injected position read failure'),
      );
      const restored = await join(player.cookie);
      expect(restored.plans.at(-1)?.spawnSource).toBe('default');
      expect(app.room.diagnostics().playerPositions.spawns.fallbacks.read_error).toBe(1);
      expect(app.room.isReady()).toBe(true);
      await move(restored.room, 180);
    });

    it('lets logout win while position reading is in flight without creating or overwriting a body', async () => {
      const player = await savedPlayer('position-reading-logout');
      await until(() => app.room.diagnostics().playerPositions.pendingAccounts === 0);
      const before = await row(player.accountId);
      const original = PlayerPositionStore.prototype.load;
      let reading = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(PlayerPositionStore.prototype, 'load').mockImplementationOnce(async function (
        this: PlayerPositionStore,
        ...args
      ) {
        reading = true;
        const result = await original.apply(this, args);
        await gate;
        return result;
      });
      try {
        const first = await join(player.cookie, false);
        await until(() => reading);
        const result = await fetch(app.url + '/api/auth/logout', {
          method: 'POST',
          headers: {
            Cookie: player.cookie,
            Origin: app.url,
            'X-CSRF-Token': player.state.csrfToken!,
          },
        });
        expect(result.status).toBe(204);
        await until(() => app.room.diagnostics().sessions === 0);
        rooms.delete(first.room);
        release();
        await wait(80);
        expect(app.room.diagnostics().players).toBe(0);
        expect(await row(player.accountId)).toEqual(before);
      } finally {
        release();
      }
    });

    it('does not extend the ordinary preparation deadline for repeated failure or plan requests', async () => {
      const player = await login('position-default-timeout');
      const joining = await join(player.cookie, false);
      await until(() => joining.plans.length > 0);
      const plan = joining.plans.at(-1)!;
      const startedAt = performance.now();
      const repeats = setInterval(() => {
        joining.room.send('requestArea');
        joining.room.send('areaFailed', { ...identity(plan), code: 'RESOURCE_UNAVAILABLE' });
      }, 80);
      try {
        await until(() => app.room.diagnostics().sessions === 0, 2100);
        expect(performance.now() - startedAt).toBeLessThan(1800);
        expect(joining.plans.every((value) => value.prepareId === plan.prepareId)).toBe(true);
        expect(joining.results.at(-1)?.code).toBe('PREPARE_TIMEOUT');
        rooms.delete(joining.room);
        expect(await row(player.accountId)).toBeUndefined();
      } finally {
        clearInterval(repeats);
      }
    });

    it('preserves saved stage deadlines through layout changes and falls back once when geometry blocks it', async () => {
      await app.close();
      temporaryDirectory = await mkdtemp(pathJoin(tmpdir(), 'su-position-layout-'));
      const worldDirectory = await buildStaticPlacementWorld(temporaryDirectory);
      await start(4000, worldDirectory);
      const player = await savedPlayer('position-layout-player');
      const builderAccount = await login('position-layout-builder');
      const builder = await join(builderAccount.cookie);
      const actions: ActionResult[] = [];
      const changes: PlaceStaticResult[] = [];
      builder.room.onMessage<ActionResult>('actionResult', (result) => actions.push(result));
      builder.room.onMessage<PlaceStaticResult>('staticPlacementResult', (result) =>
        changes.push(result),
      );
      builder.room.send('requestChat', {
        requestId: 1,
        worldEpoch: info.worldEpoch,
        text: '/motherlode',
      });
      await until(() => actions.length > 0);
      expect(actions[0]).toMatchObject({ ok: true, effect: { kind: 'staticPlacement' } });
      const restoring = await join(player.cookie, false);
      await until(() => restoring.plans.length > 0);
      const firstPlan = restoring.plans.at(-1)!;
      expect(firstPlan.spawnSource).toBe('saved');
      const initialStage = app.room
        .diagnostics()
        .testPreparations!.find((entry) => entry.sessionId === restoring.room.sessionId)!;
      async function place(x: number, z: number) {
        if (changes.length) await wait(2100);
        const current: WorldInfo = await (await fetch(app.url + '/api/world')).json();
        const previousChanges = changes.length;
        builder.room.send('placeStatic', {
          operationId: randomUUID(),
          worldEpoch: current.worldEpoch,
          assetReleaseVersion: current.assetReleaseVersion,
          assetId: 'bench-0152a250d22ef0a9',
          placementCatalogVersion: current.placementCatalog!.placementCatalogVersion,
          expectedLayoutRevision: current.layoutRevision,
          position: { x, z },
          yawStep: 0,
        });
        await until(() => changes.length > previousChanges);
        expect(changes.at(-1)?.ok, JSON.stringify(changes.at(-1))).toBe(true);
      }
      await place(10, 10);
      await until(() => restoring.plans.at(-1)!.layoutRevision > firstPlan.layoutRevision);
      const revised = restoring.plans.at(-1)!;
      expect(revised.spawnSource).toBe('saved');
      expect(revised.position).toEqual(firstPlan.position);
      const revisedStage = app.room
        .diagnostics()
        .testPreparations!.find((entry) => entry.sessionId === restoring.room.sessionId)!;
      expect(revisedStage.startedAt).toBe(initialStage.startedAt);
      expect(revisedStage.deadline).toBe(initialStage.deadline);
      restoring.ready(firstPlan);
      await wait(60);
      expect(app.room.state.players.has(restoring.room.sessionId)).toBe(false);
      restoring.ready(revised);
      await until(
        () => app.room.state.players.has(restoring.room.sessionId) && !app.room.state.paused,
      );
      expectSamePosition(position(restoring.room), player.saved);
      await leave(restoring.room);
      info = await (await fetch(app.url + '/api/world')).json();
      const second = await join(player.cookie, false);
      await until(() => second.plans.length > 0);
      expect(second.plans.at(-1)?.spawnSource).toBe('saved');
      await place(player.saved.x, player.saved.z);
      await until(() => second.plans.at(-1)?.spawnSource === 'default');
      expect(app.room.diagnostics().playerPositions.spawns.fallbacks.BLOCKED).toBe(1);
      second.ready();
      await until(
        () => app.room.state.players.has(second.room.sessionId) && !app.room.state.paused,
      );
      expect(position(second.room).x).toBeCloseTo(-9, 2);
      expect(app.room.diagnostics().players).toBe(2);

      // A layout replacement of reconnect preparation must still clear the old drop snapshot.
      await move(second.room, 180);
      const token = second.room.reconnectionToken;
      const entityId = second.room.state.players.get(second.room.sessionId)!.entityId;
      second.room.connection.close(1000);
      await until(() => app.room.diagnostics().reserved === 1);
      await until(() => app.room.diagnostics().playerPositions.pendingAccounts === 0);
      const oldDrop = (
        await fixture.pool.query('SELECT * FROM player_positions WHERE account_id=$1', [
          player.accountId,
        ])
      ).rows[0];
      const reconnect = await new Client(app.url).reconnect<WorldState>(token);
      reconnect.reconnection.enabled = false;
      for (const message of ['problem', 'resync', 'inventory', 'layoutChanged'])
        reconnect.onMessage(message, () => {});
      rooms.delete(second.room);
      rooms.add(reconnect);
      const reconnectPreparation = prepareSdk(reconnect, false);
      await until(() => reconnectPreparation.plans.length > 0);
      const reconnectPlan = reconnectPreparation.plans.at(-1)!;
      expect(reconnectPlan.reason).toBe('reconnect');
      await place(10, 14);
      await until(
        () => reconnectPreparation.plans.at(-1)!.layoutRevision > reconnectPlan.layoutRevision,
      );
      expect(reconnectPreparation.plans.at(-1)?.reason).toBe('reconnect');
      reconnectPreparation.ready();
      await until(
        () => reconnectPreparation.results.some((result) => result.ok) && !app.room.state.paused,
      );
      expect(reconnect.state.players.get(reconnect.sessionId)!.entityId).toBe(entityId);
      const newPosition = await move(reconnect, 180);
      reconnect.connection.close(1000);
      await until(() => app.room.diagnostics().sessions === 1, 1500);
      rooms.delete(reconnect);
      const newDrop = (
        await fixture.pool.query('SELECT * FROM player_positions WHERE account_id=$1', [
          player.accountId,
        ])
      ).rows[0];
      expect(Number(newDrop.write_sequence)).toBeGreaterThan(Number(oldDrop.write_sequence));
      expectSamePosition({ x: newDrop.x, y: newDrop.y, z: newDrop.z }, newPosition);
      expect(Math.abs(newDrop.x - oldDrop.x)).toBeGreaterThan(0.4);
    }, 30000);

    it('keeps guests on ordinary spawn and creates no account position', async () => {
      const before = (
        await fixture.pool.query('SELECT count(*)::int AS count FROM player_positions')
      ).rows[0].count;
      const guest = await join();
      expect(guest.plans.at(-1)?.spawnSource).toBe('default');
      await move(guest.room);
      await leave(guest.room);
      expect(
        (await fixture.pool.query('SELECT count(*)::int AS count FROM player_positions')).rows[0]
          .count,
      ).toBe(before);
    });
  },
);
