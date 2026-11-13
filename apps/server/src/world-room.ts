import { LiveStaticPlacement, type LayoutPublications } from './layout/live.js';
import type { ServerPlacementCatalog } from './layout/placement-catalog.js';
import type { Pool } from 'pg';
import { ItemStore } from './items/store.js';
import type { WorldOwnership } from './world-ownership.js';
import { ItemRuntime } from './items/runtime.js';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DurationMetric } from './metrics.js';
import { DynamicInterest } from './interest.js';
import { deliverWorldSound } from './sounds.js';
import {
  CloseCode,
  Room,
  ServerError,
  type Client,
  type StepContext,
  type AuthContext,
} from '@colyseus/core';
import {
  MAX_PLAYERS,
  parsePlaceStaticRequest,
  type StaticPlacementError,
  parseItemCommand,
  type ItemResult,
  type ItemState,
  ITEM_GIVE_COOLDOWN_MS,
  MAX_INPUT_QUEUE,
  PATCH_RATE,
  PLAYER_COLORS,
  PROFILE_COLORS,
  resolveProfileColor,
  PREPARE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RECONNECT_SECONDS,
  RESPAWN_COOLDOWN_MS,
  TICK_RATE,
  NEUTRAL_INPUT,
  worldNeighborhood,
  type PrepareArea,
  type AreaResult,
  type Vec3,
  normalizeChatText,
  findAvatarSkin,
  DEFAULT_AVATAR_SKIN,
  type ActionResult,
  type ErrorCode,
  type WorldDefinition,
  type WorldManifest,
  type WorldSoundEvent,
} from '@su/contracts';
import {
  EntitySchema,
  MoveInputSchema,
  readMoveInput,
  PlayerSchema,
  WorldState,
  applyEntityState,
} from '@su/protocol';
import { createAuthoritativeWorld } from '@su/simulation/server';
import type { AccountHttp } from './accounts/http.js';
import type { AuthenticatedAccount } from './accounts/store.js';
import { parseChatCommand, giveFailureMessage, type ChatCommand } from './chat-commands.js';
import { ActionLedger, rememberResult } from './gameplay/action-ledger.js';
import { WorldClock } from './gameplay/world-clock.js';
import {
  PlayerActivities,
  cancelAnimation,
  updatePlayerActivities,
} from './gameplay/player-activities.js';
import type { PlayerSession as Session, ClientAction } from './room/session.js';

type PhysicsWorld = Awaited<ReturnType<typeof createAuthoritativeWorld>>;
export interface WorldRoomOptions {
  layouts?: LayoutPublications;
  placementCatalog?: ServerPlacementCatalog;
  ownership?: WorldOwnership;
  itemStore?: ItemStore;
  definition: WorldDefinition;
  manifest: WorldManifest;
  reconnectSeconds?: number;
  prepareTimeoutMs?: number;
  accounts?: AccountHttp;
  pool: Pool;
  testDiagnostics?: boolean;
  itemCreationEnabled?: boolean;
}

/** Coordinates connections, world preparation and replication; gameplay rules live in gameplay/. */
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
  private manifest!: WorldManifest;
  private definition!: WorldDefinition;
  private items!: ItemRuntime;
  private itemRequests = 0;
  private readonly dayClock = new WorldClock(this.state);
  private staticPlacement?: LiveStaticPlacement;
  private layoutGroup?: Set<string>;
  private layoutFailureReported = false;
  private shutdown?: Promise<void>;
  private sessions = new Map<string, Session>();
  private guestCounter = 0;
  private reconnectSeconds = RECONNECT_SECONDS;
  private prepareTimeoutMs = PREPARE_TIMEOUT_MS;
  private stepSamples: number[] = [];
  private disposed = false;
  private readonly stepHistogram = new Uint32Array(1001);
  private accounts?: AccountHttp;
  private itemCreationEnabled = true;
  private accountPlayers = new Map<string, string>();
  private measuredSteps = 0;
  private maxStepMs = 0;
  private resyncs = 0;
  private soundSequence = 0;

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
    this.definition = options.definition;
    this.interest = new DynamicInterest(options.manifest.grid);
    this.testDiagnostics = options.testDiagnostics ?? false;
    this.loopDelay.enable();
    this.reconnectSeconds = options.reconnectSeconds ?? RECONNECT_SECONDS;
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
    this.accounts = options.accounts;
    this.itemCreationEnabled = options.itemCreationEnabled ?? true;
    this.state.worldEpoch = options.ownership?.epoch ?? randomUUID();
    this.state.protocolVersion = PROTOCOL_VERSION;
    this.state.mapVersion = options.manifest.mapVersion;
    this.state.simulationConfigHash = options.manifest.simulationConfigHash;
    this.seatReservationTimeout = 10;
    this.setPatchRate(1000 / PATCH_RATE);
    await this.setPrivate(true);
    this.world = await createAuthoritativeWorld({ ...options.definition, initialItems: [] });
    this.items = new ItemRuntime(
      options.itemStore ?? new ItemStore(options.pool, options.definition, this.state.worldEpoch),
      this.world,
      () => this.persistenceStatus(),
      (event) => {
        if (event.kind === 'place') this.world.suppressImpacts(event.entityId, 0.25);
        this.publishWorldSound(event);
      },
    );
    try {
      await this.items.initialize();
    } catch (error) {
      await this.items.store.close();
      this.world.dispose();
      throw error;
    }
    if (options.layouts)
      this.staticPlacement = new LiveStaticPlacement(
        options.layouts,
        this.items,
        this.world,
        this.state.worldEpoch,
        () => this.layoutChanged(),
        () => this.neutralAll(),
        options.placementCatalog,
      );
    this.onMessage('placeStatic', (client, request: unknown) => {
      void this.placeStatic(client, request);
    });
    this.projectItems(this.world.getSnapshot().items);
    this.onMessage('itemCommand', (client, request: unknown) => {
      void this.itemCommand(client, request);
    });
    this.onMessage('inventoryRequest', (client) => {
      void this.sendInventory(client);
    });
    this.onMessage('requestArea', (client) => this.sendPlan(client));
    this.onMessage('areaReady', (client, data: unknown) => this.areaReady(client, data));
    this.onMessage('requestRespawn', (client, request: unknown) => this.respawn(client, request));
    this.onMessage('requestReaction', (client, request: unknown) => this.react(client, request));
    this.onMessage('requestAnimation', (client, request: unknown) => this.animate(client, request));
    this.onMessage('requestChat', (client, request: unknown) => this.chat(client, request));
    this.onMessage('resync', (client) => {
      this.inputs.get(client.sessionId).clear();
      const session = this.sessions.get(client.sessionId);
      if (session) this.world.setInput(session.entityId, NEUTRAL_INPUT);
      client.send('resync', { serverTick: this.state.serverTick });
    });
    this.setFixedTimestep((context) => this.step(context), TICK_RATE);
    this.clock.setInterval(() => {
      for (const session of this.sessions.values())
        if (session.auth && session.auth.expiresAt <= Date.now())
          this.revokeAuthSession(session.auth.authSessionId);
    }, 1000);
  }

  async onAuth(
    _client: Client,
    options: Record<string, unknown>,
    context: AuthContext,
  ): Promise<true | AuthenticatedAccount> {
    if (
      !options ||
      options.protocolVersion !== PROTOCOL_VERSION ||
      options.mapVersion !== this.state.mapVersion ||
      options.simulationConfigHash !== this.state.simulationConfigHash
    ) {
      throw new ServerError(4001, 'VERSION_MISMATCH');
    }
    if (!this.isReady()) throw new ServerError(503, 'WORLD_NOT_READY');
    if (options.accountMode === 'guest') {
      if (options.skinId !== undefined && !findAvatarSkin(options.skinId))
        throw new ServerError(4001, 'INVALID_SKIN');
      return true;
    }
    const token = this.accounts?.readToken(context.headers);
    if (options.accountMode !== 'account' && !token) {
      if (options.skinId !== undefined && !findAvatarSkin(options.skinId))
        throw new ServerError(4001, 'INVALID_SKIN');
      return true;
    }
    if (!this.accounts || !token) throw new ServerError(401, 'AUTH_REQUIRED');
    try {
      const account = await this.accounts.store.authenticate(token);
      if (!account) throw new ServerError(401, 'AUTH_REQUIRED');
      if (
        options.expectedAccountId !== undefined &&
        options.expectedAccountId !== account.accountId
      )
        throw new ServerError(401, 'ACCOUNT_CHANGED');
      return account;
    } catch (error) {
      if (error instanceof ServerError) throw error;
      throw new ServerError(503, 'ACCOUNTS_UNAVAILABLE');
    }
  }

  onJoin(client: Client, options: { skinId?: unknown } = {}): void {
    if (!this.isReady()) throw new ServerError(503, 'WORLD_NOT_READY');
    const auth =
      typeof client.auth === 'object' && client.auth?.accountId
        ? (client.auth as AuthenticatedAccount)
        : undefined;
    // No await between the uniqueness check and claiming the slot: covers parallel joins and preparing players.
    if (auth && this.accountPlayers.has(auth.accountId))
      throw new ServerError(409, 'ACCOUNT_IN_USE');
    if (auth && (auth.expiresAt <= Date.now() || this.accounts?.wasRevoked(auth.authSessionId)))
      throw new ServerError(401, 'AUTH_REQUIRED');
    const ordinal = ++this.guestCounter;
    const usedColors = new Set([...this.sessions.values()].map((s) => s.color));
    this.sessions.set(client.sessionId, {
      entityId: `player-${randomUUID()}`,
      connected: true,
      actions: new ActionLedger(),
      activities: new PlayerActivities(),
      auth,
      name: auth?.profile.displayName ?? `Гость ${ordinal}`,
      skinId: auth?.profile.skinId ?? findAvatarSkin(options.skinId)?.id ?? DEFAULT_AVATAR_SKIN,
      color:
        (auth
          ? (resolveProfileColor(auth.profile.colorId)?.hex ?? PROFILE_COLORS[0].hex)
          : undefined) ??
        PLAYER_COLORS.find((c) => !usedColors.has(c)) ??
        PLAYER_COLORS[ordinal % PLAYER_COLORS.length],
      lastRespawn: -Infinity,
      lastInput: { ...NEUTRAL_INPUT },
      areaResults: new Map(),
    });
    if (auth) this.accountPlayers.set(auth.accountId, client.sessionId);
    this.state.occupancy = this.sessions.size;
    this.interest.reset(client, this.sessions.get(client.sessionId)!.entityId);
    this.createPlan(
      client,
      this.sessions.get(client.sessionId)!,
      'spawn',
      performance.now() + this.prepareTimeoutMs,
    );
    void this.sendInventory(client);
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
    const spawnDeadline =
      reason === 'layout' || this.items.layoutPaused ? undefined : session.plan?.spawnDeadline;
    if (session.plan) this.completePlan(client, session, false, 'PLAN_REPLACED', false);
    const actual = this.state.players.get(client.sessionId);
    const target =
      position ??
      ((reason === 'reconnect' || reason === 'layout') && actual
        ? { x: actual.x, y: actual.y, z: actual.z }
        : (this.world.findSpawn(reason === 'respawn' ? session.entityId : undefined) ??
          this.definition.spawnPoints[0]));
    const message: PrepareArea = {
      prepareId: randomUUID(),
      layoutRevision: this.staticPlacement?.publications.current.snapshot.revision ?? 1,
      worldEpoch: this.state.worldEpoch,
      mapVersion: this.state.mapVersion,
      reason,
      position: { ...target },
      cellIds: worldNeighborhood(this.definition.bounds, this.manifest.grid, target),
      expiresAt: Date.now() + Math.max(0, deadline - performance.now()),
      ...(requestId !== undefined ? { requestId } : {}),
    };
    session.plan = { message, deadline, spawnDeadline };
    this.inputs.get(client.sessionId).clear();
    this.world.setInput(session.entityId, NEUTRAL_INPUT);
    client.send('prepareArea', message);
  }
  private areaReady(client: Client, value: unknown): void {
    const session = this.sessions.get(client.sessionId);
    if (!session || !value || typeof value !== 'object') return;
    const data = value as Record<string, unknown>;
    if (
      data.worldEpoch !== this.state.worldEpoch ||
      data.mapVersion !== this.state.mapVersion ||
      data.layoutRevision !== (this.staticPlacement?.publications.current.snapshot.revision ?? 1)
    ) {
      client.send('problem', {
        code: data.worldEpoch !== this.state.worldEpoch ? 'STALE_WORLD' : 'LAYOUT_CHANGED',
      });
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
      if (!this.layoutGroup) plan.spawnDeadline ??= plan.readyAt + 5000;
    }
    if (this.layoutGroup) {
      if (this.staticPlacement?.metrics)
        this.staticPlacement.metrics.clients[client.sessionId] =
          performance.now() - this.staticPlacement.metrics.pauseStarted;
      this.layoutGroup.delete(client.sessionId);
      if (plan.message.reason === 'layout') this.completePlan(client, session, true);
      this.finishLayoutBarrier();
    }
    this.tryCompletePlan(client, session);
  }
  private tryCompletePlan(client: Client, session: Session): void {
    const plan = session.plan;
    if (
      !plan ||
      plan.readyAt === undefined ||
      !session.connected ||
      this.sessions.get(client.sessionId) !== session
    )
      return;
    if (
      session.auth &&
      (session.auth.expiresAt <= Date.now() ||
        this.accounts?.wasRevoked(session.auth.authSessionId))
    ) {
      this.expirePlan(client, session, 'AUTH_REQUIRED');
      return;
    }
    if (this.items.paused) return;
    const { reason, cellIds, requestId } = plan.message;
    if (performance.now() >= (plan.spawnDeadline ?? plan.deadline)) {
      this.expirePlan(client, session, 'PREPARE_TIMEOUT');
      return;
    }
    if (reason === 'reconnect' || reason === 'layout') {
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
        if (!this.world.respawnPlayer(session.entityId, point)) {
          this.expirePlan(client, session, 'SPAWN_UNAVAILABLE');
          return;
        }
        session.lastRespawn = performance.now();
        session.lastInput = { ...NEUTRAL_INPUT };
        cancelAnimation(this.state.players.get(client.sessionId)!, this.state.serverTick);
        const projected = this.state.players.get(client.sessionId)!;
        const actual = this.world.getPlayerState(session.entityId)!;
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
          skinId: session.skinId,
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
    else if (performance.now() >= plan.spawnDeadline!)
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
    session.actions.remember(result);
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
    const { prepareId, worldEpoch, mapVersion, layoutRevision, requestId } = plan.message;
    const result: AreaResult = {
      prepareId,
      worldEpoch,
      mapVersion,
      layoutRevision,
      ok,
      ...(code ? { code } : {}),
    };
    rememberResult(session.areaResults, prepareId, result);
    client?.send('areaResult', result);
    if (finishAction && requestId !== undefined)
      this.rememberAction(client, session, requestId, ok, code);
  }
  private expirePlan(client: Client, session: Session, code: ErrorCode): void {
    const reason = session.plan?.message.reason;
    this.completePlan(client, session, false, code);
    if (reason !== 'respawn') this.fail(client, code);
    this.layoutGroup?.delete(client.sessionId);
    this.finishLayoutBarrier();
  }

  private fail(client: Client, code: ErrorCode): void {
    client.send('problem', { code });
    // A server rejection is final and must not acquire a reconnect reservation.
    void client.leave(CloseCode.CONSENTED, code);
  }

  private step(ctx: StepContext): void {
    if (this.pendingCycleMs !== undefined) this.cycleTime.record(this.pendingCycleMs);
    this.pendingCycleMs = undefined;
    const now = performance.now();
    for (const [id, session] of this.sessions) {
      const plan = session.plan;
      const client = this.clients.getById(id);
      if (plan && client && session.connected && now >= (plan.spawnDeadline ?? plan.deadline))
        this.expirePlan(
          client,
          session,
          plan.readyAt === undefined ? 'PREPARE_TIMEOUT' : 'SPAWN_UNAVAILABLE',
        );
    }
    if (this.items.paused) {
      for (const id of this.sessions.keys()) this.inputs.get(id).clear();
      return;
    }
    const start = performance.now();
    for (const [sessionId, session] of this.sessions) {
      const client = this.clients.getById(sessionId);
      if (session.plan) {
        this.inputs.get(sessionId).clear();
        this.world.setInput(session.entityId, NEUTRAL_INPUT);
        if (client && session.connected && session.plan.readyAt !== undefined)
          this.tryCompletePlan(client, session);
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
      session.lastInput = command ? readMoveInput(command) : { ...NEUTRAL_INPUT };
      this.world.setInput(session.entityId, session.lastInput);
    }
    const physicsStart = performance.now();
    this.world.step(ctx.dt);
    this.physicsTime.record(performance.now() - physicsStart);
    const snapshot = this.world.getSnapshot();
    const byId = new Map(snapshot.players.map((player) => [player.entityId, player]));
    for (const player of this.state.players.values()) {
      const actual = byId.get(player.entityId);
      updatePlayerActivities(player, actual, this.state.serverTick + 1);
      if (actual) {
        applyEntityState(player, actual);
        this.interest.upsert(player);
      }
    }
    this.projectItems(snapshot.items);
    this.state.serverTick++;
    for (const impact of this.world.drainImpacts())
      this.publishWorldSound({ ...impact, kind: 'impact' });
    this.items.step(this.state.serverTick);
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

  private publishWorldSound(
    sound: Omit<WorldSoundEvent, 'worldEpoch' | 'eventId' | 'serverTick'>,
  ): void {
    const actorId =
      sound.actorId &&
      [...this.sessions].find(([, session]) => session.entityId === sound.actorId)?.[0];
    const event: WorldSoundEvent = {
      ...sound,
      actorId: actorId || undefined,
      worldEpoch: this.state.worldEpoch,
      eventId: `${this.state.worldEpoch}:${++this.soundSequence}`,
      serverTick: this.state.serverTick,
    };
    deliverWorldSound(
      event,
      this.clients.map((client) => {
        const session = this.sessions.get(client.sessionId);
        const player = this.state.players.get(client.sessionId);
        return {
          connected: !!session?.connected && !session.plan,
          position: player ? { x: player.x, y: player.y, z: player.z } : undefined,
          send: (message: WorldSoundEvent) => client.send('worldSound', message),
        };
      }),
    );
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
        entities: [...this.state.items.values(), ...this.state.players.values()].map(
          ({ entityId, x, z }) => ({
            entityId,
            x,
            z,
          }),
        ),
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

  /** All discrete actions share one request sequence and bounded result cache. */
  private beginAction(client: Client, request: unknown): ClientAction | undefined {
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    const admission = session.actions.begin(request, session.plan?.message);
    switch (admission.kind) {
      case 'invalid':
        client.send('problem', { code: 'INVALID_INPUT' });
        return;
      case 'pending':
        return;
      case 'prepare':
        client.send('prepareArea', admission.plan);
        return;
      case 'result':
        client.send('actionResult', admission.result);
        return;
    }
    const { requestId, worldEpoch } = admission;
    let code: ErrorCode | undefined;
    if (worldEpoch !== this.state.worldEpoch) code = 'STALE_WORLD';
    else if (
      this.items.paused ||
      session.plan ||
      !session.connected ||
      !this.state.players.has(client.sessionId)
    )
      code = 'WORLD_NOT_READY';
    return { session, requestId, code };
  }

  private finishAction(client: Client, session: Session, result: ActionResult): void {
    session.actions.remember(result);
    if (session.connected) this.clients.getById(client.sessionId)?.send('actionResult', result);
  }

  private respawn(client: Client, request: unknown): void {
    const action = this.beginAction(client, request);
    if (!action) return;
    const { session, requestId } = action;
    let { code } = action;
    if (!code && performance.now() - session.lastRespawn < RESPAWN_COOLDOWN_MS)
      code = 'RATE_LIMITED';
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

  private react(client: Client, request: unknown): void {
    const action = this.beginAction(client, request);
    if (!action) return;
    const { session, requestId, code } = action;
    this.finishAction(client, session, {
      requestId,
      ...session.activities.react(
        this.state.players.get(client.sessionId),
        (request as { reactionId?: unknown }).reactionId,
        this.state.serverTick,
        code,
      ),
    });
  }

  private animate(client: Client, request: unknown): void {
    const action = this.beginAction(client, request);
    if (!action) return;
    const { session, requestId, code } = action;
    const actual = code ? undefined : this.world.getPlayerState(session.entityId);
    this.finishAction(client, session, {
      requestId,
      ...session.activities.animate(
        this.state.players.get(client.sessionId),
        actual,
        session.lastInput,
        (request as { animationId?: unknown }).animationId,
        this.state.serverTick,
        code,
      ),
    });
  }

  private chat(client: Client, request: unknown): void {
    const action = this.beginAction(client, request);
    if (!action) return;
    const { session, requestId, code } = action;
    const text = normalizeChatText((request as { text?: unknown }).text);
    const command = text && parseChatCommand(text);
    if (command) {
      void this.chatCommand(client, action, command);
      return;
    }
    this.finishAction(client, session, {
      requestId,
      ...session.activities.chat(
        this.state.players.get(client.sessionId),
        text,
        this.state.serverTick,
        code,
      ),
    });
  }

  private async chatCommand(client: Client, action: ClientAction, command: ChatCommand) {
    const { session, requestId, code } = action;
    const fail = (code: ActionResult['code'], message: string) =>
      this.finishAction(client, session, { requestId, ok: false, code, message });
    if (code) return fail(code, 'Команда сейчас недоступна. Проверьте состояние мира.');
    if (command.kind === 'invalid') return fail(command.code, command.message);
    if (
      !session.auth ||
      session.auth.expiresAt <= Date.now() ||
      this.accounts?.wasRevoked(session.auth.authSessionId)
    )
      return fail(
        'AUTH_REQUIRED',
        command.kind === 'time'
          ? 'Чтобы управлять временем, войдите через Telegram.'
          : command.kind === 'staticPlacement'
            ? 'Чтобы размещать объекты, войдите через Telegram.'
            : giveFailureMessage('AUTH_REQUIRED'),
      );
    if (command.kind === 'time')
      return this.finishAction(client, session, {
        requestId,
        ...this.dayClock.command(command.action, Date.now()),
      });
    if (command.kind === 'staticPlacement') {
      const effect = this.staticPlacement?.effect();
      if (!effect) return fail('COMMAND_DISABLED', 'Размещение объектов недоступно в этом мире.');
      if (this.staticPlacement?.busy || this.items.layoutPaused)
        return fail('WORLD_NOT_READY', 'Обновляется окружение.');
      this.finishAction(client, session, { requestId, ok: true, effect });
      return;
    }
    if (!this.itemCreationEnabled)
      return fail('COMMAND_DISABLED', 'Создание предметов отключено на сервере.');
    if (this.staticPlacement?.busy || this.items.layoutPaused)
      return fail('WORLD_NOT_READY', 'Обновляется окружение.');
    const types = this.items.store.definition.itemCatalog.types;
    if (!Object.hasOwn(types, command.typeId))
      return fail('INVALID_INPUT', `Неизвестный тип предмета: ${command.typeId}.`);
    if (this.itemRequests >= 32) return fail('RATE_LIMITED', giveFailureMessage('RATE_LIMITED'));

    session.actions.startPending(requestId);
    this.itemRequests++;
    try {
      const result = await this.items.give(
        session.auth.accountId,
        `chat-${this.state.worldEpoch}-${client.sessionId}-${requestId}`,
        command.typeId,
        () => {
          if (
            session.auth!.expiresAt <= Date.now() ||
            this.accounts?.wasRevoked(session.auth!.authSessionId)
          )
            return 'AUTH_REQUIRED';
          if (
            this.sessions.get(client.sessionId) !== session ||
            session.plan ||
            !session.connected ||
            !this.state.players.has(client.sessionId)
          )
            return 'WORLD_NOT_READY';
        },
      );
      if (result.ok) await this.sendInventory(client);
      this.finishAction(client, session, {
        requestId,
        ok: result.ok,
        ...(result.code ? { code: result.code } : {}),
        message: result.ok
          ? `Получен предмет: ${types[command.typeId].name} ×1.`
          : giveFailureMessage(result.code),
        ...(result.ok || result.code === 'RATE_LIMITED'
          ? { retryAfterMs: ITEM_GIVE_COOLDOWN_MS }
          : {}),
      });
    } catch {
      // Storage uncertainty remains queued in ItemRuntime; rejection means shutdown.
      fail('WORLD_NOT_READY', giveFailureMessage('WORLD_NOT_READY'));
    } finally {
      session.actions.finishPending(requestId);
      this.itemRequests--;
    }
  }

  onDrop(client: Client, code?: number): void {
    this.layoutGroup?.delete(client.sessionId);
    this.finishLayoutBarrier();
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    session.connected = false;
    this.interest.drop(client.sessionId);
    this.completePlan(undefined, session, false, 'WORLD_NOT_READY');
    this.world.setInput(session.entityId, NEUTRAL_INPUT);
    this.inputs.get(client.sessionId).clear();
    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.connected = false;
      cancelAnimation(player, this.state.serverTick);
    }
    // 4010 is the SDK's intentional offline/drop signal, not an application
    // rejection. Only terminal codes release an established session immediately.
    const terminal =
      code === CloseCode.CONSENTED ||
      code === CloseCode.SERVER_SHUTDOWN ||
      code === CloseCode.WITH_ERROR ||
      code === CloseCode.FAILED_TO_RECONNECT;
    if (terminal || !player || (session.auth && session.auth.expiresAt <= Date.now())) return;
    const reconnection = this.allowReconnection(client, this.reconnectSeconds);
    const cancel = () => reconnection.reject(new Error('AUTH_REQUIRED'));
    session.cancelReconnect = cancel;
    void reconnection
      .catch(() => {})
      .finally(() => {
        if (session.cancelReconnect === cancel) session.cancelReconnect = undefined;
      });
  }
  async onReconnect(client: Client): Promise<void> {
    const session = this.sessions.get(client.sessionId);
    if (!session) throw new ServerError(4002, 'STALE_WORLD');
    if (session.auth) {
      let restored: AuthenticatedAccount | undefined;
      try {
        restored = await this.accounts?.store.sessionById(session.auth.authSessionId);
      } catch {
        throw new ServerError(503, 'ACCOUNTS_UNAVAILABLE');
      }
      if (
        !restored ||
        restored.accountId !== session.auth.accountId ||
        session.auth.expiresAt <= Date.now()
      )
        throw new ServerError(401, 'AUTH_REQUIRED');
    }
    session.connected = true;
    void this.sendInventory(client);
    this.inputs.get(client.sessionId).clear();
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
    this.interest.reset(client, session.entityId);
    this.staticPlacement &&
      client.send('layoutChanged', this.staticPlacement.publications.info(this.state.worldEpoch));
    this.createPlan(client, session, 'reconnect', performance.now() + this.prepareTimeoutMs);
    if (this.layoutGroup) this.layoutGroup.add(client.sessionId);
  }
  onLeave(client: Client): void {
    this.layoutGroup?.delete(client.sessionId);
    this.finishLayoutBarrier();
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    const player = this.state.players.get(client.sessionId);
    if (player) cancelAnimation(player, this.state.serverTick);
    this.completePlan(undefined, session, false, 'WORLD_NOT_READY');
    this.interest.drop(client.sessionId);
    this.interest.remove(session.entityId);
    this.world.removePlayer(session.entityId);
    this.state.players.delete(client.sessionId);
    this.sessions.delete(client.sessionId);
    if (session.auth && this.accountPlayers.get(session.auth.accountId) === client.sessionId)
      this.accountPlayers.delete(session.auth.accountId);
    this.state.occupancy = this.sessions.size;
  }
  revokeAuthSession(authSessionId: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.auth?.authSessionId !== authSessionId) continue;
      session.auth.expiresAt = 0;
      session.connected = false;
      const player = this.state.players.get(sessionId);
      if (player) cancelAnimation(player, this.state.serverTick);
      this.world.setInput(session.entityId, NEUTRAL_INPUT);
      session.cancelReconnect?.();
      const client = this.clients.getById(sessionId);
      client?.send('problem', { code: 'AUTH_REQUIRED' });
      void client?.leave(CloseCode.CONSENTED, 'AUTH_REQUIRED');
    }
  }
  isReady(includeLayout = true) {
    return (
      !!this.items &&
      !this.items.unavailable &&
      !this.items.closing &&
      !this.staticPlacement?.fatal &&
      (!includeLayout || (!this.items.layoutPaused && !this.staticPlacement?.busy))
    );
  }
  private neutralAll() {
    for (const [id, session] of this.sessions) {
      this.inputs.get(id).clear();
      session.lastInput = { ...NEUTRAL_INPUT };
      this.world.setInput(session.entityId, NEUTRAL_INPUT);
    }
  }
  private layoutChanged() {
    const p = this.staticPlacement!.publications;
    this.definition = p.current.definition;
    this.manifest = p.current.manifest;
    this.state.mapVersion = this.manifest.mapVersion;
    this.state.simulationConfigHash = this.manifest.simulationConfigHash;
    this.neutralAll();
    if (this.items.closing) {
      this.layoutGroup = undefined;
      return;
    }
    this.layoutGroup = new Set([...this.sessions].filter(([, s]) => s.connected).map(([id]) => id));
    this.broadcast('layoutChanged', p.info(this.state.worldEpoch));
    for (const client of this.clients) {
      const session = this.sessions.get(client.sessionId);
      if (session?.connected)
        this.createPlan(
          client,
          session,
          this.state.players.has(client.sessionId) ? 'layout' : 'spawn',
          performance.now() + this.prepareTimeoutMs,
        );
    }
    this.finishLayoutBarrier();
  }
  private finishLayoutBarrier() {
    if (!this.layoutGroup || this.layoutGroup.size) return;
    this.layoutGroup = undefined;
    if (this.staticPlacement?.metrics)
      this.staticPlacement.metrics.pauseMs =
        performance.now() - this.staticPlacement.metrics.pauseStarted;
    this.neutralAll();
    this.items.setLayoutPaused(false);
    void this.staticPlacement?.publications
      .cleanup()
      .catch((error) => console.error('Layout cleanup failed', error));
  }
  private async placeStatic(client: Client, value: unknown) {
    const request = parsePlaceStaticRequest(value);
    const operationId = request?.operationId ?? '';
    const fail = (code: StaticPlacementError) =>
      client.send('staticPlacementResult', { operationId, ok: false, code });
    if (!request) return fail('INVALID_INPUT');
    const session = this.sessions.get(client.sessionId);
    const authorize = (): StaticPlacementError | undefined => {
      if (
        !session?.auth ||
        session.auth.expiresAt <= Date.now() ||
        this.accounts?.wasRevoked(session.auth.authSessionId)
      )
        return 'AUTH_REQUIRED';
    };
    const auth = authorize();
    if (auth) return fail(auth);
    if (!this.staticPlacement) return fail('COMMAND_DISABLED');
    if (this.itemRequests >= 32) return fail('RATE_LIMITED');
    this.itemRequests++;
    try {
      const result = await this.staticPlacement.place(
        session!.auth!.accountId,
        request,
        authorize,
        () =>
          !session?.connected ||
          session.plan ||
          this.sessions.get(client.sessionId) !== session ||
          !this.state.players.has(client.sessionId)
            ? 'WORLD_NOT_READY'
            : undefined,
      );
      client.send('staticPlacementResult', result);
      if (this.staticPlacement.fatal && !this.layoutFailureReported) {
        this.layoutFailureReported = true;
        this.neutralAll();
        for (const participant of [...this.clients]) this.fail(participant, 'WORLD_NOT_READY');
      }
    } catch {
      /* Uncertain storage remains queued, under the layout pause. */
    } finally {
      this.itemRequests--;
    }
  }
  private projectItems(items: ItemState[]) {
    const ids = new Set(items.map((i) => i.entityId));
    for (const id of this.state.items.keys())
      if (!ids.has(id)) {
        this.interest.remove(id);
        this.state.items.delete(id);
      }
    for (const item of items) {
      let schema = this.state.items.get(item.entityId);
      if (!schema) {
        schema = new EntitySchema();
        this.state.items.set(item.entityId, schema);
      }
      applyEntityState(schema, item);
      this.interest.upsert(schema);
    }
  }
  private persistenceStatus() {
    const wasPaused = this.state.paused;
    this.state.paused = this.items.paused;
    this.state.pauseReason = this.items.unavailable
      ? 'STORAGE_UNAVAILABLE'
      : this.items.closing
        ? 'WORLD_NOT_READY'
        : this.staticPlacement?.fatal
          ? 'WORLD_NOT_READY'
          : this.items.layoutPaused
            ? 'LAYOUT_UPDATING'
            : '';
    if (!wasPaused && this.state.paused)
      for (const player of this.state.players.values())
        cancelAnimation(player, this.state.serverTick);
    if (wasPaused && !this.state.paused) {
      this.projectItems(this.world.getSnapshot().items);
      for (const id of this.sessions.keys()) this.inputs.get(id).clear();
      this.broadcast('resync', { serverTick: this.state.serverTick });
    }
  }
  private async sendInventory(client: Client) {
    const session = this.sessions.get(client.sessionId);
    if (!session?.auth || session.auth.expiresAt <= Date.now()) return;
    try {
      const inventory = await this.items.inventory(session.auth.accountId);
      if (
        session.connected &&
        session.auth.expiresAt > Date.now() &&
        this.sessions.get(client.sessionId) === session
      )
        client.send('inventory', inventory);
    } catch {
      /* Shutdown closes pending reads along with the connection. */
    }
  }
  private async itemCommand(client: Client, request: unknown) {
    if (this.staticPlacement?.busy || this.items.layoutPaused) {
      client.send('itemResult', {
        operationId: (request as { operationId?: string })?.operationId ?? '',
        ok: false,
        code: 'WORLD_NOT_READY',
      });
      return;
    }
    const command = parseItemCommand(request);
    if (!command) {
      client.send('problem', { code: 'INVALID_INPUT' });
      return;
    }
    const session = this.sessions.get(client.sessionId);
    const respond = (result: ItemResult) => {
      if (session?.connected) client.send('itemResult', result);
    };
    if (!session?.auth || session.auth.expiresAt <= Date.now()) {
      respond({ operationId: command.operationId, ok: false, code: 'AUTH_REQUIRED' });
      return;
    }
    if (!this.isReady() || this.itemRequests >= 32) {
      respond({
        operationId: command.operationId,
        ok: false,
        code: this.items.unavailable ? 'STORAGE_UNAVAILABLE' : 'RATE_LIMITED',
      });
      return;
    }
    this.itemRequests++;
    try {
      const result = await this.items.command(
        session.auth.accountId,
        session.entityId,
        command,
        () => {
          if (
            session.auth!.expiresAt <= Date.now() ||
            this.accounts?.wasRevoked(session.auth!.authSessionId)
          )
            return 'AUTH_REQUIRED';
          if (command.worldEpoch !== this.state.worldEpoch) return 'STALE_WORLD';
          if (session.plan || !session.connected || !this.state.players.has(client.sessionId))
            return 'WORLD_NOT_READY';
        },
      );
      this.projectItems(this.world.getSnapshot().items);
      await this.sendInventory(client);
      respond(result);
    } catch {
      /* Uncertain operations stay queued until recovered; shutdown disconnects. */
    } finally {
      this.itemRequests--;
    }
  }
  shutdownWorld(): Promise<void> {
    this.layoutGroup = undefined;
    this.items?.setLayoutPaused(false);
    return (this.shutdown ??= this.items?.close() ?? Promise.resolve());
  }
  async onDispose(): Promise<void> {
    try {
      await this.shutdownWorld();
    } catch {
      console.error('World disposal follows an incomplete final save.');
    } finally {
      this.disposed = true;
      this.loopDelay.disable();
      this.interest?.clear();
      this.world?.dispose();
      this.sessions.clear();
      this.accountPlayers.clear();
      this.stepSamples.length = 0;
    }
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
      staticPlacement: this.staticPlacement?.metrics,
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
      items: this.state.items.size,
      persistence: { paused: this.state.paused, unavailable: this.items.unavailable },
    };
  }
}
