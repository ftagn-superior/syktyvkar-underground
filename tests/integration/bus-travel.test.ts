import { prepareSdk } from '../helpers/prepare.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { createGameServer } from '../helpers/game-server.js';
import type { WorldState } from '../../packages/protocol/src/index.js';
import ringBlock from '../../content/worlds/ring-block/bus-network/network.json';
import {
  busPlatformNear,
  busTripsFrom,
  RESPAWN_COOLDOWN_MS,
  selectBusNetwork,
  validateBusNetwork,
  type ActionResult,
  type BusPlatform,
  type Vec3,
  type WorldInfo,
} from '../../packages/contracts/src/index.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeout) throw new Error('Timed out waiting for state');
    await sleep(15);
  }
}
// Сеть передаётся серверу напрямую: собранный выпуск может быть старше этой ветки.
const network = selectBusNetwork(validateBusNetwork(ringBlock)!);
// Центральная → Драмтеатр на 19-м: прямая поездка между соседними остановками в центре мира.
const fromStop = network.stops.find((s) => s.id === 'tsentralnaya')!;
const fromPlatform = fromStop.platforms[0]!;
const sampleTrip = busTripsFrom(network, fromPlatform.id).get('dramteatr')![0]!;
const sguSouth = network.stops
  .find((s) => s.id === 'sgu')!
  .platforms.find((p) => p.id === 'osm-2165055372')!;

describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('bus travel in ring-block', () => {
  let app: Awaited<ReturnType<typeof createGameServer>>;
  let info: WorldInfo;
  let sdk: Client;
  const rooms = new Set<Room<WorldState>>();
  type Internals = {
    world: {
      findGroundSpawn(points: { x: number; z: number }[], id?: string): Vec3 | undefined;
      respawnPlayerAtPosition(id: string, center: Vec3): boolean;
    };
  };
  const internals = () => app.room as unknown as Internals;

  async function join(): Promise<{ room: Room<WorldState>; results: ActionResult[] }> {
    const room = await sdk.joinById<WorldState>(info.roomId, {
      protocolVersion: info.protocolVersion,
      catalogVersions: info.catalogVersions,
      mapVersion: info.mapVersion,
      simulationConfigHash: info.simulationConfigHash,
    });
    room.reconnection.enabled = false;
    const results: ActionResult[] = [];
    room.onMessage('problem', () => {});
    room.onMessage('resync', () => {});
    room.onMessage('actionResult', (result: ActionResult) => results.push(result));
    rooms.add(room);
    prepareSdk(room);
    await until(() => !!room.state?.players?.has(room.sessionId), 20_000);
    return { room, results };
  }
  /** Ставит игрока на землю у платформы так же, как сервер ставит прибывших. */
  async function standAt(room: Room<WorldState>, platform: BusPlatform): Promise<void> {
    const player = room.state.players.get(room.sessionId)!;
    const [x, z] = platform.position;
    const center = internals().world.findGroundSpawn([{ x, z }], player.entityId)!;
    expect(internals().world.respawnPlayerAtPosition(player.entityId, center)).toBe(true);
    await until(() => Math.hypot(player.x - center.x, player.z - center.z) < 0.5);
  }

  beforeAll(async () => {
    app = await createGameServer({
      port: 0,
      worldDirectory: 'dist/worlds/ring-block',
      prepareTimeoutMs: 10_000,
      busNetwork: network,
    });
    info = (await (await fetch(app.url + '/api/world')).json()) as WorldInfo;
    sdk = new Client(app.url);
  }, 180_000);
  afterEach(async () => {
    await Promise.all([...rooms].map((room) => room.leave().catch(() => undefined)));
    rooms.clear();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('serves bus discovery and map alongside the versioned reaction catalog', async () => {
    const buses = await fetch(`${app.url}/api/bus-network`);
    expect(buses.status).toBe(200);
    expect(await buses.json()).toEqual(network);
    const map = await fetch(`${app.url}/api/bus-map`);
    expect(map.status).toBe(200);
    expect(map.headers.get('content-type')).toContain('application/json');
    await map.arrayBuffer();
    const sticker = await fetch(
      `${app.url}/reactions/hello.svg?v=${info.catalogVersions.reactions}`,
    );
    expect(sticker.status).toBe(200);
    expect(sticker.headers.get('content-type')).toContain('image/svg+xml');
    expect(await sticker.text()).toContain('viewBox="0 0 64 64"');
  });

  it('carries a player from the boarding platform to the exact destination platform side', async () => {
    const { room, results } = await join();
    await standAt(room, fromPlatform);
    const player = room.state.players.get(room.sessionId)!;
    const revision = player.revision;
    room.send('requestBusTravel', {
      requestId: 1,
      worldEpoch: info.worldEpoch,
      fromPlatformId: fromPlatform.id,
      toPlatformId: sampleTrip.toPlatformId,
      routeId: sampleTrip.routeId,
      directionIndex: sampleTrip.directionIndex,
    });
    await until(() => results.length === 1, 15_000);
    expect(results[0]).toMatchObject({ requestId: 1, ok: true });
    expect(results[0]!.retryAfterMs).toBeLessThanOrEqual(RESPAWN_COOLDOWN_MS);
    await until(() => player.revision > revision);
    expect(busPlatformNear(network, player, 8)?.platform.id).toBe(sampleTrip.toPlatformId);
  }, 60_000);

  it('finds street-level arrival space within three metres of every live platform', () => {
    for (const stop of network.stops) {
      for (const platform of stop.platforms) {
        const [x, z] = platform.position;
        const center = internals().world.findGroundSpawn([{ x, z }]);
        expect(center, `${stop.id}:${platform.id}`).toBeDefined();
        expect(Math.hypot(center!.x - x, center!.z - z), platform.id).toBeLessThanOrEqual(3.01);
      }
    }
  });

  it('serves both SGU road sides and circular directions with exact destination platforms', async () => {
    for (const [fromPlatformId, toStopId, routeId, directionIndex] of [
      ['osm-2165055372', 'poliklinika-3', '17m', 1],
      ['osm-1391361123', 'banya-4', '17m', 0],
      ['osm-2163755548', 'shkola-35', '19', 0],
      ['osm-2163704708', 'zhd-vokzal-syktyvkar', '19', 1],
    ] as const) {
      const { room, results } = await join();
      const from = network.stops.flatMap((s) => s.platforms).find((p) => p.id === fromPlatformId)!;
      const trip = busTripsFrom(network, fromPlatformId)
        .get(toStopId)!
        .find((t) => t.routeId === routeId && t.directionIndex === directionIndex)!;
      expect(trip).toBeDefined();
      await standAt(room, from);
      const player = room.state.players.get(room.sessionId)!;
      const revision = player.revision;
      room.send('requestBusTravel', {
        requestId: 1,
        worldEpoch: info.worldEpoch,
        fromPlatformId,
        toPlatformId: trip.toPlatformId,
        routeId,
        directionIndex,
      });
      await until(() => results.length === 1, 15_000);
      expect(results[0], `${fromPlatformId} -> ${toStopId}`).toMatchObject({ ok: true });
      await until(() => player.revision > revision);
      expect(busPlatformNear(network, player, 4)?.platform.id).toBe(trip.toPlatformId);
      await room.leave();
      rooms.delete(room);
    }
  }, 120_000);

  it('rejects forged boarding sides, route ids, directions, and destination platforms', async () => {
    const { room, results } = await join();
    await standAt(room, sguSouth);
    const valid = busTripsFrom(network, sguSouth.id)
      .get('poliklinika-3')!
      .find((t) => t.routeId === '17m')!;
    const cases = [
      { fromPlatformId: 'osm-1391361123', code: 'NOT_AT_BUS_STOP' },
      { routeId: 'missing-route', code: 'NO_BUS_ROUTE' },
      { directionIndex: 0, code: 'NO_BUS_ROUTE' },
      { directionIndex: 999, code: 'NO_BUS_ROUTE' },
      { toPlatformId: 'osm-6533272752', code: 'NO_BUS_ROUTE' },
      { toPlatformId: 'missing-platform', code: 'NO_BUS_ROUTE' },
    ];
    for (const [index, { code, ...override }] of cases.entries()) {
      room.send('requestBusTravel', {
        requestId: index + 1,
        worldEpoch: info.worldEpoch,
        fromPlatformId: sguSouth.id,
        routeId: valid.routeId,
        directionIndex: valid.directionIndex,
        toPlatformId: valid.toPlatformId,
        ...override,
      });
      await until(() => results.length === index + 1);
      expect(results[index]).toMatchObject({ ok: false, code });
    }
  }, 60_000);

  it('refuses rides away from platform, wrong direction/platform, too often, and malformed', async () => {
    const { room, results } = await join();
    const problems: string[] = [];
    room.onMessage('problem', ({ code }: { code: string }) => problems.push(code));
    const send = (
      requestId: number,
      fromPlatformId: string,
      toPlatformId: string,
      routeId = sampleTrip.routeId,
      directionIndex = sampleTrip.directionIndex,
      extra = {},
    ) =>
      room.send('requestBusTravel', {
        requestId,
        worldEpoch: info.worldEpoch,
        fromPlatformId,
        toPlatformId,
        routeId,
        directionIndex,
        ...extra,
      });
    // Игрок на старте мира, далеко от «Центральной».
    send(1, fromPlatform.id, sampleTrip.toPlatformId);
    await until(() => results.length === 1, 10_000);
    expect(results[0]).toMatchObject({ ok: false, code: 'NOT_AT_BUS_STOP' });

    // С южной платформы СГУ в сторону Бани №4 без перехода на встречную сторону ехать нельзя.
    await standAt(room, sguSouth);
    const wrongPlat = network.stops.find((s) => s.id === 'banya-4')!.platforms[0]!;
    send(2, sguSouth.id, wrongPlat.id, '17m', 1);
    await until(() => results.length === 2, 10_000);
    expect(results[1]).toMatchObject({ ok: false, code: 'NO_BUS_ROUTE' });

    await standAt(room, fromPlatform);
    send(3, fromPlatform.id, sampleTrip.toPlatformId);
    await until(() => results.length === 3, 15_000);
    expect(results[2]!.ok).toBe(true);
    await standAt(room, fromPlatform);
    send(4, fromPlatform.id, sampleTrip.toPlatformId);
    await until(() => results.length === 4, 10_000);
    expect(results[3]).toMatchObject({ ok: false, code: 'RATE_LIMITED' });

    send(
      5,
      fromPlatform.id,
      sampleTrip.toPlatformId,
      sampleTrip.routeId,
      sampleTrip.directionIndex,
      {
        extra: true,
      },
    );
    send(6, 'Центральная', sampleTrip.toPlatformId);
    await until(() => problems.filter((c) => c === 'INVALID_INPUT').length === 2);
    expect(results).toHaveLength(4);
  }, 90_000);
});
