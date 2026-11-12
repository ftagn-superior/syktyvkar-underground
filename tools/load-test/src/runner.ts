import { Client, Protocol, type Room, type InputHandle } from '@colyseus/sdk';
import { MoveInputSchema, WorldState } from '@su/protocol';
import {
  loadWorldHeader,
  validateWorldManifest,
  worldCellAt,
  type PrepareArea,
  type WorldInfo,
} from '@su/contracts';
import { createHash } from 'node:crypto';
import { spreadRoute, crowdTarget, direction, expectedInterest, type Point } from './routes.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Publication = { tick: number; entities: { entityId: string; x: number; z: number }[] };
type Observation = { tick: number; own: string; ids: string[] };
type Peer = {
  room: Room<WorldState>;
  input: InputHandle<MoveInputSchema>;
  route: Point[];
  target: number;
  sent: number;
  stateBytes: number;
  allBytes: number;
  pendingPeak: number;
  backpressureTicks: number;
  distance: number;
  last?: Point;
  cells: Set<string>;
  visibleMin: number;
  visibleMax: number;
  interestChecks: number;
  interestSkipped: number;
  previous: Set<string>;
  snapshots: Observation[];
  preparationMs: number;
};
export type LoadOptions = {
  url: string;
  clients: number;
  scenario: 'spread' | 'crowd';
  diagnosticsUrl?: string;
};
export async function startLoad(options: LoadOptions) {
  const { url, clients, scenario } = options;
  if (!Number.isInteger(clients) || clients < 1 || clients > 8)
    throw new Error('clients must be 1..8');
  const info = (await (await fetch(url + '/api/world')).json()) as WorldInfo;
  const manifestUrl = new URL(info.manifestUrl, url);
  const manifest = validateWorldManifest(await (await fetch(manifestUrl)).json());
  const header = await loadWorldHeader(manifest, async (path, expected) => {
    const response = await fetch(new URL(path, manifestUrl));
    if (!response.ok) throw new Error(`Resource HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new Error('Resource SHA-256 mismatch');
    return bytes;
  });
  const rooms: Room<WorldState>[] = [];
  const errors: string[] = [];
  const peers: Peer[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let started = 0;
  const samples: unknown[] = [];
  const recordError = (message: string) => {
    if (errors.length < 40) errors.push(message);
  };
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await Promise.allSettled(rooms.map((room) => room.leave()));
  }
  try {
    for (let index = 0; index < clients; index++) {
      const joinedAt = performance.now();
      const room = await new Client(url).joinById<WorldState>(info.roomId, info, WorldState);
      rooms.push(room);
      room.reconnection.enabled = false;
      room.onLeave((code) => {
        if (!stopped) recordError(`${index}: unexpected leave ${code}`);
      });
      room.onError((code, message) => recordError(`${index}: ${code} ${message}`));
      room.onMessage('problem', (data) => recordError(`${index}: ${JSON.stringify(data)}`));
      room.onMessage('actionResult', () => {});
      room.onMessage('resync', () => {});
      room.onMessage('areaResult', () => {});
      room.onMessage('inventory', () => {});
      room.onMessage<PrepareArea>('prepareArea', (plan) =>
        room.send('areaReady', {
          prepareId: plan.prepareId,
          layoutRevision: plan.layoutRevision,
          worldEpoch: plan.worldEpoch,
          mapVersion: plan.mapVersion,
        }),
      );
      room.send('requestArea');
      const deadline = performance.now() + 16000;
      while (!room.state?.players?.has(room.sessionId)) {
        if (performance.now() > deadline) throw new Error(`Client ${index} preparation timed out`);
        await sleep(20);
      }
      const player = room.state.players.get(room.sessionId)!;
      const peer: Peer = {
        room,
        input: room.input<MoveInputSchema>({ type: MoveInputSchema, mode: 'reliable' }),
        route: scenario === 'spread' ? spreadRoute(header, player) : [],
        target: 0,
        sent: 0,
        stateBytes: 0,
        allBytes: 0,
        pendingPeak: 0,
        backpressureTicks: 0,
        distance: 0,
        cells: new Set(),
        visibleMin: Infinity,
        visibleMax: 0,
        interestChecks: 0,
        interestSkipped: 0,
        previous: new Set(),
        snapshots: [],
        preparationMs: performance.now() - joinedAt,
      };
      peers.push(peer);
      const original = room.connection.events.onmessage;
      room.connection.events.onmessage = (event) => {
        const bytes = new Uint8Array(event.data);
        if (started) {
          peer.allBytes += bytes.byteLength;
          if (
            (bytes[0] & 31) === Protocol.ROOM_STATE ||
            (bytes[0] & 31) === Protocol.ROOM_STATE_PATCH
          )
            peer.stateBytes += bytes.byteLength;
        }
        return original?.(event);
      };
      room.onStateChange(() => {
        const own = room.state.players?.get(room.sessionId);
        if (!own || !started) return;
        if (peer.last) peer.distance += Math.hypot(own.x - peer.last.x, own.z - peer.last.z);
        peer.last = { x: own.x, z: own.z };
        const cell = worldCellAt(header.bounds, manifest.grid, own);
        if (cell) peer.cells.add(cell);
        else recordError(`${index}: out of world`);
        if (own.y < 0.8) recordError(`${index}: fell through ground`);
        peer.visibleMin = Math.min(peer.visibleMin, room.state.players.size);
        peer.visibleMax = Math.max(peer.visibleMax, room.state.players.size);
        peer.snapshots.push({
          tick: room.state.serverTick,
          own: own.entityId,
          ids: [...room.state.players.values()]
            .map((entity) => entity.entityId)
            .concat([...room.state.items.values()].map((item) => item.entityId)),
        });
        if (peer.snapshots.length > 200) {
          peer.snapshots.shift();
          peer.interestSkipped++;
        }
      });
    }
    started = performance.now();
    let nextAt = started;
    timer = setInterval(() => {
      const now = performance.now();
      if (now < nextAt || stopped) return;
      nextAt += 1000 / 60;
      if (now - nextAt > 100) nextAt = now + 1000 / 60;
      for (const [index, peer] of peers.entries()) {
        const self = peer.room.state.players?.get(peer.room.sessionId);
        if (!self) {
          recordError(`${index}: missing own actor`);
          continue;
        }
        let target;
        if (scenario === 'spread') {
          target = peer.route[peer.target];
          if (Math.hypot(target.x - self.x, target.z - self.z) < 0.35) {
            peer.target = (peer.target + 1) % peer.route.length;
            target = peer.route[peer.target];
          }
        } else
          target = crowdTarget(
            [...peer.room.state.items.values()].find((item) => item.typeId === 'wooden-crate') ??
              header.initialItems[0]?.position ??
              header.spawnPoints[0],
            index,
            (now - started) / 1000,
          );
        Object.assign(peer.input.data, direction(self, target));
        peer.pendingPeak = Math.max(peer.pendingPeak, peer.input.pendingCount);
        if (peer.input.pendingCount >= 32) {
          peer.backpressureTicks++;
          continue;
        }
        peer.input.send();
        peer.sent++;
      }
    }, 4);
    async function sample() {
      const diagnostics = await (
        await fetch((options.diagnosticsUrl ?? url) + '/api/diagnostics')
      ).json();
      const truth = new Map<number, Publication['entities']>(
        (diagnostics.testPublications ?? []).map((publication: Publication) => [
          publication.tick,
          publication.entities,
        ]),
      );
      for (const [index, peer] of peers.entries()) {
        const waiting: Observation[] = [];
        for (const snapshot of peer.snapshots) {
          const entities = truth.get(snapshot.tick);
          if (!entities) {
            waiting.push(snapshot);
            continue;
          }
          const expected = expectedInterest(entities, snapshot.own, peer.previous);
          const observed = new Set(snapshot.ids);
          if (expected.size !== observed.size || [...expected].some((id) => !observed.has(id)))
            recordError(`${index}: AOI mismatch at tick ${snapshot.tick}`);
          peer.previous = observed;
          peer.interestChecks++;
        }
        peer.snapshots = waiting;
      }
      const { testPublications: _test, ...metrics } = diagnostics;
      const value = {
        elapsed: (performance.now() - started) / 1000,
        server: metrics,
        clients: peers.map((peer) => ({
          sent: peer.sent,
          backpressureTicks: peer.backpressureTicks,
          ack: peer.input.lastProcessed,
          pending: peer.input.pendingCount,
          stateBytes: peer.stateBytes,
          allBytes: peer.allBytes,
          cells: [...peer.cells],
          distance: peer.distance,
          visible: peer.room.state.players.size,
          occupancy: peer.room.state.occupancy,
        })),
      };
      samples.push(value);
      if (samples.length > 2200) samples.shift();
      return value;
    }
    return {
      info,
      manifest,
      header,
      rooms,
      sample,
      stop,
      report() {
        const elapsed = (performance.now() - started) / 1000;
        return {
          capturedAt: new Date().toISOString(),
          durationSeconds: elapsed,
          clients,
          scenario,
          worldId: manifest.worldId,
          versions: {
            protocol: info.protocolVersion,
            format: manifest.formatVersion,
            map: info.mapVersion,
            simulation: info.simulationConfigHash,
          },
          errors,
          result: errors.length ? 'failed' : 'passed',
          peers: peers.map((peer) => ({
            sessionId: peer.room.sessionId,
            sent: peer.sent,
            inputHz: peer.sent / elapsed,
            scheduledHz: (peer.sent + peer.backpressureTicks) / elapsed,
            lastAck: peer.input.lastProcessed,
            pendingPeak: peer.pendingPeak,
            backpressureTicks: peer.backpressureTicks,
            distance: peer.distance,
            cells: [...peer.cells],
            visibleMin: peer.visibleMin,
            visibleMax: peer.visibleMax,
            stateBytes: peer.stateBytes,
            allBytes: peer.allBytes,
            stateKiBPerSecond: peer.stateBytes / 1024 / elapsed,
            interestChecks: peer.interestChecks,
            interestSkipped: peer.interestSkipped,
            preparationMs: peer.preparationMs,
          })),
          samples,
          byteDefinition:
            'WebSocket application payload; state opcodes 14/15 including timed ACK prefix; excludes WS/TCP framing and HTTP. SDK preparation does not prove browser resource readiness.',
        };
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
