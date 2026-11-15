import { prepareSdk } from '../helpers/prepare.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { createGameServer } from '../helpers/game-server.js';
import type { WorldState } from '../../packages/protocol/src/index.js';
import ringBlock from '../../content/worlds/ring-block/bus-network/network.json';
import {
  busStopNear,
  busTripsFrom,
  RESPAWN_COOLDOWN_MS,
  selectBusNetwork,
  validateBusNetwork,
  type ActionResult,
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
// Центральная → Драмтеатр на 19-м: соседние остановки в центре мира.
const from = network.stops.find((s) => s.id === 'tsentralnaya')!;
const to = network.stops.find((s) => s.id === 'dramteatr')!;

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
  /** Ставит игрока на землю у остановки так же, как сервер ставит прибывших. */
  async function standAt(room: Room<WorldState>, stop: typeof from): Promise<void> {
    const player = room.state.players.get(room.sessionId)!;
    const center = internals().world.findGroundSpawn(
      stop.platforms.map(([x, z]) => ({ x, z })),
      player.entityId,
    )!;
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

  it('carries a player from the stop to the street beside the destination stop', async () => {
    expect(busTripsFrom(network, from.id).has(to.id)).toBe(true);
    const { room, results } = await join();
    await standAt(room, from);
    const player = room.state.players.get(room.sessionId)!;
    const revision = player.revision;
    room.send('requestBusTravel', {
      requestId: 1,
      worldEpoch: info.worldEpoch,
      fromStopId: from.id,
      toStopId: to.id,
    });
    await until(() => results.length === 1, 15_000);
    expect(results[0]).toMatchObject({ requestId: 1, ok: true });
    expect(results[0]!.retryAfterMs).toBeLessThanOrEqual(RESPAWN_COOLDOWN_MS);
    await until(() => player.revision > revision);
    expect(busStopNear(network, player, 8)?.stop.id).toBe(to.id);
  }, 60_000);

  it('refuses rides away from the stop, to unserved stops, too often, and malformed', async () => {
    const { room, results } = await join();
    const problems: string[] = [];
    room.onMessage('problem', ({ code }: { code: string }) => problems.push(code));
    const send = (requestId: number, fromStopId: string, toStopId: string, extra = {}) =>
      room.send('requestBusTravel', {
        requestId,
        worldEpoch: info.worldEpoch,
        fromStopId,
        toStopId,
        ...extra,
      });
    // Игрок на старте мира, далеко от «Центральной».
    send(1, from.id, to.id);
    await until(() => results.length === 1, 10_000);
    expect(results[0]).toMatchObject({ ok: false, code: 'NOT_AT_BUS_STOP' });

    await standAt(room, from);
    const unserved = network.stops.find(
      (s) => s.id !== from.id && !busTripsFrom(network, from.id).has(s.id),
    )!;
    send(2, from.id, unserved.id);
    await until(() => results.length === 2, 10_000);
    expect(results[1]).toMatchObject({ ok: false, code: 'NO_BUS_ROUTE' });

    send(3, from.id, to.id);
    await until(() => results.length === 3, 15_000);
    expect(results[2]!.ok).toBe(true);
    await standAt(room, from);
    send(4, from.id, to.id);
    await until(() => results.length === 4, 10_000);
    expect(results[3]).toMatchObject({ ok: false, code: 'RATE_LIMITED' });

    send(5, from.id, to.id, { extra: true });
    send(6, 'Центральная', to.id);
    await until(() => problems.filter((c) => c === 'INVALID_INPUT').length === 2);
    expect(results).toHaveLength(4);
  }, 90_000);
});
