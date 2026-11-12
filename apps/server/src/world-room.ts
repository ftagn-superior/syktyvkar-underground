import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DurationMetric } from './metrics.js';
import { CloseCode, Room, ServerError, type Client, type StepContext } from '@colyseus/core';
import {
  MAX_PLAYERS,
  MAX_INPUT_QUEUE,
  PATCH_RATE,
  PLAYER_COLORS,
  PREPARE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RECONNECT_SECONDS,
  RESPAWN_COOLDOWN_MS,
  TICK_RATE,
  NEUTRAL_INPUT,
  normalizeInput,
  worldNeighborhood,
  type PrepareArea,
  type AreaResult,
  type Vec3,
  type ActionResult,
  type ErrorCode,
  type WorldDefinition,
  type WorldManifest,
} from '@su/contracts';
import { DynamicInterest } from './interest.js';
import {
  MoveInputSchema,
  EntitySchema,
  PlayerSchema,
  WorldState,
  applyEntityState,
} from '@su/protocol';
import { createAuthoritativeWorld } from '@su/simulation/server';

type PhysicsWorld = Awaited<ReturnType<typeof createAuthoritativeWorld>>;
type Plan = { message: PrepareArea; deadline: number; readyAt?: number };
interface Session {
  entityId: string;
  plan?: Plan;
  areaResults: Map<string, AreaResult>;
  connected: boolean;
  name: string;
  color: string;
  lastRequest: number;
  lastRespawn: number;
  results: Map<number, ActionResult>;
}
export interface WorldRoomOptions {
  definition: WorldDefinition;
  manifest: WorldManifest;
  reconnectSeconds?: number;
  prepareTimeoutMs?: number;
  testDiagnostics?: boolean;
}

/** Connection lifecycle and replication only; simulation owns all physical state. */
export class WorldRoom extends Room<{ state: WorldState; input: MoveInputSchema }> {
  state = new WorldState();
  maxClients = MAX_PLAYERS;
  autoDispose = false;
  maxMessagesPerSecond = 180;
  inputs = this.defineInput(MoveInputSchema, {
    bufferMaxSize: MAX_INPUT_QUEUE,
    sanitize(input) {
      // Keep valid raw axes intact: the delta decoder retains them between
      // packets. Cross-axis normalization belongs to the copied command below.
      if (!Number.isFinite(input.moveX) || Math.abs(input.moveX) > 100) input.moveX = 0;
      if (!Number.isFinite(input.moveZ) || Math.abs(input.moveZ) > 100) input.moveZ = 0;
    },
  });
  private world!: PhysicsWorld;
  private interest!: DynamicInterest;
  private crate!: EntitySchema;
  private manifest!: WorldManifest;
  private definition!: WorldDefinition;
  private sessions = new Map<string, Session>();
  private guestCounter = 0;
  private reconnectSeconds = RECONNECT_SECONDS;
  private prepareTimeoutMs = PREPARE_TIMEOUT_MS;
  private stepSamples: number[] = [];
  private disposed = false;
  private readonly stepHistogram = new Uint32Array(1001);
  private measuredSteps = 0;
  private maxStepMs = 0;
  private resyncs = 0;
  private readonly physicsTime = new DurationMetric();
  private readonly selectionTime = new DurationMetric();
  private readonly publicationTime = new DurationMetric();
  private readonly cycleTime = new DurationMetric();
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 10 });
  private pendingCycleMs: number | undefined;
  private testDiagnostics = false;
  private readonly publications: {
    tick: number;
    entities: { entityId: string; x: number; z: number }[];
  }[] = [];

  async onCreate(options: WorldRoomOptions): Promise<void> {
    this.manifest = options.manifest;
    this.testDiagnostics = options.testDiagnostics ?? false;
    this.loopDelay.enable();
    this.definition = options.definition;
    this.interest = new DynamicInterest(options.manifest.grid);
    this.reconnectSeconds = options.reconnectSeconds ?? RECONNECT_SECONDS;
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
    this.state.worldEpoch = randomUUID();
    this.state.protocolVersion = PROTOCOL_VERSION;
    this.state.mapVersion = options.manifest.mapVersion;
    this.state.simulationConfigHash = options.manifest.simulationConfigHash;
    this.seatReservationTimeout = 10;
    this.setPatchRate(1000 / PATCH_RATE);
    await this.setPrivate(true);
    this.world = await createAuthoritativeWorld(options.definition);
    this.crate = new EntitySchema();
    applyEntityState(this.crate, this.world.getSnapshot().crate);
    this.state.crates.set(this.crate.entityId, this.crate);
    this.interest.upsert(this.crate);
    this.onMessage('requestArea', (client) => this.sendPlan(client));
    this.onMessage('areaReady', (client, data: unknown) => this.areaReady(client, data));
    this.onMessage('requestRespawn', (client, request: unknown) => this.respawn(client, request));
    this.onMessage('resync', (client) => {
      this.inputs.get(client.sessionId).clear();
      const session = this.sessions.get(client.sessionId);
      if (session) this.world.setInput(session.entityId, NEUTRAL_INPUT);
      client.send('resync', { serverTick: this.state.serverTick });
    });
    this.setFixedTimestep((context) => this.step(context), TICK_RATE);
  }

  onAuth(_client: Client, options: Record<string, unknown>): boolean {
    if (
      !options ||
      options.protocolVersion !== PROTOCOL_VERSION ||
      options.mapVersion !== this.state.mapVersion ||
      options.simulationConfigHash !== this.state.simulationConfigHash
    ) {
      throw new ServerError(4001, 'VERSION_MISMATCH');
    }
    return true;
  }

  onJoin(client: Client): void {
    const ordinal = ++this.guestCounter;
    const usedColors = new Set([...this.sessions.values()].map((s) => s.color));
    this.sessions.set(client.sessionId, {
      entityId: `player-${randomUUID()}`,
      connected: true,
      name: `Гость ${ordinal}`,
      color:
        PLAYER_COLORS.find((c) => !usedColors.has(c)) ??
        PLAYER_COLORS[ordinal % PLAYER_COLORS.length],
      lastRequest: 0,
      lastRespawn: -Infinity,
      results: new Map(),
      areaResults: new Map(),
    });
    this.state.occupancy = this.sessions.size;
    this.interest.reset(client, this.sessions.get(client.sessionId)!.entityId);
    this.createPlan(
      client,
      this.sessions.get(client.sessionId)!,
      'spawn',
      performance.now() + this.prepareTimeoutMs,
    );
  }

  private sendPlan(client: Client): void {
    const plan = this.sessions.get(client.sessionId)?.plan;
    if (plan) client.send('prepareArea', plan.message);
  }
  private createPlan(
    client: Client,
    session: Session,
    reason: PrepareArea['reason'],
    deadline: number,
    requestId?: number,
    position?: Vec3,
  ): void {
    if (session.plan) this.completePlan(client, session, false, 'PLAN_REPLACED', false);
    const actual = this.state.players.get(client.sessionId);
    const target =
      position ??
      (reason === 'reconnect' && actual
        ? { x: actual.x, y: actual.y, z: actual.z }
        : (this.world.findSpawn(reason === 'respawn' ? session.entityId : undefined) ??
          this.definition.spawnPoints[0]));
    const message: PrepareArea = {
      prepareId: randomUUID(),
      worldEpoch: this.state.worldEpoch,
      mapVersion: this.state.mapVersion,
      reason,
      position: { ...target },
      cellIds: worldNeighborhood(this.definition.bounds, this.manifest.grid, target),
      expiresAt: Date.now() + Math.max(0, deadline - performance.now()),
      ...(requestId !== undefined ? { requestId } : {}),
    };
    session.plan = { message, deadline };
    this.inputs.get(client.sessionId).clear();
    this.world.setInput(session.entityId, NEUTRAL_INPUT);
    client.send('prepareArea', message);
  }
  private areaReady(client: Client, value: unknown): void {
    const session = this.sessions.get(client.sessionId);
    if (!session || !value || typeof value !== 'object') return;
    const data = value as Record<string, unknown>;
    if (data.worldEpoch !== this.state.worldEpoch || data.mapVersion !== this.state.mapVersion) {
      client.send('problem', { code: 'STALE_WORLD' });
      return;
    }
    if (typeof data.prepareId !== 'string') return;
    const previous = session.areaResults.get(data.prepareId);
    if (previous) {
      client.send('areaResult', previous);
      return;
    }
    const plan = session.plan;
    if (!plan || plan.message.prepareId !== data.prepareId) return;
    if (plan.readyAt === undefined) {
      if (performance.now() >= plan.deadline) {
        this.expirePlan(client, session, 'PREPARE_TIMEOUT');
        return;
      }
      plan.readyAt = performance.now();
    }
    this.tryCompletePlan(client, session);
  }
  private tryCompletePlan(client: Client, session: Session): void {
    const plan = session.plan;
    if (!plan || plan.readyAt === undefined) return;
    const { reason, cellIds, requestId } = plan.message;
    if (reason !== 'spawn' && performance.now() >= plan.deadline) {
      this.expirePlan(client, session, 'PREPARE_TIMEOUT');
      return;
    }
    if (reason === 'reconnect') {
      const player = this.state.players.get(client.sessionId);
      if (!player) {
        this.expirePlan(client, session, 'STALE_WORLD');
        return;
      }
      const position = { x: player.x, y: player.y, z: player.z };
      if (
        !worldNeighborhood(this.definition.bounds, this.manifest.grid, position).every((id) =>
          cellIds.includes(id),
        )
      ) {
        if (performance.now() < plan.deadline)
          this.createPlan(client, session, reason, plan.deadline, undefined, position);
        else this.expirePlan(client, session, 'PREPARE_TIMEOUT');
        return;
      }
      this.completePlan(client, session, true);
      return;
    }
    const candidates = [plan.message.position, ...this.definition.spawnPoints];
    const inside = candidates.filter((point) =>
      worldNeighborhood(this.definition.bounds, this.manifest.grid, point).every((id) =>
        cellIds.includes(id),
      ),
    );
    const point = this.world.findSpawn(reason === 'respawn' ? session.entityId : undefined, inside);
    if (point) {
      if (reason === 'respawn') {
        if (!this.world.respawnPlayer(session.entityId, point)) return;
        session.lastRespawn = performance.now();
        const projected = this.state.players.get(client.sessionId)!;
        const actual = this.world
          .getSnapshot()
          .players.find((player) => player.entityId === session.entityId)!;
        applyEntityState(projected, actual);
        this.interest.upsert(projected);
      } else {
        const player = this.world.addPlayer(session.entityId, point);
        if (!player) return;
        const projected = new PlayerSchema();
        applyEntityState(projected, player);
        Object.assign(projected, {
          sessionId: client.sessionId,
          name: session.name,
          color: session.color,
          connected: session.connected,
        });
        this.state.players.set(client.sessionId, projected);
        this.interest.upsert(projected);
      }
      this.inputs.get(client.sessionId).clear();
      this.interest.refresh(client.sessionId);
      this.completePlan(client, session, true);
      return;
    }
    const alternative = this.world.findSpawn(reason === 'respawn' ? session.entityId : undefined);
    if (alternative && performance.now() < plan.deadline)
      this.createPlan(client, session, reason, plan.deadline, requestId, alternative);
    else if (performance.now() - plan.readyAt >= 5000)
      this.expirePlan(client, session, 'SPAWN_UNAVAILABLE');
  }
  private rememberAction(
    client: Client | undefined,
    session: Session,
    requestId: number,
    ok: boolean,
    code?: ErrorCode,
  ): void {
    const result: ActionResult = {
      requestId,
      ok,
      ...(code ? { code } : {}),
      ...(ok || code === 'RATE_LIMITED'
        ? {
            retryAfterMs: Math.max(
              0,
              Math.ceil(RESPAWN_COOLDOWN_MS - (performance.now() - session.lastRespawn)),
            ),
          }
        : {}),
    };
    session.results.set(requestId, result);
    if (session.results.size > 32) session.results.delete(session.results.keys().next().value!);
    client?.send('actionResult', result);
  }
  private completePlan(
    client: Client | undefined,
    session: Session,
    ok: boolean,
    code?: ErrorCode,
    finishAction = true,
  ): void {
    const plan = session.plan;
    if (!plan) return;
    session.plan = undefined;
    const { prepareId, worldEpoch, mapVersion, requestId } = plan.message;
    const result: AreaResult = { prepareId, worldEpoch, mapVersion, ok, ...(code ? { code } : {}) };
    session.areaResults.set(prepareId, result);
    if (session.areaResults.size > 32)
      session.areaResults.delete(session.areaResults.keys().next().value!);
    client?.send('areaResult', result);
    if (finishAction && requestId !== undefined)
      this.rememberAction(client, session, requestId, ok, code);
  }
  private expirePlan(client: Client, session: Session, code: ErrorCode): void {
    const reason = session.plan?.message.reason;
    this.completePlan(client, session, false, code);
    if (reason !== 'respawn') this.fail(client, code);
  }

  private fail(client: Client, code: ErrorCode): void {
    client.send('problem', { code });
    // A server rejection is final and must not acquire a reconnect reservation.
    void client.leave(CloseCode.CONSENTED, code);
  }

  private step(ctx: StepContext): void {
    if (this.pendingCycleMs !== undefined) this.cycleTime.record(this.pendingCycleMs);
    const start = performance.now();
    for (const [sessionId, session] of this.sessions) {
      const client = this.clients.getById(sessionId);
      if (session.plan) {
        this.inputs.get(sessionId).clear();
        this.world.setInput(session.entityId, NEUTRAL_INPUT);
        if (client && session.connected) {
          if (session.plan.readyAt !== undefined) this.tryCompletePlan(client, session);
          else if (start >= session.plan.deadline)
            this.expirePlan(client, session, 'PREPARE_TIMEOUT');
        }
        continue;
      }
      if (!this.state.players.has(sessionId)) continue;
      const input = this.inputs.get(sessionId);
      // More than 250ms of pending movement is stale. Clearing acknowledges
      // discarded commands through Colyseus and forces a clean client restore.
      if (input.size >= Math.min(MAX_INPUT_QUEUE, TICK_RATE / 4)) {
        input.clear();
        this.resyncs++;
        client?.send('resync', { serverTick: this.state.serverTick });
      }
      const command = session.connected ? input.next() : undefined;
      this.world.setInput(session.entityId, normalizeInput(command) ?? NEUTRAL_INPUT);
    }
    const physicsStart = performance.now();
    this.world.step(ctx.dt);
    this.physicsTime.record(performance.now() - physicsStart);
    const snapshot = this.world.getSnapshot();
    const byId = new Map(snapshot.players.map((player) => [player.entityId, player]));
    for (const player of this.state.players.values()) {
      const actual = byId.get(player.entityId);
      if (actual) {
        applyEntityState(player, actual);
        this.interest.upsert(player);
      }
    }
    applyEntityState(this.crate, snapshot.crate);
    this.interest.upsert(this.crate);
    this.state.serverTick = ctx.tick;
    const duration = performance.now() - start;
    this.pendingCycleMs = duration;
    // Diagnostics update at the patch rate rather than churning a field at 60Hz.
    if (ctx.tick % 3 === 0) this.state.stepMs = duration;
    if (this.stepSamples.length === 3600) this.stepSamples.shift();
    this.stepSamples.push(duration);
    if (ctx.tick >= TICK_RATE * 60) {
      this.stepHistogram[Math.min(1000, Math.ceil(duration * 10))]++;
      this.measuredSteps++;
      this.maxStepMs = Math.max(this.maxStepMs, duration);
    }
  }

  /** Exactly at state publication, using the most recent completed physical step. */
  onBeforePatch(): void {
    if (this.disposed) return;
    const start = performance.now();
    this.interest.refresh();
    this.selectionTime.record(performance.now() - start);
    if (this.testDiagnostics) {
      this.publications.push({
        tick: this.state.serverTick,
        entities: [this.crate, ...this.state.players.values()].map(({ entityId, x, z }) => ({
          entityId,
          x,
          z,
        })),
      });
      if (this.publications.length > 120) this.publications.shift();
    }
  }

  override broadcastPatch(): boolean {
    const start = performance.now();
    try {
      return super.broadcastPatch();
    } finally {
      const ms = performance.now() - start;
      this.publicationTime.record(ms);
      if (this.pendingCycleMs !== undefined) this.pendingCycleMs += ms;
    }
  }

  private respawn(client: Client, request: unknown): void {
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    const data = request as { requestId?: unknown; worldEpoch?: unknown } | null;
    if (
      !data ||
      typeof data.requestId !== 'number' ||
      !Number.isSafeInteger(data.requestId) ||
      data.requestId < 1
    ) {
      client.send('problem', { code: 'INVALID_INPUT' });
      return;
    }
    const requestId = data.requestId;
    const previous = session.results.get(requestId);
    if (previous) {
      client.send('actionResult', previous);
      return;
    }
    if (session.plan?.message.requestId === requestId) {
      client.send('prepareArea', session.plan.message);
      return;
    }
    if (requestId <= session.lastRequest) {
      client.send('actionResult', {
        requestId,
        ok: false,
        code: 'ALREADY_PROCESSED',
      } satisfies ActionResult);
      return;
    }
    session.lastRequest = requestId;
    let code: ErrorCode | undefined;
    if (data.worldEpoch !== this.state.worldEpoch) code = 'STALE_WORLD';
    else if (!this.state.players.has(client.sessionId) || session.plan) code = 'WORLD_NOT_READY';
    else if (performance.now() - session.lastRespawn < RESPAWN_COOLDOWN_MS) code = 'RATE_LIMITED';
    if (code) this.rememberAction(client, session, requestId, false, code);
    else
      this.createPlan(
        client,
        session,
        'respawn',
        performance.now() + this.prepareTimeoutMs,
        requestId,
      );
  }

  onDrop(client: Client, code?: number): void {
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    session.connected = false;
    this.interest.drop(client.sessionId);
    this.completePlan(undefined, session, false, 'WORLD_NOT_READY');
    this.world.setInput(session.entityId, NEUTRAL_INPUT);
    this.inputs.get(client.sessionId).clear();
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;
    // 4010 is the SDK's intentional offline/drop signal, not an application
    // rejection. Only terminal codes release an established session immediately.
    const terminal =
      code === CloseCode.CONSENTED ||
      code === CloseCode.SERVER_SHUTDOWN ||
      code === CloseCode.WITH_ERROR ||
      code === CloseCode.FAILED_TO_RECONNECT;
    if (terminal || !player) return;
    void this.allowReconnection(client, this.reconnectSeconds).catch(() => {});
  }
  onReconnect(client: Client): void {
    const session = this.sessions.get(client.sessionId);
    if (!session) throw new ServerError(4002, 'STALE_WORLD');
    session.connected = true;
    this.inputs.get(client.sessionId).clear();
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
    this.interest.reset(client, session.entityId);
    this.createPlan(client, session, 'reconnect', performance.now() + this.prepareTimeoutMs);
  }
  onLeave(client: Client): void {
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    this.interest.drop(client.sessionId);
    this.interest.remove(session.entityId);
    this.world.removePlayer(session.entityId);
    this.state.players.delete(client.sessionId);
    this.sessions.delete(client.sessionId);
    this.state.occupancy = this.sessions.size;
  }
  onDispose(): void {
    this.disposed = true;
    this.loopDelay.disable();
    this.interest?.clear();
    this.world?.dispose();
    this.sessions.clear();
    this.stepSamples.length = 0;
  }
  diagnostics() {
    const sorted = [...this.stepSamples].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
    const cumulativePercentile = (p: number) => {
      if (!this.measuredSteps) return null;
      let cumulative = 0;
      for (let i = 0; i < this.stepHistogram.length; i++) {
        cumulative += this.stepHistogram[i];
        if (cumulative >= Math.ceil(this.measuredSteps * p))
          return i === 1000 ? this.maxStepMs : i / 10;
      }
      return this.maxStepMs;
    };
    const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
    return {
      ...this.world.diagnostics(),
      sessions: this.sessions.size,
      occupied: this.sessions.size,
      reserved: this.sessions.size - this.clients.length,
      tick: this.state.serverTick,
      maxQueue: Math.max(0, ...[...this.sessions.keys()].map((id) => this.inputs.get(id).size)),
      stepP95Ms: percentile(0.95),
      stepP99Ms: percentile(0.99),
      sampleCount: this.stepSamples.length,
      measuredSteps: this.measuredSteps,
      cumulativeStepP95Ms: cumulativePercentile(0.95),
      cumulativeStepP99Ms: cumulativePercentile(0.99),
      maxStepMs: this.maxStepMs,
      memory: { rss, heapUsed, external, arrayBuffers },
      cpu: {
        physics: this.physicsTime.snapshot(),
        selection: this.selectionTime.snapshot(),
        publication: this.publicationTime.snapshot(),
        cycle: this.cycleTime.snapshot(),
        cycleDefinition:
          'Fixed-step work plus all publication CPU before the next step; publication includes selection, encoding, ACKs and transport enqueue, not socket delivery.',
      },
      eventLoop: {
        resolutionMs: 10,
        count: this.loopDelay.count,
        meanMs: this.loopDelay.count ? this.loopDelay.mean / 1e6 : 0,
        p95Ms: this.loopDelay.percentile(95) / 1e6,
        p99Ms: this.loopDelay.percentile(99) / 1e6,
        maxMs: this.loopDelay.max / 1e6,
      },
      ...(this.testDiagnostics ? { testPublications: this.publications } : {}),
      resyncs: this.resyncs,
      interest: this.interest.diagnostics(),
      preparing: [...this.sessions.values()].filter((session) => session.plan).length,
      disposed: this.disposed,
    };
  }
}
