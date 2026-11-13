import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from '@colyseus/sdk';
import { describe, expect, it } from 'vitest';
import {
  STATIC_PLACEMENT_ASSET_ID,
  type PlaceStaticRequest,
  type PlaceStaticResult,
  type RemoveStaticResult,
  type WorldInfo,
} from '../../packages/contracts/src/index.js';
import type { WorldState } from '../../packages/protocol/src/index.js';
import { createGameServer } from '../helpers/game-server.js';
import { createAccountFixture, loginAccount, responseCookie } from '../helpers/account-fixture.js';
import { buildTerrainPlacementWorld } from '../helpers/terrain-placement-world.js';
import { prepareSdk } from '../helpers/prepare.js';
import { terrainSupportId } from '../../apps/server/src/layout/release.js';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 750; i++) {
    if (await predicate()) return;
    await wait(20);
  }
  throw new Error('Terrain live operation timed out');
}
describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('terrain live placement and removal', () => {
  it('publishes server Y plus foundation/ramp, removes every body, replays and restarts without ghosts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'su-terrain-live-'));
    const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL!);
    const rooms: Room<WorldState>[] = [];
    let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
    try {
      const worldDirectory = await buildTerrainPlacementWorld(directory);
      const start = async () => {
        app = await createGameServer({ port: 0, accounts: fixture, worldDirectory });
        fixture.config.publicOrigin = app.url;
        return (await fetch(app.url + '/api/world').then((r) => r.json())) as WorldInfo;
      };
      let info = await start();
      const catalog = await fetch(app!.url + info.placementCatalog!.url).then((r) => r.json());
      expect(catalog.groundY).toBeNull();
      expect(catalog.terrain.groundEntityIds).toEqual(['placement-terrain']);
      expect(catalog.models[0].placement.kind).toBe('foundation');
      const cookie = responseCookie(
        (await loginAccount(app!.url, 'terrain-builder')).result,
        'su_session',
      );
      const connect = async () => {
        const room = await new Client(app!.url, {
          headers: { Cookie: cookie },
        }).joinById<WorldState>(info.roomId, { ...info, accountMode: 'account' });
        rooms.push(room);
        room.reconnection.enabled = false;
        const placements: PlaceStaticResult[] = [],
          removals: RemoveStaticResult[] = [];
        room.onMessage('staticPlacementResult', (r) => placements.push(r));
        room.onMessage('staticRemovalResult', (r) => removals.push(r));
        for (const message of ['problem', 'resync', 'inventory', 'layoutChanged', 'actionResult'])
          room.onMessage(message, () => {});
        prepareSdk(room);
        await until(() => room.state?.players?.has(room.sessionId));
        return { room, placements, removals };
      };
      const player = await connect();
      const bodies = app!.room.diagnostics().bodies;
      const request: PlaceStaticRequest = {
        operationId: randomUUID(),
        assetId: STATIC_PLACEMENT_ASSET_ID,
        placementCatalogVersion: info.placementCatalog!.placementCatalogVersion,
        worldEpoch: info.worldEpoch,
        assetReleaseVersion: info.assetReleaseVersion,
        expectedLayoutRevision: info.layoutRevision,
        position: { x: 10, z: 10 },
        yawStep: 0,
      };
      player.room.send('placeStatic', request);
      await until(() => player.placements.length === 1 && !app!.room.state.paused);
      expect(player.placements[0], JSON.stringify(player.placements[0])).toMatchObject({
        ok: true,
      });
      const entityId = `placed_${request.operationId}`;
      const stored = (
        await fixture.pool.query('SELECT * FROM world_static_instances WHERE entity_id=$1', [
          entityId,
        ])
      ).rows[0];
      expect(stored.position_y).toBeGreaterThan(0.8);
      expect(app!.room.diagnostics().bodies).toBe(bodies + 3);
      info = await fetch(app!.url + '/api/world').then((r) => r.json());
      const manifest = await fetch(app!.url + info.manifestUrl).then((r) => r.json());
      for (const role of ['foundation', 'approach:entry'])
        expect(
          manifest.assets[terrainSupportId('static-placement-lab', entityId, role)],
        ).toBeDefined();
      await wait(2100);
      const removal = {
        operationId: randomUUID(),
        worldEpoch: info.worldEpoch,
        assetReleaseVersion: info.assetReleaseVersion,
        expectedLayoutRevision: info.layoutRevision,
        entityId,
      };
      player.room.send('removeStatic', removal);
      await until(() => player.removals.length === 1 && !app!.room.state.paused);
      expect(player.removals[0], JSON.stringify(player.removals[0])).toMatchObject({ ok: true });
      expect(app!.room.diagnostics().bodies).toBe(bodies);
      player.room.send('placeStatic', request);
      player.room.send('removeStatic', removal);
      await until(() => player.placements.length === 2 && player.removals.length === 2);
      expect(player.placements[1]).toEqual(player.placements[0]);
      expect(player.removals[1]).toEqual(player.removals[0]);
      await Promise.all(rooms.splice(0).map((room) => room.leave()));
      await app!.close();
      info = await start();
      const restored = await connect();
      restored.room.send('placeStatic', request);
      restored.room.send('removeStatic', removal);
      await until(() => restored.placements.length === 1 && restored.removals.length === 1);
      expect(restored.placements[0]).toEqual(player.placements[0]);
      expect(restored.removals[0]).toEqual(player.removals[0]);
      expect(app!.room.diagnostics().bodies).toBe(bodies);
      const history = await fixture.pool.query(
        "SELECT * FROM world_static_operations WHERE source='game'",
      );
      expect(history.rows).toHaveLength(2);
    } finally {
      await Promise.allSettled(rooms.map((room) => room.leave()));
      await app?.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
