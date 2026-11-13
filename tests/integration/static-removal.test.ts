import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from '@colyseus/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionResult,
  PlaceStaticRequest,
  PlaceStaticResult,
  RemoveStaticRequest,
  RemoveStaticResult,
  WorldInfo,
  WorldManifest,
} from '../../packages/contracts/src/index.js';
import { STATIC_PLACEMENT_ASSET_ID } from '../../packages/contracts/src/index.js';
import type { WorldState } from '../../packages/protocol/src/index.js';
import { StaticLayoutStore } from '../../apps/server/src/layout/store.js';
import { AuthoritativeWorld } from '../../packages/simulation/src/server.js';
import { createGameServer } from '../helpers/game-server.js';
import { createAccountFixture, loginAccount, responseCookie } from '../helpers/account-fixture.js';
import { prepareSdk } from '../helpers/prepare.js';
import {
  buildStaticRemovalWorld,
  REMOVAL_HOUSE_ASSET_ID,
  REMOVAL_SEED_OBJECTS,
} from '../helpers/static-removal-world.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 750; n++) {
    if (await predicate()) return;
    await wait(20);
  }
  throw new Error('Static removal timed out');
}

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('live whole-object static removal', () => {
  let directory: string, worldDirectory: string;
  let fixture: Awaited<ReturnType<typeof createAccountFixture>>;
  let app: Awaited<ReturnType<typeof createGameServer>>, info: WorldInfo;
  const rooms: Room<WorldState>[] = [];

  async function refresh() {
    info = await fetch(app.url + '/api/world').then((response) => response.json());
    return info;
  }
  async function start() {
    app = await createGameServer({
      port: 0,
      accounts: fixture,
      worldDirectory,
      prepareTimeoutMs: 2000,
    });
    fixture.config.publicOrigin = app.url;
    await refresh();
  }
  async function login(subject: string) {
    return responseCookie((await loginAccount(app.url, subject)).result, 'su_session');
  }
  async function connect(cookie?: string) {
    await refresh();
    const room = await new Client(
      app.url,
      cookie ? { headers: { Cookie: cookie } } : {},
    ).joinById<WorldState>(info.roomId, { ...info, accountMode: cookie ? 'account' : 'guest' });
    rooms.push(room);
    room.reconnection.enabled = false;
    const removals: RemoveStaticResult[] = [],
      placements: PlaceStaticResult[] = [];
    const actions: ActionResult[] = [];
    room.onMessage('staticRemovalResult', (result) => removals.push(result));
    room.onMessage('staticPlacementResult', (result) => placements.push(result));
    room.onMessage('actionResult', (result) => actions.push(result));
    for (const message of ['problem', 'resync', 'inventory', 'layoutChanged'])
      room.onMessage(message, () => {});
    const preparation = prepareSdk(room);
    await until(() => room.state?.players?.has(room.sessionId));
    return { room, removals, placements, actions, preparation };
  }
  function request(entityId: string = REMOVAL_SEED_OBJECTS.house.entityId): RemoveStaticRequest {
    return {
      operationId: randomUUID(),
      worldEpoch: info.worldEpoch,
      assetReleaseVersion: info.assetReleaseVersion!,
      expectedLayoutRevision: info.layoutRevision!,
      entityId,
    };
  }
  async function publishedIds() {
    const current = await refresh();
    const url = new URL(current.manifestUrl, app.url);
    const manifest: WorldManifest = await fetch(url).then((response) => response.json());
    const cells = await Promise.all(
      manifest.cells.map(async (cell) =>
        fetch(new URL(cell.file, url)).then((response) => response.json()),
      ),
    );
    return new Set(cells.flatMap((cell) => cell.buildings.map((item: any) => item.entityId)));
  }
  async function settle() {
    await until(() => !app.room.state.paused && app.room.isReady());
    await refresh();
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'su-removal-'));
    worldDirectory = await buildStaticRemovalWorld(directory);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL!);
    await start();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(rooms.splice(0).map((room) => room.leave()));
    await app?.close();
    await fixture?.close();
  });

  it('opens privately for accounts and rejects guest commands and direct writes', async () => {
    const player = await connect(await login('remover'));
    const guest = await connect();
    player.room.send('requestChat', {
      requestId: 1,
      worldEpoch: info.worldEpoch,
      text: '/vilievna',
    });
    await until(() => player.actions.length === 1);
    expect(player.actions[0]).toMatchObject({ ok: true, effect: { kind: 'staticRemoval' } });
    const effect = player.actions[0].effect;
    if (effect?.kind !== 'staticRemoval') throw new Error('Missing removal effect');
    expect(effect.protectedEntityIds).toContain('floor');
    expect(effect.protectedEntityIds).not.toContain(REMOVAL_SEED_OBJECTS.house.entityId);
    expect(guest.actions).toEqual([]);
    expect(app.room.state.players.get(player.room.sessionId)!.chatText).toBe('');
    guest.room.send('requestChat', {
      requestId: 1,
      worldEpoch: info.worldEpoch,
      text: '/vilievna',
    });
    guest.room.send('removeStatic', request());
    await until(() => guest.actions.length === 1 && guest.removals.length === 1);
    expect(guest.actions[0]).toMatchObject({ ok: false, code: 'AUTH_REQUIRED' });
    expect(guest.removals[0]).toMatchObject({ ok: false, code: 'AUTH_REQUIRED' });
    expect((await publishedIds()).has(REMOVAL_SEED_OBJECTS.house.entityId)).toBe(true);
  });

  it('disables an original non-catalog building once, removes its physics for both clients and survives restart', async () => {
    const cookie = await login('original-building-remover');
    const player = await connect(cookie),
      observer = await connect();
    const catalog = await fetch(app.url + info.placementCatalog!.url).then((response) =>
      response.json(),
    );
    expect(catalog.models.some((model: any) => model.assetId === REMOVAL_HOUSE_ASSET_ID)).toBe(
      false,
    );
    const beforeBodies = app.room.diagnostics().bodies;
    const req = request();
    player.room.send('removeStatic', req);
    player.room.send('removeStatic', req);
    await until(() => player.removals.length === 2);
    await settle();
    expect(player.removals[0]).toMatchObject({ ok: true, entityId: req.entityId });
    expect(player.removals[1]).toEqual(player.removals[0]);
    expect(player.preparation.plans.at(-1)?.reason).toBe('layout');
    expect(observer.preparation.plans.at(-1)?.reason).toBe('layout');
    expect(app.room.diagnostics().bodies).toBeLessThan(beforeBodies);
    const ids = await publishedIds();
    expect(ids.has(req.entityId)).toBe(false);
    expect(ids.has(REMOVAL_SEED_OBJECTS.benchA.entityId)).toBe(true);
    expect(ids.has(REMOVAL_SEED_OBJECTS.benchB.entityId)).toBe(true);
    const row = (
      await fixture.pool.query(
        'SELECT enabled,instance_revision FROM world_static_instances WHERE entity_id=$1',
        [req.entityId],
      )
    ).rows[0];
    expect(row).toEqual({ enabled: false, instance_revision: 2 });
    const history = (
      await fixture.pool.query(
        "SELECT before_state,after_state FROM world_static_operations WHERE source='game'",
      )
    ).rows;
    expect(history).toHaveLength(1);
    expect(history[0].before_state.enabled).toBe(true);
    expect(history[0].after_state.enabled).toBe(false);
    await Promise.allSettled(rooms.splice(0).map((room) => room.leave()));
    await app.close();
    await start();
    const restored = await connect(cookie);
    restored.room.send('removeStatic', {
      ...req,
      worldEpoch: 'previous-server',
      expectedLayoutRevision: 1,
    });
    await until(() => restored.removals.length === 1);
    expect(restored.removals[0]).toEqual(player.removals[0]);
    expect((await publishedIds()).has(req.entityId)).toBe(false);
    expect(app.room.isReady()).toBe(true);
  }, 30000);

  it('lets another account remove a placed object and safely acknowledges its old creation after deletion', async () => {
    const creator = await connect(await login('creator'));
    const remover = await connect(await login('other-remover'));
    const placement: PlaceStaticRequest = {
      operationId: randomUUID(),
      worldEpoch: info.worldEpoch,
      assetReleaseVersion: info.assetReleaseVersion!,
      placementCatalogVersion: info.placementCatalog!.placementCatalogVersion,
      expectedLayoutRevision: info.layoutRevision!,
      assetId: STATIC_PLACEMENT_ASSET_ID,
      position: { x: 12, z: 12 },
      yawStep: 0,
    };
    creator.room.send('placeStatic', placement);
    await until(() => creator.placements.length === 1);
    expect(creator.placements[0].ok).toBe(true);
    await settle();
    const entityId = `placed_${placement.operationId}`;
    const removal = request(entityId);
    remover.room.send('removeStatic', removal);
    await until(() => remover.removals.length === 1);
    expect(remover.removals[0]).toMatchObject({ ok: true, entityId });
    await settle();
    creator.room.send('placeStatic', placement);
    await until(() => creator.placements.length === 2);
    expect(creator.placements[1]).toEqual(creator.placements[0]);
    expect((await publishedIds()).has(entityId)).toBe(false);
    expect(app.room.isReady()).toBe(true);
    remover.room.send('removeStatic', { ...removal, operationId: placement.operationId });
    await until(() => remover.removals.length === 2);
    expect(remover.removals[1]).toMatchObject({ ok: false, code: 'OPERATION_CONFLICT' });
    remover.room.send('removeStatic', {
      ...removal,
      entityId: REMOVAL_SEED_OBJECTS.benchA.entityId,
    });
    await until(() => remover.removals.length === 3);
    expect(remover.removals[2]).toMatchObject({ ok: false, code: 'OPERATION_CONFLICT' });
  }, 30000);

  it('rejects protected, unknown, malformed and stale requests without publishing changes', async () => {
    const player = await connect(await login('invalid-remover'));
    const initial = info.layoutRevision;
    for (const [override, code] of [
      [{ entityId: 'floor' }, 'OBJECT_PROTECTED'],
      [{ entityId: 'wall' }, 'OBJECT_PROTECTED'],
      [{ entityId: 'missing-instance' }, 'OBJECT_NOT_FOUND'],
      [{ worldEpoch: 'previous-epoch' }, 'STALE_WORLD'],
      [{ assetReleaseVersion: 'f'.repeat(64) }, 'VERSION_MISMATCH'],
      [{ expectedLayoutRevision: initial! + 1 }, 'LAYOUT_CHANGED'],
      [{ entityId: '../seed-house' }, 'INVALID_INPUT'],
      [{ enabled: false }, 'INVALID_INPUT'],
    ] as const) {
      const count = player.removals.length;
      player.room.send('removeStatic', { ...request(), ...override });
      await until(() => player.removals.length > count);
      expect(player.removals.at(-1)).toMatchObject({ ok: false, code });
      expect(app.room.state.paused).toBe(false);
    }
    expect((await refresh()).layoutRevision).toBe(initial);
    expect(
      (await fixture.pool.query("SELECT 1 FROM world_static_operations WHERE source='game'"))
        .rowCount,
    ).toBe(0);
  });

  it('serializes simultaneous deletion of the same instance without a second state change', async () => {
    const one = await connect(await login('simultaneous-one'));
    const two = await connect(await login('simultaneous-two'));
    const revision = info.layoutRevision!;
    one.room.send('removeStatic', request());
    two.room.send('removeStatic', request());
    await until(() => one.removals.length === 1 && two.removals.length === 1);
    await settle();
    const results = [one.removals[0], two.removals[0]];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const failure = results.find((result) => !result.ok)!;
    expect(failure.ok ? '' : failure.code).toMatch(
      /WORLD_NOT_READY|LAYOUT_CHANGED|ALREADY_REMOVED/,
    );
    expect(info.layoutRevision).toBe(revision + 1);
    const loser = one.removals[0].ok ? two : one;
    loser.room.send('removeStatic', request());
    await until(() => loser.removals.length === 2);
    expect(loser.removals[1]).toMatchObject({ ok: false, code: 'ALREADY_REMOVED' });
    expect(
      (await fixture.pool.query("SELECT 1 FROM world_static_operations WHERE source='game'"))
        .rowCount,
    ).toBe(1);
  });

  it('finishes a committed deletion when the commit acknowledgement was lost', async () => {
    const player = await connect(await login('uncertain-removal'));
    const original = StaticLayoutStore.prototype.removeGame;
    vi.spyOn(StaticLayoutStore.prototype, 'removeGame').mockImplementationOnce(async function (
      this: StaticLayoutStore,
      ...args
    ) {
      await original.apply(this, args);
      throw new Error('lost removal commit acknowledgement');
    });
    player.room.send('removeStatic', request());
    await until(() => player.removals.length === 1);
    await settle();
    expect(player.removals[0]).toMatchObject({ ok: true });
    expect((await publishedIds()).has(REMOVAL_SEED_OBJECTS.house.entityId)).toBe(false);
    expect(
      (await fixture.pool.query("SELECT 1 FROM world_static_operations WHERE source='game'"))
        .rowCount,
    ).toBe(1);
  }, 30000);

  it('keeps a committed collider failure paused and recovers the persisted deletion on restart', async () => {
    const cookie = await login('removal-physics-failure');
    const player = await connect(cookie);
    vi.spyOn(AuthoritativeWorld.prototype, 'removeStatic').mockImplementationOnce(() => {
      throw new Error('injected collider removal failure');
    });
    const req = request();
    player.room.send('removeStatic', req);
    await until(() => !app.room.isReady() && player.removals.length === 1);
    expect(app.room.state.paused).toBe(true);
    expect((await fetch(app.url + '/health/ready')).status).toBe(503);
    expect(
      (
        await fixture.pool.query('SELECT enabled FROM world_static_instances WHERE entity_id=$1', [
          req.entityId,
        ])
      ).rows[0].enabled,
    ).toBe(false);
    await Promise.allSettled(rooms.splice(0).map((room) => room.leave()));
    await app.close();
    await start();
    const restored = await connect(cookie);
    restored.room.send('removeStatic', req);
    await until(() => restored.removals.length === 1);
    expect(restored.removals[0]).toMatchObject({ ok: true, entityId: req.entityId });
    expect((await publishedIds()).has(req.entityId)).toBe(false);
    expect(app.room.isReady()).toBe(true);
  }, 30000);
});
