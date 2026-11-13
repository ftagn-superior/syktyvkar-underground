import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from '@colyseus/sdk';
import { expect, it, vi } from 'vitest';
import {
  placedStaticInstance,
  type PlacementCatalog,
  type ActionResult,
  type PlaceStaticRequest,
  type PlaceStaticResult,
  type WorldInfo,
  type WorldDefinition,
} from '../../packages/contracts/src/index.js';
import type { WorldState } from '../../packages/protocol/src/index.js';
import type { AuthoritativeWorld } from '../../packages/simulation/src/server.js';
import { StaticLayoutStore } from '../../apps/server/src/layout/store.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { createGameServer } from '../helpers/game-server.js';
import { createAccountFixture, loginAccount, responseCookie } from '../helpers/account-fixture.js';
import { prepareSdk } from '../helpers/prepare.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 20_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('City placement timed out');
    await wait(10);
  }
}

it.skipIf(!process.env.SU_TEST_DATABASE_URL)(
  'persists all 22 selected city assets beyond 2048 objects and replays after policy changes or disabling',
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'su-placement-city-'));
    const worldDirectory = join(temporary, 'world');
    const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL!);
    let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
    const rooms: Room<WorldState>[] = [];
    const rate = vi.spyOn(StaticLayoutStore.prototype, 'gameRateLimited').mockResolvedValue(false);
    try {
      await buildWorld('content/worlds/ring-block/world.json', worldDirectory);
      const start = async () => {
        app = await createGameServer({
          port: 0,
          accounts: fixture,
          worldDirectory,
          prepareTimeoutMs: 3000,
        });
        fixture.config.publicOrigin = app.url;
      };
      await start();
      const discover = (): Promise<WorldInfo> =>
        fetch(app!.url + '/api/world').then((response) => response.json());
      let info = await discover();
      const catalog: PlacementCatalog = await fetch(app!.url + info.placementCatalog!.url).then(
        (response) => response.json(),
      );
      expect(catalog.models).toHaveLength(22);
      expect(Object.keys(catalog.categories)).toHaveLength(4);
      const initialCount = (
        await fixture.pool.query('SELECT count(*)::int AS n FROM world_static_instances')
      ).rows[0].n;
      expect(initialCount).toBeGreaterThan(2048);
      const cookie = responseCookie(
        (await loginAccount(app!.url, 'city-builder')).result,
        'su_session',
      );
      const connect = async (authCookie?: string) => {
        const room = await new Client(
          app!.url,
          authCookie ? { headers: { Cookie: authCookie } } : {},
        ).joinById<WorldState>(info.roomId, {
          ...info,
          accountMode: authCookie ? 'account' : 'guest',
        });
        rooms.push(room);
        room.reconnection.enabled = false;
        const results: PlaceStaticResult[] = [];
        room.onMessage('staticPlacementResult', (result) => results.push(result));
        for (const name of ['problem', 'resync', 'inventory', 'layoutChanged'])
          room.onMessage(name, () => {});
        const preparation = prepareSdk(room);
        await until(() => room.state?.players?.has(room.sessionId));
        expect(room.state.layoutRevision).toBe(info.layoutRevision);
        return { room, results, preparation };
      };
      let owner = await connect(cookie);
      const observer = await connect();
      const requests: PlaceStaticRequest[] = [];
      let cursor = 0;
      for (const model of catalog.models) {
        info = await discover();
        const world = (app!.room as unknown as { world: AuthoritativeWorld }).world;
        const definition = (app!.room as unknown as { definition: WorldDefinition }).definition;
        let request: PlaceStaticRequest | undefined;
        for (let attempt = 0; attempt < 6000; attempt++, cursor++) {
          const position = { x: -249 + (cursor % 70) * 8, z: -725 + Math.floor(cursor / 70) * 8 };
          const candidate: PlaceStaticRequest = {
            operationId: randomUUID(),
            worldEpoch: info.worldEpoch,
            assetReleaseVersion: info.assetReleaseVersion!,
            placementCatalogVersion: info.placementCatalog!.placementCatalogVersion,
            expectedLayoutRevision: info.layoutRevision!,
            assetId: model.assetId,
            position,
            yawStep: cursor % 24,
          };
          if (
            !world.checkStaticPlacement(
              placedStaticInstance(candidate),
              definition.buildingAssets[model.assetId],
            )
          ) {
            request = candidate;
            cursor++;
            break;
          }
        }
        expect(request, `free position for ${model.assetId}`).toBeDefined();
        owner.room.send('placeStatic', request!);
        const n = requests.length;
        await until(() => owner.results.length > n && !app!.room.state.paused);
        expect(owner.results[n], model.assetId).toMatchObject({
          ok: true,
          entityId: `placed_${request!.operationId}`,
        });
        requests.push(request!);
        const row = (
          await fixture.pool.query(
            'SELECT asset_id FROM world_static_instances WHERE entity_id=$1',
            [`placed_${request!.operationId}`],
          )
        ).rows[0];
        expect(row.asset_id).toBe(model.assetId);
        expect((await discover()).placementCatalog).toEqual(info.placementCatalog);
        await until(() => !app!.room.diagnostics().staticPlacementBusy);
      }
      expect(observer.preparation.changes).toHaveLength(22);
      expect(observer.preparation.changes.every((change) => change.changedCellIds.length > 0)).toBe(
        true,
      );
      expect(
        (
          await fixture.pool.query(
            "SELECT count(*)::int AS n FROM world_static_operations WHERE source='game'",
          )
        ).rows[0].n,
      ).toBe(22);
      const original = requests[0];
      owner.room.send('placeStatic', { ...original, assetId: requests[1].assetId });
      await until(() => owner.results.length === 23);
      expect(owner.results[22]).toMatchObject({ code: 'OPERATION_CONFLICT' });
      await Promise.all(rooms.splice(0).map((room) => room.leave()));
      await app!.close();
      app = undefined;
      const policyPath = join(worldDirectory, 'model-catalog/placement-policy.json');
      const policy = JSON.parse(await readFile(policyPath, 'utf8'));
      policy.assetIds = policy.assetIds.filter((assetId: string) => assetId !== original.assetId);
      await writeFile(policyPath, JSON.stringify(policy));
      await start();
      info = await discover();
      owner = await connect(cookie);
      expect(info.placementCatalog!.placementCatalogVersion).not.toBe(
        original.placementCatalogVersion,
      );
      owner.room.send('placeStatic', { ...original, placementCatalogVersion: '0'.repeat(64) });
      await until(() => owner.results.length === 1);
      expect(owner.results[0]).toMatchObject({
        ok: true,
        entityId: `placed_${original.operationId}`,
      });
      owner.room.send('placeStatic', {
        ...original,
        operationId: randomUUID(),
        worldEpoch: info.worldEpoch,
        expectedLayoutRevision: info.layoutRevision,
        placementCatalogVersion: info.placementCatalog!.placementCatalogVersion,
      });
      await until(() => owner.results.length === 2);
      expect(owner.results[1]).toMatchObject({ code: 'ASSET_NOT_ALLOWED' });
      owner.room.send('placeStatic', {
        ...original,
        operationId: randomUUID(),
        placementCatalogVersion: '0'.repeat(64),
      });
      await until(() => owner.results.length === 3);
      expect(owner.results[2]).toMatchObject({ code: 'CATALOG_CHANGED' });
      const otherCookie = responseCookie(
        (await loginAccount(app!.url, 'other-builder')).result,
        'su_session',
      );
      const other = await connect(otherCookie);
      other.room.send('placeStatic', { ...original, placementCatalogVersion: '0'.repeat(64) });
      await until(() => other.results.length === 1);
      expect(other.results[0]).toMatchObject({ code: 'OPERATION_CONFLICT' });
      await Promise.all(rooms.splice(0).map((room) => room.leave()));
      await app!.close();
      app = undefined;
      // A no-policy build disables new placement, while successful durable operations remain replayable.
      const indexPath = join(worldDirectory, 'model-catalog/index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      delete index.placementPolicy;
      await writeFile(indexPath, JSON.stringify(index));
      await rm(policyPath);
      await start();
      info = await discover();
      expect(info.placementCatalog).toBeUndefined();
      expect(
        (
          await fetch(
            app!.url +
              `/worlds/ring-block/placement-catalogs/${original.placementCatalogVersion}.json`,
          )
        ).status,
      ).toBe(404);
      owner = await connect(cookie);
      const actions: ActionResult[] = [];
      owner.room.onMessage('actionResult', (result) => actions.push(result));
      owner.room.send('requestChat', {
        requestId: 1,
        worldEpoch: info.worldEpoch,
        text: '/motherlode',
      });
      await until(() => actions.length === 1);
      expect(actions[0]).toMatchObject({ ok: false, code: 'COMMAND_DISABLED' });
      owner.room.send('placeStatic', original);
      await until(() => owner.results.length === 1);
      expect(owner.results[0]).toMatchObject({
        ok: true,
        entityId: `placed_${original.operationId}`,
      });
      owner.room.send('placeStatic', { ...original, placementCatalogVersion: '0'.repeat(64) });
      await until(() => owner.results.length === 2);
      expect(owner.results[1]).toEqual(owner.results[0]);
      owner.room.send('placeStatic', { ...original, operationId: randomUUID() });
      await until(() => owner.results.length === 3);
      expect(owner.results[2]).toMatchObject({ code: 'COMMAND_DISABLED' });
      owner.room.send('placeStatic', {
        ...original,
        operationId: randomUUID(),
        placementCatalogVersion: '0'.repeat(64),
      });
      await until(() => owner.results.length === 4);
      expect(owner.results[3]).toMatchObject({ code: 'CATALOG_CHANGED' });
      expect(
        (await fixture.pool.query('SELECT count(*)::int AS n FROM world_static_instances')).rows[0]
          .n,
      ).toBe(initialCount + 22);
    } finally {
      rate.mockRestore();
      await Promise.allSettled(rooms.map((room) => room.leave()));
      await app?.close();
      await fixture.close();
      await rm(temporary, { recursive: true, force: true });
    }
  },
  180_000,
);
