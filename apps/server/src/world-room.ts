import type { Pool } from 'pg';
import { ItemStore } from './items/store.js';
import { ItemRuntime } from './items/runtime.js';
import { randomUUID } from 'node:crypto';
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
  parseItemCommand,
  type ItemResult,
  type ItemState,
  MAX_INPUT_QUEUE,
  PATCH_RATE,
  PLAYER_COLORS,
  PROFILE_COLORS,
  PREPARE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RECONNECT_SECONDS,
  RESPAWN_COOLDOWN_MS,
  REACTION_DURATION_MS,
  TICK_RATE,
  NEUTRAL_INPUT,
  normalizeInput,
  findReaction,
  findAvatarSkin,
  DEFAULT_AVATAR_SKIN,
  type AvatarSkinId,
  type ActionResult,
  type ErrorCode,
  type WorldDefinition,
  type WorldManifest,
} from '@su/contracts';
import {
  EntitySchema,
  MoveInputSchema,
  PlayerSchema,
  WorldState,
  applyEntityState,
} from '@su/protocol';
import { createAuthoritativeWorld } from '@su/simulation/server';
import type { AccountHttp } from './accounts/http.js';
import type { AuthenticatedAccount } from './accounts/store.js';

type PhysicsWorld = Awaited<ReturnType<typeof createAuthoritativeWorld>>;
interface Session {
  entityId: string;
  joinedAt: number;
  readyAt?: number;
  connected: boolean;
  name: string;
  color: string;
  skinId: AvatarSkinId;
  lastRequest: number;
  lastRespawn: number;
  results: Map<number, ActionResult>;
  auth?: AuthenticatedAccount;
  cancelReconnect?: () => void;
}
export interface WorldRoomOptions {
  definition: WorldDefinition;
  manifest: WorldManifest;
  reconnectSeconds?: number;
  prepareTimeoutMs?: number;
  accounts?: AccountHttp;
  pool: Pool;
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
  private items!: ItemRuntime;
  private itemRequests = 0;
  private shutdown?: Promise<void>;
  private sessions = new Map<string, Session>();
  private guestCounter = 0;
  private reconnectSeconds = RECONNECT_SECONDS;
  private prepareTimeoutMs = PREPARE_TIMEOUT_MS;
  private stepSamples: number[] = [];
  private disposed = false;
  private readonly stepHistogram = new Uint32Array(1001);
  private accounts?: AccountHttp;
  private accountPlayers = new Map<string, string>();
  private measuredSteps = 0;
  private maxStepMs = 0;
  private resyncs = 0;

  async onCreate(options: WorldRoomOptions): Promise<void> {
    this.reconnectSeconds = options.reconnectSeconds ?? RECONNECT_SECONDS;
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
    this.accounts = options.accounts;
    this.state.worldEpoch = randomUUID();
    this.state.protocolVersion = PROTOCOL_VERSION;
    this.state.mapVersion = options.manifest.mapVersion;
    this.state.simulationConfigHash = options.manifest.simulationConfigHash;
    this.seatReservationTimeout = 10;
    this.setPatchRate(1000 / PATCH_RATE);
    await this.setPrivate(true);
    this.world = await createAuthoritativeWorld({ ...options.definition, initialItems: [] });
    this.items = new ItemRuntime(
      new ItemStore(options.pool, options.definition, this.state.worldEpoch),
      this.world,
      () => this.persistenceStatus(),
    );
    try {
      await this.items.initialize();
    } catch (error) {
      await this.items.store.close();
      this.world.dispose();
      throw error;
    }
    this.projectItems(this.world.getSnapshot().items);
    this.onMessage('itemCommand', (client, request: unknown) => {
      void this.itemCommand(client, request);
    });
    this.onMessage('inventoryRequest', (client) => {
      void this.sendInventory(client);
    });
    this.onMessage('clientReady', (client) => this.ready(client));
    this.onMessage('requestRespawn', (client, request: unknown) => this.respawn(client, request));
    this.onMessage('requestReaction', (client, request: unknown) => this.react(client, request));
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
      joinedAt: performance.now(),
      connected: true,
      auth,
      name: auth?.profile.displayName ?? `Гость ${ordinal}`,
      skinId: auth?.profile.skinId ?? findAvatarSkin(options.skinId)?.id ?? DEFAULT_AVATAR_SKIN,
      color:
        (auth ? PROFILE_COLORS.find((c) => c.id === auth.profile.colorId)!.hex : undefined) ??
        PLAYER_COLORS.find((c) => !usedColors.has(c)) ??
        PLAYER_COLORS[ordinal % PLAYER_COLORS.length],
      lastRequest: 0,
      lastRespawn: -Infinity,
      results: new Map(),
    });
    if (auth) this.accountPlayers.set(auth.accountId, client.sessionId);
    this.state.occupancy = this.sessions.size;
  }

  private ready(client: Client): void {
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    if (this.state.players.has(client.sessionId) || session.readyAt !== undefined) {
      void this.sendInventory(client);
      return;
    }
    session.readyAt = performance.now();
    this.inputs.get(client.sessionId).clear();
    if (!this.items.paused) this.trySpawn(client.sessionId, session);
    void this.sendInventory(client);
  }

  private trySpawn(sessionId: string, session: Session): void {
    const player = this.world.addPlayer(session.entityId);
    if (!player) return;
    const projected = new PlayerSchema();
    applyEntityState(projected, player);
    projected.sessionId = sessionId;
    projected.name = session.name;
    projected.color = session.color;
    projected.skinId = session.skinId;
    projected.connected = session.connected;
    this.state.players.set(sessionId, projected);
  }

  private fail(client: Client, code: ErrorCode): void {
    client.send('problem', { code });
    // A server rejection is final and must not acquire a reconnect reservation.
    void client.leave(CloseCode.CONSENTED, code);
  }

  private step(ctx: StepContext): void {
    if (this.items.paused) {
      for (const id of this.sessions.keys()) this.inputs.get(id).clear();
      return;
    }
    const start = performance.now();
    for (const [sessionId, session] of this.sessions) {
      const client = this.clients.getById(sessionId);
      if (!this.state.players.has(sessionId)) {
        this.inputs.get(sessionId).clear();
        if (session.readyAt !== undefined) {
          if (start - session.readyAt >= 5000) {
            if (client) this.fail(client, 'SPAWN_UNAVAILABLE');
          } else this.trySpawn(sessionId, session);
        } else if (start - session.joinedAt >= this.prepareTimeoutMs && client) {
          this.fail(client, 'PREPARE_TIMEOUT');
        }
        continue;
      }
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
    this.world.step(ctx.dt);
    const snapshot = this.world.getSnapshot();
    const byId = new Map(snapshot.players.map((player) => [player.entityId, player]));
    for (const player of this.state.players.values()) {
      const actual = byId.get(player.entityId);
      if (actual) applyEntityState(player, actual);
      if (player.reactionId && this.state.serverTick >= player.reactionExpiresAtTick) {
        player.reactionId = '';
        player.reactionExpiresAtTick = 0;
      }
    }
    this.projectItems(snapshot.items);
    this.state.serverTick++;
    this.items.step(this.state.serverTick);
    const duration = performance.now() - start;
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

  /** All discrete actions share one request sequence and bounded result cache. */
  private beginAction(
    client: Client,
    request: unknown,
  ): { session: Session; requestId: number; code?: ErrorCode } | undefined {
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
    else if (this.items.paused || !session.connected || !this.state.players.has(client.sessionId))
      code = 'WORLD_NOT_READY';
    return { session, requestId, code };
  }

  private finishAction(client: Client, session: Session, result: ActionResult): void {
    session.results.set(result.requestId, result);
    if (session.results.size > 32) session.results.delete(session.results.keys().next().value!);
    client.send('actionResult', result);
  }

  private respawn(client: Client, request: unknown): void {
    const action = this.beginAction(client, request);
    if (!action) return;
    const { session, requestId } = action;
    let { code } = action;
    if (!code) {
      if (performance.now() - session.lastRespawn < RESPAWN_COOLDOWN_MS) code = 'RATE_LIMITED';
      else if (!this.world.respawnPlayer(session.entityId)) code = 'SPAWN_UNAVAILABLE';
      else {
        session.lastRespawn = performance.now();
        this.inputs.get(client.sessionId).clear();
      }
    }
    const result: ActionResult = {
      requestId,
      ok: code === undefined,
      ...(code ? { code } : {}),
      ...(code === undefined || code === 'RATE_LIMITED'
        ? {
            retryAfterMs: Math.max(
              0,
              Math.ceil(RESPAWN_COOLDOWN_MS - (performance.now() - session.lastRespawn)),
            ),
          }
        : {}),
    };
    this.finishAction(client, session, result);
  }

  private react(client: Client, request: unknown): void {
    const action = this.beginAction(client, request);
    if (!action) return;
    const { session, requestId } = action;
    let { code } = action;
    const reaction = findReaction((request as { reactionId?: unknown }).reactionId);
    const player = this.state.players.get(client.sessionId);
    const remainingTicks = Math.max(
      0,
      (player?.reactionExpiresAtTick ?? 0) - this.state.serverTick,
    );
    if (!code) {
      if (!reaction) code = 'INVALID_INPUT';
      else if (remainingTicks > 0) code = 'RATE_LIMITED';
      else {
        player!.reactionId = reaction.id;
        player!.reactionSequence++;
        player!.reactionExpiresAtTick =
          this.state.serverTick + Math.ceil((REACTION_DURATION_MS * TICK_RATE) / 1000);
      }
    }
    this.finishAction(client, session, {
      requestId,
      ok: code === undefined,
      ...(code ? { code } : {}),
      ...(code === undefined || code === 'RATE_LIMITED'
        ? {
            retryAfterMs: code
              ? Math.ceil((remainingTicks * 1000) / TICK_RATE)
              : REACTION_DURATION_MS,
          }
        : {}),
    });
  }

  onDrop(client: Client, code?: number): void {
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    session.connected = false;
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
  }
  onLeave(client: Client): void {
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
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
      this.world.setInput(session.entityId, NEUTRAL_INPUT);
      session.cancelReconnect?.();
      const client = this.clients.getById(sessionId);
      client?.send('problem', { code: 'AUTH_REQUIRED' });
      void client?.leave(CloseCode.CONSENTED, 'AUTH_REQUIRED');
    }
  }
  isReady() {
    return !!this.items && !this.items.unavailable && !this.items.closing;
  }
  private projectItems(items: ItemState[]) {
    const ids = new Set(items.map((i) => i.entityId));
    for (const id of this.state.items.keys()) if (!ids.has(id)) this.state.items.delete(id);
    for (const item of items) {
      let schema = this.state.items.get(item.entityId);
      if (!schema) {
        schema = new EntitySchema();
        this.state.items.set(item.entityId, schema);
      }
      applyEntityState(schema, item);
    }
  }
  private persistenceStatus() {
    const wasPaused = this.state.paused;
    this.state.paused = this.items.paused;
    this.state.pauseReason = this.items.unavailable
      ? 'STORAGE_UNAVAILABLE'
      : this.items.closing
        ? 'WORLD_NOT_READY'
        : '';
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
          if (!session.connected || !this.state.players.has(client.sessionId))
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
    return (this.shutdown ??= this.items?.close() ?? Promise.resolve());
  }
  async onDispose(): Promise<void> {
    try {
      await this.shutdownWorld();
    } catch {
      console.error('World disposal follows an incomplete final save.');
    } finally {
      this.disposed = true;
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
    const { rss, heapUsed } = process.memoryUsage();
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
      memory: { rss, heapUsed },
      resyncs: this.resyncs,
      disposed: this.disposed,
      items: this.state.items.size,
      persistence: { paused: this.state.paused, unavailable: this.items.unavailable },
    };
  }
}
