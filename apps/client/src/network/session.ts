import {
  Client,
  CloseCode,
  Predict,
  type Room,
  type InputHandle,
  type SimReconciler,
} from '@colyseus/sdk';
import {
  MoveInputSchema,
  WorldState,
  toPlayerState,
  toEntityState,
  toLocalSimulationSnapshot,
  visibleCrate,
  type EntitySchema,
} from '@su/protocol';
import { createLocalPredictionWorld, type PredictionWorld } from '@su/simulation/prediction';
import {
  MAX_INPUT_QUEUE,
  MAX_PREDICTION_MS,
  PROTOCOL_VERSION,
  RESPAWN_COOLDOWN_MS,
  NEUTRAL_INPUT,
  WORLD_FORMAT_VERSION,
  canonicalJson,
  loadWorldHeader,
  validateWorldManifest,
  worldManifestIdentity,
  type ActionResult,
  type MoveInput,
  type WorldHeader,
  type PrepareArea,
  type AreaResult,
  type WorldInfo,
  type WorldManifest,
  type Vec3,
} from '@su/contracts';
import { predictionCells } from '../streaming/prediction-area';
import { VerifiedResources } from '../streaming/resources';
import { CellStreamer, cellNeighborhood, type CellGraphics } from '../streaming/cells';
import wasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url';
import type { DisplayEntity } from '../rendering/world-view';

export type ConnectionState =
  | 'loading'
  | 'ready'
  | 'connecting'
  | 'preparing'
  | 'waiting'
  | 'playing'
  | 'reconnecting'
  | 'error';
type Pose = { x: number; y: number; z: number };
type StoredSession = { token: string; epoch: string; actionId: number };
const storageKey = 'su:session:v1';
const fields = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const;
const messages: Record<string, string> = {
  WORLD_FULL: 'На полигоне уже 8 игроков. Попробуйте войти чуть позже.',
  WORLD_NOT_READY: 'Сервер ещё готовит мир. Попробуйте снова через несколько секунд.',
  VERSION_MISMATCH: 'Версия мира изменилась. Перезагрузите страницу.',
  PREPARE_TIMEOUT: 'Подготовка заняла слишком много времени. Попробуйте войти снова.',
  SPAWN_UNAVAILABLE: 'Все точки старта заняты. Освободите место и попробуйте снова.',
  RATE_LIMITED: 'Возврат на старт доступен раз в 3 секунды.',
  STALE_WORLD: 'Мир был перезапущен. Войдите снова.',
  INVALID_INPUT: 'Сервер отклонил команду. Состояние восстановлено.',
  ALREADY_PROCESSED: 'Этот запрос уже обработан.',
  PLAN_REPLACED: 'Готовим другую безопасную точку.',
};
export function readableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = Object.keys(messages).find((key) => text.includes(key));
  if (code) return messages[code];
  if (/room.*(?:full|locked)|maximum.*clients|seat.*full/i.test(text)) return messages.WORLD_FULL;
  if (/fetch|network|connect|ECONN|Failed|timeout|aborted/i.test(text))
    return 'Не удалось связаться с сервером. Проверьте, что локальный сервер запущен, и повторите вход.';
  return 'Не удалось подготовить полигон. Перезагрузите страницу или проверьте консоль сервера.';
}
async function getResponse(url: string, cache: RequestCache = 'no-cache'): Promise<Response> {
  const response = await fetch(url, { cache, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`WORLD_NOT_READY: ${response.status}`);
  return response;
}
function readStored(): StoredSession | undefined {
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (typeof stored?.token === 'string' && typeof stored?.epoch === 'string')
      return { ...stored, actionId: Number.isSafeInteger(stored.actionId) ? stored.actionId : 0 };
  } catch {
    /* Storage can be disabled in private browser policies. */
  }
}
function writeStored(value?: StoredSession): void {
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  } catch {
    /* The live session remains usable without reload restoration. */
  }
}
function percentile(values: number[], percentile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))];
}

export class GameSession {
  state: ConnectionState = 'loading';
  definition!: WorldHeader;
  manifest!: WorldManifest;
  info!: WorldInfo;
  room?: Room<WorldState>;
  reloadRequired = false;
  private physics?: PredictionWorld;
  private manifestUrl?: URL;
  private resources?: VerifiedResources;
  private graphics?: CellGraphics;
  private streamer?: CellStreamer;
  private plan?: PrepareArea;
  private planAcknowledged?: string;
  private resumeRevision?: number;
  private areaWaiting = false;
  private waitingTarget?: Vec3;
  private resyncTick?: number;
  private readonly history = new Map<number, { at: number; cells: string[] }>();
  private historyPeak = 0;
  private predictionPauses = 0;
  private prepareStartedAt = 0;
  private readonly preparations: {
    reason: PrepareArea['reason'];
    ms: number;
    ok: boolean;
    code?: string;
  }[] = [];
  private replaySteps = 0;
  private planResults: AreaResult[] = [];
  private terminalNotice?: string;
  private predictionWorlds = 0;
  private wasm?: ArrayBuffer;
  private input?: InputHandle<MoveInputSchema>;
  private predictor?: Predict;
  private simulation?: SimReconciler<MoveInput, Pose, { physics: PredictionWorld }>;
  private readonly revisions = new Map<string, number>();
  private readonly trackedEntities = new Map<string, EntitySchema>();
  private actionId = 0;
  private pendingRespawn?: number;
  private respawnTimeout?: ReturnType<typeof setTimeout>;
  private respawnAvailableAt = 0;
  private inputEnabled = true;
  private discardNextInputFrame = false;
  private lastAck = 0;
  private lastAckAt = 0;
  private lastPatchAt = 0;
  private stalled = false;
  private waitingResync = false;
  private generation = 0;
  private frames: number[] = [];
  private frameWarmupMs = 0;
  private corrections: number[] = [];
  private correctionCount = 0;
  private reconnectDeadline?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryAbort?: AbortController;
  constructor(
    private readonly onState: (state: ConnectionState, message?: string) => void,
    private readonly onNotice: (message: string) => void,
  ) {}
  private setState(state: ConnectionState, message?: string): void {
    if (['loading', 'ready', 'error', 'reconnecting'].includes(state)) this.clearPendingRespawn();
    this.state = state;
    this.onState(state, message);
  }
  private versionMismatch(): never {
    this.reloadRequired = true;
    throw new Error('VERSION_MISMATCH');
  }
  async load(): Promise<void> {
    this.setState('loading');
    const info = (await (await getResponse('/api/world')).json()) as WorldInfo;
    if (info.protocolVersion !== PROTOCOL_VERSION) this.versionMismatch();
    const manifestUrl = new URL(info.manifestUrl, location.href);
    const rawManifest = await (await getResponse(manifestUrl.href)).json();
    if (rawManifest.formatVersion !== WORLD_FORMAT_VERSION) this.versionMismatch();
    const manifest = validateWorldManifest(rawManifest);
    if (
      manifest.mapVersion !== info.mapVersion ||
      manifest.simulationConfigHash !== info.simulationConfigHash ||
      (await this.hash(
        new TextEncoder().encode(canonicalJson(worldManifestIdentity(manifest))),
      )) !== manifest.mapVersion
    )
      this.versionMismatch();
    this.manifest = manifest;
    this.manifestUrl = manifestUrl;
    this.streamer?.dispose();
    this.streamer = undefined;
    this.resources?.dispose();
    this.resources = new VerifiedResources(manifest, new URL('.', manifestUrl).href);
    this.definition = await loadWorldHeader(manifest, (path) => this.resources!.read(path));
    this.info = info;
    this.wasm ??= await (await getResponse(wasmUrl)).arrayBuffer();
    this.physics?.dispose();
    this.physics = await createLocalPredictionWorld(this.definition, this.wasm);
    this.predictionWorlds++;
  }
  private async hash(bytes: Uint8Array): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  connectGraphics(graphics: CellGraphics): void {
    this.graphics = graphics;
    this.ensureStreamer();
  }
  private ensureStreamer(): void {
    this.resources ??= new VerifiedResources(this.manifest, new URL('.', this.manifestUrl!).href);
    if (!this.streamer && this.graphics && this.physics)
      this.streamer = new CellStreamer(this.manifest, this.resources, this.physics, this.graphics);
  }
  get areaProblem(): string | undefined {
    return this.streamer?.problem;
  }
  retryArea(): void {
    this.streamer?.retry();
  }
  /** Graphics and physics must both be prepared before a guest can reserve a seat. */
  markPrepared(): void {
    if (this.state === 'loading') this.setState('ready');
  }
  markPreparationFailed(message: string): void {
    this.streamer?.dispose();
    this.streamer = undefined;
    this.resources?.dispose();
    this.resources = undefined;
    this.physics?.dispose();
    this.physics = undefined;
    this.setState('error', message);
  }
  async restore(): Promise<void> {
    const stored = readStored();
    if (!stored) return;
    if (stored.epoch !== this.info.worldEpoch) {
      writeStored();
      this.onNotice('Мир был перезапущен. Войдите, чтобы начать заново.');
      return;
    }
    await this.join(stored);
  }
  async join(restore?: StoredSession): Promise<void> {
    if (this.room || this.state === 'connecting') return;
    const generation = ++this.generation;
    this.setState(restore ? 'reconnecting' : 'connecting');
    try {
      const info = (await (await getResponse('/api/world')).json()) as WorldInfo;
      if (
        info.mapVersion !== this.info.mapVersion ||
        info.simulationConfigHash !== this.info.simulationConfigHash ||
        info.protocolVersion !== PROTOCOL_VERSION
      )
        this.versionMismatch();
      this.info = info;
      // Advisory preflight improves feedback; the server still reserves atomically.
      if (!restore && !info.available) throw new Error('WORLD_FULL');
      if (!restore) {
        this.actionId = 0;
        writeStored();
      } else this.actionId = restore.actionId;
      const client = new Client(location.origin.replace(/^http/, 'ws'));
      const room: Room<WorldState> = restore
        ? await client.reconnect<WorldState>(restore.token, WorldState)
        : await client.joinById<WorldState>(
            info.roomId,
            {
              protocolVersion: PROTOCOL_VERSION,
              mapVersion: info.mapVersion,
              simulationConfigHash: info.simulationConfigHash,
            },
            WorldState,
          );
      if (generation !== this.generation) {
        await room.leave();
        return;
      }
      this.room = room;
      this.terminalNotice = undefined;
      this.ensureStreamer();
      room.reconnection.minUptime = 0;
      room.reconnection.maxRetries = 30;
      room.reconnection.minDelay = 300;
      room.reconnection.maxDelay = 1500;
      room.reconnection.maxEnqueuedMessages = 0;
      this.save();
      room.onStateChange(() => {
        if (this.room === room) this.receiveState();
      });
      room.onDrop(() => {
        if (this.room !== room) return;
        this.stalled = true;
        this.pausePrediction();
        this.clearEntityTracking();
        this.plan = undefined;
        this.planAcknowledged = undefined;
        this.setState('reconnecting');
        this.beginRecoveryCheck();
      });
      room.onReconnect(() => {
        if (this.room !== room) return;
        this.stopRecoveryCheck();
        this.stalled = false;
        this.waitingResync = false;
        this.lastAck = 0;
        this.lastAckAt = performance.now();
        this.pausePrediction();
        this.clearEntityTracking();
        this.setState('connecting');
        // SDK publishes the replacement token and sends JOIN acknowledgment after this callback.
        queueMicrotask(() => {
          if (this.room === room) {
            this.save();
            room.send('requestArea');
          }
        });
      });
      room.onLeave((code) => {
        if (this.room !== room) return;
        const recovering = this.state === 'reconnecting' || code === CloseCode.SERVER_SHUTDOWN;
        this.cleanup(recovering);
        writeStored();
        if (recovering) {
          this.setState('reconnecting');
          this.beginRecoveryCheck();
        } else {
          this.setState('ready');
          this.onNotice(this.terminalNotice ?? 'Соединение завершено. Можно войти снова.');
        }
      });
      room.onError((_code, message) => {
        if (this.room === room && this.state !== 'reconnecting')
          this.onNotice(readableError(message));
      });
      room.onMessage<ActionResult>('actionResult', (result) => {
        if (this.room !== room || result.requestId !== this.pendingRespawn) return;
        this.clearPendingRespawn();
        if (result.ok || result.code === 'RATE_LIMITED') {
          const delay =
            typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs)
              ? Math.min(RESPAWN_COOLDOWN_MS, Math.max(0, result.retryAfterMs))
              : RESPAWN_COOLDOWN_MS;
          this.respawnAvailableAt = performance.now() + delay;
        }
        if (!result.ok && result.code) this.onNotice(messages[result.code] ?? result.code);
      });
      room.onMessage<{ code: string }>('problem', ({ code }) => {
        if (this.room !== room) return;
        if (
          ['PREPARE_TIMEOUT', 'SPAWN_UNAVAILABLE', 'VERSION_MISMATCH', 'STALE_WORLD'].includes(code)
        )
          this.terminalNotice = messages[code];
        this.onNotice(messages[code] ?? 'Сервер восстановил состояние.');
      });
      room.onMessage<PrepareArea>('prepareArea', (plan) => {
        if (this.room !== room) return;
        if (plan.worldEpoch !== this.info.worldEpoch || plan.mapVersion !== this.info.mapVersion) {
          void this.leave(messages.STALE_WORLD);
          return;
        }
        const expected = cellNeighborhood(this.manifest, plan.position);
        if (
          !Array.isArray(plan.cellIds) ||
          plan.cellIds.length !== expected.length ||
          !expected.every((id) => plan.cellIds.includes(id))
        ) {
          void this.leave(messages.INVALID_INPUT);
          return;
        }
        if (this.plan?.prepareId === plan.prepareId) return;
        this.pausePrediction();
        this.waitingTarget = undefined;
        this.plan = plan;
        this.prepareStartedAt = performance.now();
        this.planAcknowledged = undefined;
        const self = room.state.players?.get(room.sessionId);
        this.resumeRevision = plan.reason === 'respawn' && self ? self.revision + 1 : undefined;
        this.setState('preparing');
      });
      room.onMessage<AreaResult>('areaResult', (result) => {
        if (this.room !== room || result.prepareId !== this.plan?.prepareId) return;
        this.preparations.push({
          reason: this.plan.reason,
          ms: performance.now() - this.prepareStartedAt,
          ok: result.ok,
          code: result.code,
        });
        if (this.preparations.length > 32) this.preparations.shift();
        this.planResults.push(result);
        if (this.planResults.length > 32) this.planResults.shift();
        if (result.code === 'PLAN_REPLACED') {
          this.plan = undefined;
          return;
        }
        this.plan = undefined;
        this.planAcknowledged = undefined;
        if (!result.ok) {
          this.resumeRevision = undefined;
          this.onNotice(messages[result.code ?? ''] ?? 'Подготовка области отменена.');
        }
      });
      room.onMessage<{ serverTick: number }>('resync', (message) => {
        if (this.room !== room) return;
        this.pausePrediction();
        this.waitingResync = true;
        this.resyncTick = message.serverTick;
      });
      room.send('requestArea');
      if (room.state?.worldEpoch) this.receiveState();
    } catch (error) {
      if (generation !== this.generation) return;
      this.cleanup();
      writeStored();
      this.setState('ready');
      this.onNotice(
        restore
          ? 'Предыдущая сессия завершилась. Войдите, чтобы начать заново.'
          : readableError(error),
      );
    }
  }
  private beginRecoveryCheck(): void {
    if (this.recoveryAbort) return;
    const generation = this.generation;
    const previous = this.info;
    const controller = new AbortController();
    this.recoveryAbort = controller;
    this.reconnectDeadline ??= setTimeout(() => {
      if (this.generation === generation && this.state === 'reconnecting')
        void this.leave('Время восстановления истекло. Войдите снова.');
    }, 30_000);
    const probe = async (): Promise<void> => {
      try {
        const response = await fetch('/api/world', {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]),
        });
        if (response.ok) {
          const info = (await response.json()) as WorldInfo;
          if (controller.signal.aborted || this.generation !== generation) return;
          if (typeof info.worldEpoch === 'string' && info.worldEpoch !== previous.worldEpoch) {
            this.reloadRequired =
              info.protocolVersion !== PROTOCOL_VERSION ||
              info.mapVersion !== previous.mapVersion ||
              info.simulationConfigHash !== previous.simulationConfigHash;
            this.info = info;
            await this.leave(
              this.reloadRequired
                ? 'Мир был перезапущен с новой версией. Перезагрузите страницу.'
                : 'Мир был перезапущен. Войдите, чтобы начать заново.',
            );
            return;
          }
        }
      } catch {
        // The server may still be starting, or the network may remain offline.
      }
      if (
        !controller.signal.aborted &&
        this.generation === generation &&
        this.state === 'reconnecting'
      )
        this.recoveryTimer = setTimeout(() => {
          void probe();
        }, 1000);
    };
    void probe();
  }
  private stopRecoveryCheck(): void {
    clearTimeout(this.reconnectDeadline);
    this.reconnectDeadline = undefined;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryAbort?.abort();
    this.recoveryAbort = undefined;
  }
  private receiveState(): void {
    const room = this.room!;
    this.lastPatchAt = performance.now();
    if (room.state.worldEpoch !== this.info.worldEpoch) {
      void this.leave('Мир был перезапущен. Войдите снова.');
      return;
    }
    const self = room.state.players?.get(room.sessionId);
    this.physics?.syncRemote(toLocalSimulationSnapshot(room.state), self?.entityId ?? '');
    const previousRevision = self && this.revisions.get(self.entityId);
    if (
      this.simulation &&
      self &&
      previousRevision !== undefined &&
      previousRevision !== self.revision
    )
      this.pausePrediction();
    const crate = visibleCrate(room.state);
    const liveIds = new Set([
      ...(crate ? [crate.entityId] : []),
      ...Array.from(room.state.players?.values() ?? [], (player) => player.entityId),
    ]);
    for (const [id, entity] of this.trackedEntities)
      if (!liveIds.has(id)) {
        this.predictor?.detach(entity);
        this.trackedEntities.delete(id);
        this.revisions.delete(id);
      }
    if (!this.predictor) return;
    for (const player of room.state.players?.values() ?? []) this.attach(player);
    if (crate) this.attach(crate);
  }
  private clearEntityTracking(): void {
    for (const entity of this.trackedEntities.values()) this.predictor?.detach(entity);
    this.trackedEntities.clear();
    this.revisions.clear();
    this.physics?.syncRemote(
      { players: [] },
      this.room?.state?.players?.get(this.room.sessionId)?.entityId ?? '',
    );
  }
  private pausePrediction(): void {
    // These inputs will not replay after the next authoritative restore.
    this.history.clear();
    this.simulation?.dispose();
    this.simulation = undefined;
  }
  private planArea(): void {
    if (!this.streamer || !this.room) return;
    const self = this.room.state.players?.get(this.room.sessionId);
    const history = new Set<string>();
    for (const [seq, entry] of this.history) {
      if (seq <= (this.input?.lastProcessed ?? 0)) this.history.delete(seq);
      else for (const id of entry.cells) history.add(id);
    }
    if (this.plan)
      this.streamer.setArea(
        this.plan.position,
        self ? { x: self.x, y: self.y, z: self.z } : this.plan.position,
        history,
      );
    else if (self) {
      const authoritative = { x: self.x, y: self.y, z: self.z };
      const predicted = this.simulation
        ? this.physics!.getState().position
        : (this.waitingTarget ?? authoritative);
      this.streamer.setArea(authoritative, predicted, history);
    }
  }
  private attach(entity: EntitySchema): void {
    const previous = this.revisions.get(entity.entityId);
    if (previous === entity.revision && this.trackedEntities.get(entity.entityId) === entity)
      return;
    if (previous !== undefined) this.predictor!.detach(this.trackedEntities.get(entity.entityId)!);
    this.predictor!.attach(
      entity,
      Object.fromEntries(fields.map((field) => [field, { mode: 'lerp', delay: 100, snap: 2 }])),
    );
    this.revisions.set(entity.entityId, entity.revision);
    this.trackedEntities.set(entity.entityId, entity);
  }
  private startPrediction(): void {
    const room = this.room!;
    const physics = this.physics!;
    const self = room.state.players?.get(room.sessionId)!;
    physics.reconcile(toPlayerState(self), toLocalSimulationSnapshot(room.state));
    this.input ??= room.input({ type: MoveInputSchema, mode: 'reliable' });
    if (this.input.tickRate !== this.definition.simulation.tickRate)
      throw new Error('VERSION_MISMATCH');
    this.predictor ??= Predict.get(room, { mode: 'lerp', delay: 100 });
    let beforeCorrection: Vec3 | undefined;
    this.simulation = this.predictor.sim({
      input: this.input,
      world: { physics },
      step: (context, world, command) => {
        const before = world.physics.getState().position;
        world.physics.step(command, context.dt);
        const after = world.physics.getState().position;
        this.history.set(context.tick, {
          at: this.history.get(context.tick)?.at ?? performance.now(),
          cells: predictionCells(
            this.manifest,
            before,
            after,
            this.definition.simulation.character.radius,
          ),
        });
        this.historyPeak = Math.max(this.historyPeak, this.history.size);
        if (context.isReplay) this.replaySteps++;
      },
      adopt: (world) => {
        beforeCorrection = { ...world.physics.getState().position };
        const player = room.state.players?.get(room.sessionId);
        if (player)
          world.physics.reconcile(toPlayerState(player), toLocalSimulationSnapshot(room.state));
      },
      pose: (world) => {
        const { position } = world.physics.getState();
        return { ...position };
      },
      smoothMs: 65,
      snap: 2,
      // Enable SDK drift diagnostics through its public API, never internal fields.
      warnOnDivergence: 0.5,
      onReconcile: () => {
        const after = physics.getState().position;
        // The physical correction excludes the SDK's existing visual smoothing offset.
        this.corrections.push(
          beforeCorrection
            ? Math.hypot(
                beforeCorrection.x - after.x,
                beforeCorrection.y - after.y,
                beforeCorrection.z - after.z,
              )
            : 0,
        );
        this.correctionCount++;
        if (this.corrections.length > 3600) this.corrections.shift();
        beforeCorrection = undefined;
      },
    });
    this.simulation.reset();
    this.history.clear();
    beforeCorrection = undefined;
    this.receiveState();
    this.lastAckAt = performance.now();
    this.lastAck = 0;
  }
  frame(
    now: number,
    delta: number,
    command: MoveInput,
  ): { entities: DisplayEntity[]; ownId?: string } {
    if (
      this.state === 'playing' &&
      this.inputEnabled &&
      !this.discardNextInputFrame &&
      !document.hidden &&
      delta > 0
    ) {
      const frameMs = delta * 1000;
      const warmedUp = this.frameWarmupMs >= 60_000;
      this.frameWarmupMs += frameMs;
      if (warmedUp) {
        this.frames.push(frameMs);
        if (this.frames.length > 3600) this.frames.shift();
      }
    }
    const room = this.room;
    if (!room?.state?.worldEpoch || !this.streamer) return { entities: this.preview() };
    this.planArea();
    this.streamer.pump();
    if (/SHA-256|version/i.test(this.areaProblem ?? '')) this.reloadRequired = true;
    const selfNow = room.state.players?.get(room.sessionId);
    if (this.plan && this.streamer.ready && this.planAcknowledged !== this.plan.prepareId) {
      this.planAcknowledged = this.plan.prepareId;
      room.send('areaReady', {
        prepareId: this.plan.prepareId,
        worldEpoch: this.plan.worldEpoch,
        mapVersion: this.plan.mapVersion,
      });
    }
    const ready =
      selfNow &&
      !this.plan &&
      this.streamer.ready &&
      (this.resumeRevision === undefined || selfNow.revision >= this.resumeRevision) &&
      (!this.waitingResync ||
        (this.resyncTick !== undefined && room.state.serverTick > this.resyncTick));
    if (!ready || this.state === 'reconnecting') {
      if (this.simulation) {
        this.waitingTarget = { ...this.physics!.getState().position };
        this.pausePrediction();
        this.predictionPauses++;
        this.waitingResync = true;
        this.resyncTick = undefined;
        room.send('resync');
      }
      if (!this.plan && selfNow && this.state !== 'reconnecting') this.setWaiting();
      // Neutral commands do not drive a disposed reconciler; authoritative physics keeps running.
      if (
        this.input &&
        this.input.pendingCount < MAX_INPUT_QUEUE &&
        this.state !== 'reconnecting' &&
        now - this.lastNeutralAt >= 1000 / this.definition.simulation.tickRate
      ) {
        Object.assign(this.input.data, NEUTRAL_INPUT);
        this.input.send();
        this.lastNeutralAt = now;
      }
      return this.authoritativeDisplay();
    }
    if (this.waitingResync) {
      this.waitingResync = false;
      this.resyncTick = undefined;
      this.history.clear();
      this.stalled = false;
    }
    this.resumeRevision = undefined;
    this.waitingTarget = undefined;
    if (!this.simulation) this.startPrediction();
    if (this.state !== 'playing') {
      this.setState('playing');
      this.areaWaiting = false;
      this.save();
    }
    if (!this.input || !this.predictor || !this.simulation) return this.authoritativeDisplay();
    if (this.input.lastProcessed !== this.lastAck || this.input.pendingCount === 0) {
      this.lastAck = this.input.lastProcessed;
      this.lastAckAt = now;
    }
    const stalled =
      this.input.pendingCount >=
        Math.min(
          MAX_INPUT_QUEUE,
          (this.definition.simulation.tickRate * MAX_PREDICTION_MS) / 1000,
        ) ||
      [...this.history.values()].some((entry) => now - entry.at > MAX_PREDICTION_MS) ||
      (this.input.pendingCount > 0 && now - this.lastAckAt > MAX_PREDICTION_MS) ||
      now - this.lastPatchAt > MAX_PREDICTION_MS;
    if (stalled && !this.stalled && this.state === 'playing') {
      this.stalled = true;
      this.pausePrediction();
      this.waitingResync = true;
      this.resyncTick = undefined;
      room.send('resync');
      return this.authoritativeDisplay();
    }
    if (!stalled && !this.waitingResync && this.state === 'playing') this.stalled = false;
    const steps = this.inputEnabled ? Math.min(this.predictor.tick(now), 5) : 0;
    if (
      this.state === 'playing' &&
      this.inputEnabled &&
      !this.discardNextInputFrame &&
      !this.stalled &&
      !document.hidden
    ) {
      for (
        let i = 0;
        i < steps &&
        this.input.pendingCount <
          Math.min(
            MAX_INPUT_QUEUE,
            (this.definition.simulation.tickRate * MAX_PREDICTION_MS) / 1000,
          );
        i++
      ) {
        this.input.data.moveX = command.moveX;
        this.input.data.moveZ = command.moveZ;
        this.input.send();
      }
    }
    this.discardNextInputFrame = false;
    const self = room.state.players?.get(room.sessionId);
    const entities: DisplayEntity[] = [];
    for (const player of room.state.players?.values() ?? []) {
      const pose = player === self ? this.simulation.pose() : this.remotePose(player);
      entities.push({
        ...toPlayerState(player),
        position: { x: pose.x, y: pose.y, z: pose.z },
        rotation: player === self ? this.physics!.getState().rotation : this.remoteRotation(player),
        name: player.name,
        color: player.color,
        connected: player.connected,
      });
    }
    const crate = visibleCrate(room.state);
    if (crate)
      entities.push({
        ...toEntityState(crate),
        position: this.remotePose(crate),
        rotation: this.remoteRotation(crate),
        color: this.definition.crate.color,
      });
    return { entities, ownId: self?.entityId };
  }
  private lastNeutralAt = 0;
  private setWaiting() {
    if (this.state !== 'waiting') this.setState('waiting');
    this.areaWaiting = true;
  }
  private authoritativeDisplay(): { entities: DisplayEntity[]; ownId?: string } {
    const room = this.room;
    if (!room?.state?.players) return { entities: room ? [] : this.preview() };
    const entities: DisplayEntity[] = Array.from(room.state.players?.values() ?? [], (player) => ({
      ...toPlayerState(player),
      name: player.name,
      color: player.color,
      connected: player.connected,
    }));
    const crate = visibleCrate(room.state);
    if (crate) entities.push({ ...toEntityState(crate), color: this.definition.crate.color });
    return { entities, ownId: room.state.players?.get(room.sessionId)?.entityId };
  }
  private remotePose(entity: EntitySchema): Pose {
    return {
      x: this.predictor!.value(entity, 'x'),
      y: this.predictor!.value(entity, 'y'),
      z: this.predictor!.value(entity, 'z'),
    };
  }
  private remoteRotation(entity: EntitySchema) {
    return {
      x: this.predictor!.value(entity, 'qx'),
      y: this.predictor!.value(entity, 'qy'),
      z: this.predictor!.value(entity, 'qz'),
      w: this.predictor!.value(entity, 'qw'),
    };
  }
  preview(): DisplayEntity[] {
    const crate = this.definition?.crate;
    return crate
      ? [
          {
            entityId: crate.entityId,
            kind: 'crate',
            revision: 0,
            position: crate.position,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            velocity: { x: 0, y: 0, z: 0 },
            angularVelocity: { x: 0, y: 0, z: 0 },
            color: crate.color,
          },
        ]
      : [];
  }
  neutral(): void {
    if (
      !this.input ||
      this.input.pendingCount >= MAX_INPUT_QUEUE ||
      this.state !== 'playing' ||
      this.stalled
    )
      return;
    Object.assign(this.input.data, NEUTRAL_INPUT);
    this.input.send();
  }
  /** Pause local controls independently of the connection, e.g. during GPU recovery. */
  setInputEnabled(enabled: boolean): void {
    if (this.inputEnabled === enabled) return;
    if (!enabled) this.neutral();
    this.inputEnabled = enabled;
    this.simulation?.reset();
    this.discardNextInputFrame = true;
    if (!enabled && this.room && this.state === 'playing') {
      // A neutral command alone sits behind any in-flight input. Clear that queue too.
      this.waitingResync = true;
      this.room.send('resync');
    }
  }
  respawnStatus(): { pending: boolean; remainingMs: number } {
    return {
      pending: this.pendingRespawn !== undefined,
      remainingMs: Math.max(0, this.respawnAvailableAt - performance.now()),
    };
  }
  private clearPendingRespawn(): void {
    clearTimeout(this.respawnTimeout);
    this.respawnTimeout = undefined;
    this.pendingRespawn = undefined;
  }
  respawn(): void {
    const status = this.respawnStatus();
    if (
      !this.room ||
      this.state !== 'playing' ||
      !this.inputEnabled ||
      status.pending ||
      status.remainingMs > 0
    )
      return;
    this.actionId++;
    this.pendingRespawn = this.actionId;
    this.respawnTimeout = setTimeout(() => {
      this.clearPendingRespawn();
      this.onNotice('Ответ на возврат не получен. Проверьте связь и попробуйте снова.');
    }, 21_000);
    this.save();
    this.room.send('requestRespawn', {
      requestId: this.actionId,
      worldEpoch: this.info.worldEpoch,
    });
  }
  async leave(message?: string): Promise<void> {
    const room = this.room;
    this.generation++;
    this.cleanup();
    writeStored();
    if (room) await room.leave();
    this.setState('ready');
    if (message) this.onNotice(message);
  }
  private save(): void {
    if (this.room)
      writeStored({
        token: this.room.reconnectionToken,
        epoch: this.info.worldEpoch,
        actionId: this.actionId,
      });
  }
  private cleanup(preserveRecovery = false): void {
    this.clearPendingRespawn();
    this.respawnAvailableAt = 0;
    if (!preserveRecovery) this.stopRecoveryCheck();
    this.predictor?.dispose();
    this.predictor = undefined;
    this.simulation = undefined;
    this.input = undefined;
    this.room = undefined;
    this.streamer?.dispose();
    this.streamer = undefined;
    this.resources?.dispose();
    this.resources = undefined;
    this.physics?.clear();
    this.plan = undefined;
    this.planAcknowledged = undefined;
    this.resumeRevision = undefined;
    this.history.clear();
    this.areaWaiting = false;
    this.waitingTarget = undefined;
    this.resyncTick = undefined;
    this.revisions.clear();
    this.trackedEntities.clear();
    this.stalled = false;
    this.waitingResync = false;
    this.resetFrameMeasurements();
  }
  /** Start a fresh visible-frame sample window after changing the render configuration. */
  resetFrameMeasurements(): void {
    this.frames.length = 0;
    this.frameWarmupMs = 0;
  }
  correctionHistory(): { firstSequence: number; samples: number[] } {
    return {
      firstSequence: this.correctionCount - this.corrections.length + 1,
      samples: [...this.corrections],
    };
  }
  get occupancy(): number {
    return this.room?.state?.occupancy ?? 0;
  }
  get playerCount(): number {
    return this.room?.state?.players?.size ?? 0;
  }
  diagnostics() {
    const room = this.room;
    const self = room?.state?.players?.get(room.sessionId);
    const crate = room?.state?.crates && visibleCrate(room.state);
    return {
      connection: this.state,
      worldEpoch: room?.state?.worldEpoch ?? this.info?.worldEpoch,
      sessionId: room?.sessionId,
      playerCount: this.playerCount,
      occupancy: room?.state?.occupancy ?? 0,
      serverTick: room?.state?.serverTick ?? 0,
      serverStepMs: room?.state?.stepMs ?? 0,
      rttMs: room?.clock.smoothedRtt() ?? 0,
      frameP95Ms: this.frames.length ? percentile(this.frames, 0.95) : null,
      frameSampleCount: this.frames.length,
      warmingUp:
        this.state === 'playing' && (this.frameWarmupMs < 60_000 || this.frames.length === 0),
      lastCorrection: { sequence: this.correctionCount, magnitude: this.corrections.at(-1) ?? 0 },
      renderedCratePosition: crate && this.predictor ? this.remotePose(crate) : null,
      correctionP95: percentile(this.corrections, 0.95),
      correctionMax: Math.max(0, ...this.corrections),
      correctionCount: this.correctionCount,
      pendingInputs: this.input?.pendingCount ?? 0,
      lastAck: this.input?.lastProcessed ?? 0,
      stalled: this.stalled,
      areaWaiting: this.areaWaiting || !!this.plan,
      areaProblem: this.areaProblem,
      waitingTarget: this.waitingTarget,
      plan: this.plan,
      areaResults: this.planResults.slice(),
      streaming: this.streamer?.diagnostics(),
      physics: this.physics?.staticDiagnostics(),
      predictionWorlds: this.predictionWorlds,
      historyInputs: this.history.size,
      historyMaxAgeMs: Math.max(
        0,
        ...[...this.history.values()].map((entry) => performance.now() - entry.at),
      ),
      historyCells: [...new Set([...this.history.values()].flatMap((entry) => entry.cells))],
      historyPeak: this.historyPeak,
      predictionPauses: this.predictionPauses,
      preparations: this.preparations.slice(),
      replaySteps: this.replaySteps,
      inputEnabled: this.inputEnabled,
      respawn: this.respawnStatus(),
      mapVersion: this.info?.mapVersion,
      simulationConfigHash: this.info?.simulationConfigHash,
      authoritative: self ? toPlayerState(self) : null,
      predicted: self && this.simulation ? this.physics?.getState() : null,
      crate: crate ? toEntityState(crate) : null,
      trackedEntities: [...this.trackedEntities.keys()],
      remotePoses: this.predictor
        ? [...this.trackedEntities.values()]
            .filter((entity) => entity.entityId !== self?.entityId)
            .map((entity) => ({ entityId: entity.entityId, position: this.remotePose(entity) }))
        : [],
      entities: room?.state?.players
        ? Array.from(room.state.players?.values() ?? [], toPlayerState)
        : [],
    };
  }
  dispose(): void {
    this.generation++;
    this.cleanup();
    this.physics?.dispose();
    this.resources?.dispose();
  }
}
