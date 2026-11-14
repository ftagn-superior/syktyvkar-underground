import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from '@colyseus/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGameServer } from '../helpers/game-server.js';
import { createAccountFixture, loginAccount, responseCookie } from '../helpers/account-fixture.js';
import { prepareSdk } from '../helpers/prepare.js';
import { buildStaticPlacementWorld } from '../helpers/static-placement-world.js';
import type {
  PlaceStaticRequest,
  PlaceStaticResult,
  WorldInfo,
  ActionResult,
} from '../../packages/contracts/src/index.js';
import { MoveInputSchema } from '../../packages/protocol/src/index.js';
import { LayoutPreparation } from '../../apps/server/src/layout/preparation.js';
import type { WorldState } from '../../packages/protocol/src/index.js';
import { AuthoritativeWorld } from '../../packages/simulation/src/server.js';
import { StaticLayoutStore } from '../../apps/server/src/layout/store.js';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 500; n++) {
    if (await predicate()) return;
    await wait(20);
  }
  throw new Error('Static placement timed out');
}
describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('live static placement', () => {
  let directory: string,
    worldDirectory: string,
    fixture: Awaited<ReturnType<typeof createAccountFixture>>;
  let app: Awaited<ReturnType<typeof createGameServer>>, info: WorldInfo;
  const rooms: Room<WorldState>[] = [];
  async function start() {
    app = await createGameServer({
      port: 0,
      accounts: fixture,
      worldDirectory,
      prepareTimeoutMs: 1000,
    });
    fixture.config.publicOrigin = app.url;
    info = await fetch(app.url + '/api/world').then((r) => r.json());
  }
  async function connect(cookie?: string, automatic = true) {
    info = await fetch(app.url + '/api/world').then((r) => r.json());
    const room = await new Client(
      app.url,
      cookie ? { headers: { Cookie: cookie } } : {},
    ).joinById<WorldState>(info.roomId, { ...info, accountMode: cookie ? 'account' : 'guest' });
    rooms.push(room);
    room.reconnection.enabled = false;
    const results: PlaceStaticResult[] = [],
      actions: ActionResult[] = [];
    room.onMessage('staticPlacementResult', (r) => results.push(r));
    room.onMessage('actionResult', (r) => actions.push(r));
    for (const message of ['problem', 'resync', 'inventory', 'layoutChanged'])
      room.onMessage(message, () => {});
    const preparation = prepareSdk(room, automatic);
    if (!automatic) {
      await until(() => preparation.plans.length > 0);
      preparation.ready();
    }
    await until(() => room.state?.players?.has(room.sessionId));
    return { room, results, actions, preparation };
  }
  function request(): PlaceStaticRequest {
    return {
      operationId: randomUUID(),
      worldEpoch: info.worldEpoch,
      assetReleaseVersion: info.assetReleaseVersion!,
      assetId: 'bench-0152a250d22ef0a9',
      placementCatalogVersion: info.placementCatalog!.placementCatalogVersion,
      expectedLayoutRevision: info.layoutRevision!,
      position: { x: 10, z: 10 },
      yawStep: 6,
    };
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'su-live-static-'));
    worldDirectory = await buildStaticPlacementWorld(directory);
    fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL!);
    await start();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(rooms.splice(0).map((r) => r.leave()));
    await app?.close();
    await fixture?.close();
    await rm(directory, { recursive: true, force: true });
  });
  it('opens privately, commits once, switches both client revisions and survives restart', async () => {
    const cookie = responseCookie((await loginAccount(app.url, 'builder')).result, 'su_session');
    const owner = await connect(cookie),
      observer = await connect();
    owner.room.send('requestChat', {
      requestId: 1,
      worldEpoch: info.worldEpoch,
      text: '/motherlode',
    });
    await until(() => owner.actions.length === 1);
    expect(owner.actions[0]).toMatchObject({ ok: true, effect: { kind: 'staticPlacement' } });
    const initial = { x: app.room.state.players.get(owner.room.sessionId)!.x };
    const req = request();
    owner.room.send('placeStatic', req);
    owner.room.send('placeStatic', req);
    await until(() => owner.results.length === 2 && !app.room.state.paused);
    expect(owner.results[0], JSON.stringify(owner.results[0])).toMatchObject({
      ok: true,
      entityId: `placed_${req.operationId}`,
    });
    expect(owner.results[1]).toEqual(owner.results[0]);
    expect(owner.preparation.changes).toHaveLength(1);
    expect(observer.preparation.changes).toHaveLength(1);
    expect(owner.preparation.changes[0]).toMatchObject({
      operationId: req.operationId,
      previousLayoutRevision: req.expectedLayoutRevision,
      publication: { layoutRevision: req.expectedLayoutRevision + 1 },
    });
    expect(owner.preparation.changes[0].changedCellIds.length).toBeGreaterThan(0);
    expect(app.room.state.players.get(owner.room.sessionId)!.x).toBeCloseTo(initial.x);
    expect(observer.actions).toEqual([]);
    expect(app.room.state.players.get(owner.room.sessionId)!.chatText).toBe('');
    const rows = (
      await fixture.pool.query("SELECT * FROM world_static_operations WHERE source='game'")
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBeTruthy();
    owner.room.send('placeStatic', { ...req, worldEpoch: 'old', expectedLayoutRevision: 999 });
    await until(() => owner.results.length === 3);
    expect(owner.results[2]).toEqual(owner.results[0]);
    owner.room.send('placeStatic', { ...req, yawStep: 1 });
    await until(() => owner.results.length === 4);
    expect(owner.results[3]).toMatchObject({ code: 'OPERATION_CONFLICT' });
    const current = await fetch(app.url + '/api/world').then((r) => r.json());
    expect(current.worldEpoch).toBe(info.worldEpoch);
    expect(current.mapVersion).not.toBe(info.mapVersion);
    expect((await fetch(app.url + current.manifestUrl)).status).toBe(200);
    await Promise.all(rooms.splice(0).map((r) => r.leave()));
    await app.close();
    await start();
    const restored = await connect(cookie);
    restored.room.send('placeStatic', req);
    await until(() => restored.results.length === 1);
    expect(restored.results[0]).toEqual(owner.results[0]);
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS n FROM world_static_instances WHERE entity_id=$1',
          [`placed_${req.operationId}`],
        )
      ).rows[0].n,
    ).toBe(1);
  }, 30000);
  it('resolves a lost commit acknowledgement before resuming the changed geometry', async () => {
    const cookie = responseCookie((await loginAccount(app.url, 'uncertain')).result, 'su_session');
    const owner = await connect(cookie);
    const req = request();
    const original = StaticLayoutStore.prototype.createGame;
    vi.spyOn(StaticLayoutStore.prototype, 'createGame').mockImplementationOnce(async function (
      this: StaticLayoutStore,
      ...args
    ) {
      await original.apply(this, args);
      throw new Error('lost commit acknowledgement');
    });
    owner.room.send('placeStatic', req);
    await until(() => owner.results.length === 1 && !app.room.state.paused);
    expect(owner.results[0]).toMatchObject({ ok: true });
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS n FROM world_static_operations WHERE source='game'",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(app.room.isReady()).toBe(true);
  }, 20000);
  it('keeps a committed geometry failure unavailable until a normal restart restores the saved instance', async () => {
    const cookie = responseCookie(
      (await loginAccount(app.url, 'apply-failure')).result,
      'su_session',
    );
    const owner = await connect(cookie);
    const req = request();
    const prepare = AuthoritativeWorld.prototype.prepareStaticReplacement;
    vi.spyOn(AuthoritativeWorld.prototype, 'prepareStaticReplacement').mockImplementationOnce(
      function (this: AuthoritativeWorld, definition) {
        const staged = prepare.call(this, definition);
        return {
          ...staged,
          commit: () => {
            throw new Error('injected Havok apply failure');
          },
        };
      },
    );
    owner.room.send('placeStatic', req);
    await until(() => !app.room.isReady());
    await until(() => owner.results.length > 0);
    expect(app.room.state.paused).toBe(true);
    expect((await fetch(app.url + '/health/ready')).status).toBe(503);
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS n FROM world_static_operations WHERE source='game'",
        )
      ).rows[0].n,
    ).toBe(1);
    await Promise.allSettled(rooms.splice(0).map((r) => r.leave()));
    await app.close();
    await start();
    const restored = await connect(cookie);
    restored.room.send('placeStatic', req);
    await until(() => restored.results.length === 1);
    expect(restored.results[0]).toMatchObject({ ok: true, entityId: `placed_${req.operationId}` });
    expect(app.room.isReady()).toBe(true);
  }, 20000);

  it('publishes several additions and releases old runtime publications after every client acknowledgement', async () => {
    const owner = await connect(
      responseCookie((await loginAccount(app.url, 'sequential')).result, 'su_session'),
    );
    await connect();
    let previous = info.manifestUrl;
    const bodies = app.room.diagnostics().bodies;
    for (let n = 0; n < 3; n++) {
      if (n) await wait(2050);
      info = await fetch(app.url + '/api/world').then((r) => r.json());
      owner.room.send('placeStatic', {
        ...request(),
        position: { x: 10, z: 6 + n * 4 },
        yawStep: 0,
      });
      await until(() => owner.results.length === n + 1 && !app.room.state.paused);
      expect(owner.results[n]).toMatchObject({ ok: true });
      const current = await fetch(app.url + '/api/world').then((r) => r.json());
      await until(async () => (await fetch(app.url + previous)).status === 404);
      expect((await fetch(app.url + previous)).status).toBe(404);
      expect((await fetch(app.url + current.manifestUrl)).status).toBe(200);
      expect(app.room.diagnostics().bodies).toBe(bodies + n + 1);
      previous = current.manifestUrl;
    }
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS n FROM world_static_operations WHERE source='game'",
        )
      ).rows[0].n,
    ).toBe(3);
    const publications = join(worldDirectory, 'layouts', info.assetReleaseVersion);
    await until(async () => (await readdir(publications)).length === 2);
    await app.close();
    expect((await readdir(publications)).length).toBe(2); // Shutdown preserves startup and the confirmed current publication.
  }, 20000);

  it('rolls back a failed SQL insert and preserves item ownership before retrying the same operation', async () => {
    const owner = await connect(
      responseCookie((await loginAccount(app.url, 'rollback')).result, 'su_session'),
    );
    owner.room.send('requestChat', {
      requestId: 1,
      worldEpoch: info.worldEpoch,
      text: '/giveme wooden-crate',
    });
    await until(() => owner.actions.length === 1);
    expect(owner.actions[0].ok).toBe(true);
    const itemOwnership = (
      await fixture.pool.query(
        'SELECT id,world_id,slot_id,placement_version FROM item_instances ORDER BY id',
      )
    ).rows;
    const before = (
      await fixture.pool.query(
        'SELECT revision,validated_revision,validated_hash FROM world_layouts',
      )
    ).rows;
    const compatibility = (
      await fixture.pool.query('SELECT compatibility_hash FROM persistent_worlds')
    ).rows;
    await fixture.pool
      .query(`CREATE FUNCTION reject_game_creation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.entity_id LIKE 'placed_%' THEN RAISE EXCEPTION 'injected insert failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_game_creation AFTER INSERT ON world_static_instances FOR EACH ROW EXECUTE FUNCTION reject_game_creation();`);
    try {
      owner.room.send('placeStatic', request());
      await until(() => app.room.state.pauseReason === 'STORAGE_UNAVAILABLE');
      expect(
        (
          await fixture.pool.query(
            'SELECT revision,validated_revision,validated_hash FROM world_layouts',
          )
        ).rows,
      ).toEqual(before);
      expect(
        (await fixture.pool.query('SELECT compatibility_hash FROM persistent_worlds')).rows,
      ).toEqual(compatibility);
      expect(
        (await fixture.pool.query("SELECT 1 FROM world_static_operations WHERE source='game'"))
          .rows,
      ).toEqual([]);
      expect(
        (
          await fixture.pool.query(
            'SELECT id,world_id,slot_id,placement_version FROM item_instances ORDER BY id',
          )
        ).rows,
      ).toEqual(itemOwnership);
    } finally {
      await fixture.pool.query(
        'DROP TRIGGER reject_game_creation ON world_static_instances; DROP FUNCTION reject_game_creation();',
      );
    }
    await until(() => owner.results.length === 1 && !app.room.state.paused);
    expect(owner.results[0]).toMatchObject({ ok: true });
    expect(
      (
        await fixture.pool.query(
          'SELECT id,world_id,slot_id,placement_version FROM item_instances ORDER BY id',
        )
      ).rows,
    ).toEqual(itemOwnership);
  }, 20000);

  it('keeps simulation, entry and item commands ready while an old client is retained, then evicts it', async () => {
    const owner = await connect(
      responseCookie((await loginAccount(app.url, 'nonblocking')).result, 'su_session'),
    );
    const slow = await connect(undefined, false);
    const old = slow.preparation.plans.at(-1)!;
    const oldManifest = info.manifestUrl;
    owner.room.send('placeStatic', request());
    await until(() => owner.results.length === 1 && slow.preparation.changes.length === 1);
    expect(owner.results[0]).toMatchObject({ ok: true });
    expect(app.room.state.paused).toBe(false);
    const tick = app.room.state.serverTick;
    slow.preparation.ready(old);
    slow.preparation.applied({
      ...slow.preparation.changes[0],
      publication: { ...slow.preparation.changes[0].publication, mapVersion: old.mapVersion },
    });
    await wait(100);
    expect(app.room.state.paused).toBe(false);
    expect(app.room.state.serverTick).toBeGreaterThan(tick);
    expect(app.room.isReady()).toBe(true);
    expect((await fetch(app.url + '/health/ready')).status).toBe(200);
    expect((await fetch(app.url + oldManifest)).status).toBe(200);
    info = await fetch(app.url + '/api/world').then((r) => r.json());
    owner.room.send('placeStatic', { ...request(), position: { x: 10, z: 14 } });
    await until(() => owner.results.length === 2);
    expect(owner.results[1]).toMatchObject({ code: 'WORLD_NOT_READY' });
    owner.room.send('requestChat', {
      requestId: 9,
      worldEpoch: info.worldEpoch,
      text: '/giveme wooden-crate',
    });
    await until(() => owner.actions.length === 1);
    expect(owner.actions[0].ok).toBe(true);
    const joined = await connect();
    expect(joined.preparation.plans[0].layoutRevision).toBe(info.layoutRevision);
    expect(joined.preparation.plans[0].mapVersion).toBe(info.mapVersion);
    await until(() => !app.room.state.players.has(slow.room.sessionId));
    await until(async () => (await fetch(app.url + oldManifest)).status === 404);
    expect(app.room.isReady()).toBe(true);
    expect(app.room.state.players.has(owner.room.sessionId)).toBe(true);
  }, 15000);

  it('does not recreate a successful local plan while layoutApplied is still in flight', async () => {
    const owner = await connect(
      responseCookie((await loginAccount(app.url, 'local-ready')).result, 'su_session'),
    );
    const observer = await connect(undefined, false);
    owner.room.send('placeStatic', request());
    await until(
      () => owner.results.length === 1 && observer.preparation.plans.at(-1)?.reason === 'layout',
    );
    const plan = observer.preparation.plans.at(-1)!;
    observer.preparation.ready(plan);
    await until(() =>
      observer.preparation.results.some(
        (result) => result.prepareId === plan.prepareId && result.ok,
      ),
    );
    const count = observer.preparation.plans.length;
    const tick = app.room.state.serverTick;
    await wait(150);
    expect(app.room.state.serverTick).toBeGreaterThan(tick);
    expect(observer.preparation.plans).toHaveLength(count);
    expect(app.room.state.players.has(observer.room.sessionId)).toBe(true);
    observer.preparation.applied();
    await until(() => app.room.diagnostics().layoutTransitionPending.length === 0);
  }, 15000);

  it('supplies the current publication when authentication overlaps a layout commit', async () => {
    const owner = await connect(
      responseCookie((await loginAccount(app.url, 'join-race')).result, 'su_session'),
    );
    const old = { ...info };
    const original = app.room.onAuth;
    let release!: () => void;
    let authenticated = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(app.room, 'onAuth').mockImplementationOnce(async (...args) => {
      const result = await original.apply(app.room, args);
      authenticated = true;
      await gate;
      return result;
    });
    const joining = new Client(app.url).joinById<WorldState>(old.roomId, {
      ...old,
      accountMode: 'guest',
    });
    try {
      await until(() => authenticated);
      owner.room.send('placeStatic', request());
      await until(() => owner.results.length === 1);
      expect(owner.results[0].ok).toBe(true);
    } finally {
      release();
    }
    const joined = await joining;
    rooms.push(joined);
    joined.reconnection.enabled = false;
    for (const message of ['problem', 'resync', 'inventory']) joined.onMessage(message, () => {});
    const preparation = prepareSdk(joined);
    await until(
      () => preparation.changes.length === 1 && joined.state?.players?.has(joined.sessionId),
    );
    expect(preparation.changes[0].publication).toMatchObject({
      mapVersion: app.room.state.mapVersion,
      layoutRevision: app.room.state.layoutRevision,
    });
    expect(preparation.changes[0].publication.mapVersion).not.toBe(old.mapVersion);
    expect(preparation.plans.at(-1)?.mapVersion).toBe(app.room.state.mapVersion);
  }, 15000);

  it('serves movement, inventory commands and new entry while publication preparation is pending', async () => {
    const owner = await connect(
      responseCookie((await loginAccount(app.url, 'background')).result, 'su_session'),
    );
    const observer = await connect();
    const original = LayoutPreparation.prototype.prepare;
    let release!: () => void;
    let preparing = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(LayoutPreparation.prototype, 'prepare').mockImplementationOnce(async function (
      this: LayoutPreparation,
      ...args
    ) {
      preparing = true;
      await gate;
      return original.apply(this, args);
    });
    const req = request();
    try {
      owner.room.send('placeStatic', req);
      await until(() => preparing);
      const tick = app.room.state.serverTick;
      const x = app.room.state.players.get(observer.room.sessionId)!.x;
      const input = observer.room.input({ type: MoveInputSchema, mode: 'reliable' });
      input.data.moveX = 1;
      const movement = setInterval(() => input.send(), 16);
      try {
        await until(() => app.room.state.players.get(observer.room.sessionId)!.x > x + 0.2);
      } finally {
        clearInterval(movement);
      }
      expect(app.room.state.serverTick).toBeGreaterThan(tick);
      expect(app.room.state.paused).toBe(false);
      expect((await fetch(app.url + '/health/ready')).status).toBe(200);
      owner.room.send('requestChat', {
        requestId: 1,
        worldEpoch: info.worldEpoch,
        text: '/giveme wooden-crate',
      });
      await until(() => owner.actions.length === 1);
      expect(owner.actions[0].ok).toBe(true);
      const joined = await connect();
      expect(joined.preparation.plans[0].layoutRevision).toBe(req.expectedLayoutRevision);
      expect(owner.results).toHaveLength(0);
    } finally {
      release();
    }
    await until(() => owner.results.length === 1);
    expect(owner.results[0]).toMatchObject({ ok: true });
  }, 20000);
  it('rechecks live geometry when a player arrives at the prepared placement', async () => {
    const owner = await connect(
      responseCookie((await loginAccount(app.url, 'occupied-during-build')).result, 'su_session'),
    );
    const observer = await connect();
    const original = LayoutPreparation.prototype.prepare;
    let release!: () => void;
    let preparing = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(LayoutPreparation.prototype, 'prepare').mockImplementationOnce(async function (
      this: LayoutPreparation,
      ...args
    ) {
      preparing = true;
      await gate;
      return original.apply(this, args);
    });
    const req = request();
    const bodies = app.room.diagnostics().bodies;
    const previous = info.mapVersion;
    try {
      owner.room.send('placeStatic', req);
      await until(() => preparing);
      const world = (app.room as unknown as { world: AuthoritativeWorld }).world;
      expect(
        world.respawnPlayer(app.room.state.players.get(observer.room.sessionId)!.entityId, {
          x: req.position.x,
          y: 0,
          z: req.position.z,
        }),
      ).toBe(true);
    } finally {
      release();
    }
    await until(() => owner.results.length === 1);
    expect(owner.results[0]).toMatchObject({ ok: false, code: 'BLOCKED' });
    expect(app.room.diagnostics().bodies).toBe(bodies);
    expect((await fetch(app.url + '/api/world').then((r) => r.json())).mapVersion).toBe(previous);
    expect(
      (await fixture.pool.query("SELECT 1 FROM world_static_operations WHERE source='game'"))
        .rowCount,
    ).toBe(0);
    expect(app.room.state.paused).toBe(false);
    expect(app.room.state.players.get(observer.room.sessionId)!.x).toBeCloseTo(req.position.x);
  }, 20000);

  it('rejects guests, changed headers and blocked geometry without a game row', async () => {
    const guest = await connect();
    guest.room.send('placeStatic', request());
    await until(() => guest.results.length === 1);
    expect(guest.results[0]).toMatchObject({ code: 'AUTH_REQUIRED' });
    const owner = await connect(
      responseCookie((await loginAccount(app.url, 'invalid')).result, 'su_session'),
    );
    for (const override of [
      { worldEpoch: 'old' },
      { expectedLayoutRevision: 999 },
      { placementCatalogVersion: 'a'.repeat(64) },
      { assetId: 'tree-birch-small' },
      { placementCatalogVersion: '0'.repeat(64) },
      { position: { x: 5, z: 0 } },
      { position: { x: 0, z: -10 } },
      { position: { x: 20, z: 10 } },
    ]) {
      owner.room.send('placeStatic', { ...request(), ...override });
      const n = owner.results.length;
      await until(() => owner.results.length > n);
      expect(owner.results.at(-1)!.ok).toBe(false);
      expect(app.room.state.paused).toBe(false);
    }
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS n FROM world_static_operations WHERE source='game'",
        )
      ).rows[0].n,
    ).toBe(0);
  }, 20000);
});
