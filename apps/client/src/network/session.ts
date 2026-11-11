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
  toItemState,
  toSimulationSnapshot,
  type EntitySchema,
} from '@su/protocol';
import { createPredictionWorld, type PredictionWorld } from '@su/simulation/prediction';
import {
  MAX_INPUT_QUEUE,
  type InventoryView,
  type ItemAction,
  type ItemCommand,
  type ItemResult,
  type ItemPose,
  type ItemError,
  MAX_PREDICTION_MS,
  PROTOCOL_VERSION,
  RESPAWN_COOLDOWN_MS,
  REACTION_DURATION_MS,
  TICK_RATE,
  findReaction,
  DEFAULT_AVATAR_SKIN,
  resolveAvatarSkinId,
  type AvatarSkinId,
  NEUTRAL_INPUT,
  WORLD_FORMAT_VERSION,
  canonicalJson,
  loadWorldBundle,
  simulationProjection,
  validateWorldManifest,
  worldManifestIdentity,
  type ActionResult,
  type ReactionRequest,
  type MoveInput,
  type WorldDefinition,
  type WorldInfo,
  type WorldManifest,
  type Vec3,
} from '@su/contracts';
import wasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url';
import type { DisplayEntity } from '../presentation/display-state';

export type ConnectionState =
  'loading' | 'ready' | 'connecting' | 'playing' | 'reconnecting' | 'error';
type Pose = { x: number; y: number; z: number };
type StoredSession = { token: string; epoch: string; actionId: number; accountId?: string };
const storageKey = 'su:session:v1';
const fields = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const;
const messages: Record<string, string> = {
  STORAGE_UNAVAILABLE:
    'Сохранение временно недоступно. Мир приостановлен до восстановления связи с БД.',
  ITEM_UNAVAILABLE: 'Предмет уже перемещён. Инвентарь обновлён.',
  OUT_OF_REACH: 'Подойдите ближе: дальность взаимодействия — 3 метра.',
  BLOCKED: 'Здесь есть препятствие или место уже занято.',
  NO_SUPPORT: 'Для предмета нужна опора.',
  OUT_OF_BOUNDS: 'Предмет должен целиком находиться в границах мира.',
  INCOMPATIBLE_STACK: 'Эти стопки нельзя объединить или ячейка уже заполнена.',
  OPERATION_CONFLICT: 'Идентификатор операции уже использован.',
  WORLD_FULL: 'На полигоне уже 8 игроков. Попробуйте войти чуть позже.',
  WORLD_NOT_READY: 'Сервер ещё готовит мир. Попробуйте снова через несколько секунд.',
  VERSION_MISMATCH: 'Версия мира изменилась. Перезагрузите страницу.',
  PREPARE_TIMEOUT: 'Подготовка заняла слишком много времени. Попробуйте войти снова.',
  SPAWN_UNAVAILABLE: 'Все точки старта заняты. Освободите место и попробуйте снова.',
  RATE_LIMITED: 'Возврат на старт доступен раз в 3 секунды.',
  STALE_WORLD: 'Мир был перезапущен. Войдите снова.',
  INVALID_INPUT: 'Сервер отклонил команду. Состояние восстановлено.',
  INVALID_SKIN: 'Эта внешность недоступна. Выберите вариант из каталога.',
  ALREADY_PROCESSED: 'Этот запрос уже обработан.',
  AUTH_REQUIRED: 'Авторизация истекла. Обновите страницу и войдите через Telegram снова.',
  ACCOUNT_CHANGED: 'Аккаунт изменился в другой вкладке. Обновите страницу перед входом.',
  ACCOUNT_IN_USE:
    'Этот аккаунт уже находится в игре. Покиньте мир в другой вкладке или дождитесь завершения переподключения.',
  ACCOUNTS_UNAVAILABLE: 'Хранилище аккаунтов временно недоступно. Повторите вход позже.',
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
  accountId?: string;
  guestSkinId: AvatarSkinId = DEFAULT_AVATAR_SKIN;
  inventory: InventoryView = { slots: [] };
  private pendingItem?: ItemCommand;
  private itemRetryAt = 0;
  private persistencePaused = false;
  onInventoryChange?: () => void;
  onItemResult?: (result: ItemResult) => void;
  state: ConnectionState = 'loading';
  definition!: WorldDefinition;
  manifest!: WorldManifest;
  info!: WorldInfo;
  room?: Room<WorldState>;
  reloadRequired = false;
  private physics?: PredictionWorld;
  private manifestUrl?: URL;
  private readonly resources = new Map<string, Promise<Uint8Array>>();
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
  private pendingReaction?: number;
  private reactionTimeout?: ReturnType<typeof setTimeout>;
  private reactionAvailableAt = 0;
  private inputEnabled = true;
  private discardNextInputFrame = false;
  private lastAck = 0;
  private lastAckAt = 0;
  private lastPatchAt = 0;
  private stalled = false;
  private waitingResync = false;
  private generation = 0;
  private motionRevision = 0;
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
    if (state !== this.state) this.motionRevision++;
    if (state !== 'playing') {
      this.clearPendingRespawn();
      this.clearPendingReaction();
    }
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
    this.resources.clear();
    this.definition = await loadWorldBundle(manifest, (path) => this.readAsset(path));
    if (
      (await this.hash(
        new TextEncoder().encode(canonicalJson(simulationProjection(this.definition))),
      )) !== manifest.simulationConfigHash
    )
      this.versionMismatch();
    this.info = info;
    this.wasm ??= await (await getResponse(wasmUrl)).arrayBuffer();
    this.physics?.dispose();
    this.physics = await createPredictionWorld(this.definition, this.wasm);
  }
  private async hash(bytes: Uint8Array): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  readAsset(path: string): Promise<Uint8Array> {
    if (!this.manifestUrl || !Object.hasOwn(this.manifest.files, path)) this.versionMismatch();
    const existing = this.resources.get(path);
    if (existing) return existing;
    const expected = this.manifest.files[path];
    const url = new URL(path, this.manifestUrl);
    const request = (async () => {
      // A damaged immutable cache entry must not trap reloads on the same bytes.
      // Retry once from the server, while still requiring the manifest hash.
      for (const cache of ['force-cache', 'reload'] as const) {
        const bytes = new Uint8Array(await (await getResponse(url.href, cache)).arrayBuffer());
        if ((await this.hash(bytes)) === expected) return bytes;
      }
      return this.versionMismatch();
    })();
    this.resources.set(path, request);
    void request.catch(() => {
      if (this.resources.get(path) === request) this.resources.delete(path);
    });
    return request;
  }
  /** Graphics and physics must both be prepared before a guest can reserve a seat. */
  markPrepared(): void {
    if (this.state === 'loading') this.setState('ready');
  }
  markPreparationFailed(message: string): void {
    this.physics?.dispose();
    this.physics = undefined;
    this.setState('error', message);
  }
  async restore(): Promise<void> {
    const stored = readStored();
    if (!stored) return;
    if (stored.accountId !== this.accountId) {
      writeStored();
      return;
    }
    if (stored.epoch !== this.info.worldEpoch) {
      writeStored();
      this.onNotice('Мир был перезапущен. Войдите снова; предметы сохранены.');
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
              accountMode: this.accountId ? 'account' : 'guest',
              expectedAccountId: this.accountId,
              skinId: this.accountId ? undefined : this.guestSkinId,
            },
            WorldState,
          );
      if (generation !== this.generation) {
        await room.leave();
        return;
      }
      this.room = room;
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
        this.simulation?.reset();
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
        this.simulation?.reset();
        this.setState('connecting');
        // SDK publishes the replacement token and sends JOIN acknowledgment after this callback.
        queueMicrotask(() => {
          if (this.room === room) {
            this.save();
            room.send('clientReady');
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
          this.onNotice('Соединение завершено. Можно войти снова.');
        }
      });
      room.onError((_code, message) => {
        if (this.room === room && this.state !== 'reconnecting')
          this.onNotice(readableError(message));
      });
      room.onMessage<InventoryView>('inventory', (inventory) => {
        if (this.room !== room) return;
        this.inventory = inventory;
        this.onInventoryChange?.();
      });
      room.onMessage<ItemResult>('itemResult', (result) => {
        if (this.room !== room || result.operationId !== this.pendingItem?.operationId) return;
        if (
          result.code === 'STORAGE_UNAVAILABLE' ||
          result.code === 'WORLD_NOT_READY' ||
          result.code === 'RATE_LIMITED'
        ) {
          this.itemRetryAt = performance.now() + 3000;
          return;
        }
        this.pendingItem = undefined;
        try {
          sessionStorage.removeItem(`su:item-operation:${this.accountId}`);
        } catch {
          /* optional storage */
        }
        if (!result.ok && result.code) this.onNotice(messages[result.code] ?? result.code);
        this.onItemResult?.(result);
        this.onInventoryChange?.();
      });
      room.onMessage<ActionResult>('actionResult', (result) => {
        if (this.room !== room) return;
        if (result.requestId === this.pendingReaction) {
          this.clearPendingReaction();
          if (result.ok || result.code === 'RATE_LIMITED') {
            const delay =
              typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs)
                ? Math.min(REACTION_DURATION_MS, Math.max(0, result.retryAfterMs))
                : REACTION_DURATION_MS;
            this.reactionAvailableAt = performance.now() + delay;
          }
          if (!result.ok && result.code)
            this.onNotice(
              result.code === 'RATE_LIMITED'
                ? 'Дождитесь окончания текущей реакции.'
                : (messages[result.code] ?? result.code),
            );
          return;
        }
        if (result.requestId !== this.pendingRespawn) return;
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
        this.onNotice(messages[code] ?? 'Сервер восстановил состояние.');
      });
      room.onMessage('resync', () => {
        this.simulation?.reset();
        this.waitingResync = true;
      });
      room.send('clientReady');
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
                : 'Мир был перезапущен. Войдите снова; предметы сохранены.',
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
    if (this.persistencePaused !== room.state.paused) {
      this.persistencePaused = room.state.paused;
      this.simulation?.reset();
      if (room.state.pauseReason === 'STORAGE_UNAVAILABLE')
        this.onNotice(messages.STORAGE_UNAVAILABLE);
    }
    const self = room.state.players.get(room.sessionId);
    if (!self) return;
    if (!this.simulation) this.startPrediction();
    if (this.revisions.get(self.entityId) !== self.revision) this.simulation!.reset();
    const liveIds = new Set([
      ...Array.from(room.state.items.values(), (item) => item.entityId),
      ...Array.from(room.state.players.values(), (player) => player.entityId),
    ]);
    for (const [id, entity] of this.trackedEntities)
      if (!liveIds.has(id)) {
        this.predictor!.detach(entity);
        this.trackedEntities.delete(id);
        this.revisions.delete(id);
      }
    for (const player of room.state.players.values()) this.attach(player);
    for (const item of room.state.items.values()) this.attach(item);
    if (this.waitingResync) {
      this.simulation!.reset();
      this.motionRevision++;
      this.waitingResync = false;
      this.lastAck = this.input!.lastProcessed;
      this.lastAckAt = performance.now();
      this.stalled = false;
    }
    if (this.state !== 'playing') {
      this.setState('playing');
      this.save();
      if (this.accountId) {
        try {
          this.pendingItem =
            JSON.parse(sessionStorage.getItem(`su:item-operation:${this.accountId}`) ?? 'null') ??
            undefined;
        } catch {
          /* optional storage */
        }
        this.itemRetryAt = 0;
      }
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
    const self = room.state.players.get(room.sessionId)!;
    physics.reconcile(toPlayerState(self), toSimulationSnapshot(room.state));
    this.input = room.input({ type: MoveInputSchema, mode: 'reliable' });
    if (this.input.tickRate !== this.definition.simulation.tickRate)
      throw new Error('VERSION_MISMATCH');
    this.predictor = Predict.get(room, { mode: 'lerp', delay: 100 });
    let beforeCorrection: Vec3 | undefined;
    this.simulation = this.predictor.sim({
      input: this.input,
      world: { physics },
      step: (context, world, command) => {
        world.physics.step(command, context.dt);
      },
      adopt: (world) => {
        beforeCorrection = { ...world.physics.getState().position };
        const player = room.state.players.get(room.sessionId);
        if (player)
          world.physics.reconcile(toPlayerState(player), toSimulationSnapshot(room.state));
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
    beforeCorrection = undefined;
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
    if (!room?.state?.worldEpoch || !this.predictor || !this.input || !this.simulation)
      return { entities: this.preview() };
    if (this.input.lastProcessed !== this.lastAck || this.input.pendingCount === 0) {
      this.lastAck = this.input.lastProcessed;
      this.lastAckAt = now;
    }
    const stalled =
      this.input.pendingCount >= MAX_INPUT_QUEUE ||
      (this.input.pendingCount > 0 && now - this.lastAckAt > MAX_PREDICTION_MS) ||
      now - this.lastPatchAt > MAX_PREDICTION_MS;
    if (stalled && !this.stalled && this.state === 'playing') {
      this.stalled = true;
      this.simulation.reset();
      this.motionRevision++;
      room.send('resync');
    }
    if (!stalled && !this.waitingResync && this.state === 'playing') this.stalled = false;
    const steps =
      this.inputEnabled && !this.persistencePaused ? Math.min(this.predictor.tick(now), 5) : 0;
    if (
      this.state === 'playing' &&
      this.inputEnabled &&
      !this.discardNextInputFrame &&
      !this.stalled &&
      !this.persistencePaused &&
      !document.hidden
    ) {
      for (let i = 0; i < steps && this.input.pendingCount < MAX_INPUT_QUEUE; i++) {
        this.input.data.moveX = command.moveX;
        this.input.data.moveZ = command.moveZ;
        this.input.data.sprint = command.sprint ?? false;
        this.input.send();
      }
    }
    this.discardNextInputFrame = false;
    if (
      this.pendingItem &&
      this.state === 'playing' &&
      !this.persistencePaused &&
      now >= this.itemRetryAt
    ) {
      room.send('itemCommand', this.pendingItem);
      this.itemRetryAt = now + 3000;
    }
    const self = room.state.players.get(room.sessionId);
    const entities: DisplayEntity[] = [];
    for (const player of room.state.players.values()) {
      const pose = player === self ? this.simulation.pose() : this.remotePose(player);
      const state = player === self ? this.physics!.getState() : toPlayerState(player);
      const remainingMs = this.reactionRemainingMs(player.reactionExpiresAtTick, now);
      entities.push({
        ...state,
        position: { x: pose.x, y: pose.y, z: pose.z },
        rotation: player === self ? state.rotation : this.remoteRotation(player),
        motionRevision: this.motionRevision,
        motionEnabled:
          this.state === 'playing' &&
          !this.persistencePaused &&
          !this.stalled &&
          !this.waitingResync &&
          !document.hidden &&
          (player !== self || this.inputEnabled),
        name: player.name,
        color: player.color,
        skinId: resolveAvatarSkinId(player.skinId),
        connected: player.connected,
        reaction:
          this.state === 'playing' && player.reactionId
            ? { id: player.reactionId, sequence: player.reactionSequence, remainingMs }
            : undefined,
      });
    }
    for (const item of room.state.items.values())
      entities.push({
        ...toItemState(item),
        typeId: item.typeId,
        position: this.remotePose(item),
        rotation: this.remoteRotation(item),
        color: this.definition.itemCatalog.types[item.typeId].color,
      });
    return { entities, ownId: self?.entityId };
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
    return [];
  }
  get itemPending() {
    return !!this.pendingItem;
  }
  get worldPaused() {
    return this.persistencePaused;
  }
  get storageUnavailable() {
    return this.room?.state.pauseReason === 'STORAGE_UNAVAILABLE';
  }
  itemAction(action: ItemAction) {
    if (
      !this.accountId ||
      !this.room ||
      this.state !== 'playing' ||
      this.pendingItem ||
      this.persistencePaused
    )
      return;
    this.pendingItem = {
      operationId: crypto.randomUUID(),
      worldEpoch: this.info.worldEpoch,
      action,
    };
    try {
      sessionStorage.setItem(
        `su:item-operation:${this.accountId}`,
        JSON.stringify(this.pendingItem),
      );
    } catch {
      /* retry survives reconnect in memory */
    }
    this.itemRetryAt = 0;
    this.onInventoryChange?.();
  }
  nearestItem(): string | undefined {
    const room = this.room,
      self = room?.state.players.get(room.sessionId);
    if (!self) return;
    return Array.from(room!.state.items.values())
      .map((i) => ({
        id: i.entityId,
        distance: Math.hypot(i.x - self.x, i.y - self.y, i.z - self.z),
      }))
      .filter((i) => i.distance <= 3)
      .sort((a, b) => a.distance - b.distance)[0]?.id;
  }
  placement(
    typeId: string,
    from: Vec3,
    to: Vec3,
    rotation: ItemPose['rotation'],
  ): { pose?: ItemPose; error?: ItemError } {
    const hit = this.physics?.surfaceRay(from, to);
    if (!hit) return { error: 'NO_SUPPORT' };
    const size = this.definition.itemCatalog.types[typeId].size;
    // Projection of the rotated box half extents onto the support normal.
    const { x, y, z, w } = rotation,
      n = hit.normal;
    const radius =
      (Math.abs(
        n.x * (1 - 2 * (y * y + z * z)) + n.y * 2 * (x * y + w * z) + n.z * 2 * (x * z - w * y),
      ) *
        size.x +
        Math.abs(
          n.x * 2 * (x * y - w * z) + n.y * (1 - 2 * (x * x + z * z)) + n.z * 2 * (y * z + w * x),
        ) *
          size.y +
        Math.abs(
          n.x * 2 * (x * z + w * y) + n.y * 2 * (y * z - w * x) + n.z * (1 - 2 * (x * x + y * y)),
        ) *
          size.z) /
      2;
    const pose = {
      position: {
        x: hit.point.x + n.x * (radius + 0.015),
        y: hit.point.y + n.y * (radius + 0.015),
        z: hit.point.z + n.z * (radius + 0.015),
      },
      rotation,
    };
    return { pose, error: this.physics?.checkPlacement(typeId, pose) };
  }

  neutral(): void {
    if (!this.input || this.state !== 'playing' || this.stalled) return;
    Object.assign(this.input.data, NEUTRAL_INPUT);
    this.input.send();
  }
  /** Pause local controls independently of the connection, e.g. during GPU recovery. */
  setInputEnabled(enabled: boolean): void {
    if (this.inputEnabled === enabled) return;
    if (!enabled) this.neutral();
    this.inputEnabled = enabled;
    this.motionRevision++;
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
  private reactionRemainingMs(expiresAtTick: number, now = performance.now()): number {
    const serverTick = this.room?.state?.serverTick ?? 0;
    return Math.max(
      0,
      ((expiresAtTick - serverTick) * 1000) / TICK_RATE - (now - this.lastPatchAt),
    );
  }
  reactionStatus(): { pending: boolean; remainingMs: number; available: boolean } {
    const self = this.room?.state?.players?.get(this.room.sessionId);
    return {
      pending: this.pendingReaction !== undefined,
      remainingMs: Math.max(
        0,
        this.reactionAvailableAt - performance.now(),
        this.reactionRemainingMs(self?.reactionExpiresAtTick ?? 0),
      ),
      available: this.state === 'playing' && this.inputEnabled && !this.stalled,
    };
  }
  private clearPendingReaction(): void {
    clearTimeout(this.reactionTimeout);
    this.reactionTimeout = undefined;
    this.pendingReaction = undefined;
  }
  react(reactionId: string): void {
    const status = this.reactionStatus();
    if (
      !status.available ||
      status.pending ||
      status.remainingMs > 0 ||
      !findReaction(reactionId) ||
      document.hidden
    )
      return;
    this.actionId++;
    this.pendingReaction = this.actionId;
    this.reactionTimeout = setTimeout(() => {
      this.clearPendingReaction();
      this.onNotice('Ответ на реакцию не получен. Проверьте связь и попробуйте снова.');
    }, 5000);
    this.save();
    this.room!.send('requestReaction', {
      requestId: this.actionId,
      worldEpoch: this.info.worldEpoch,
      reactionId,
    } satisfies ReactionRequest);
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
    }, 5000);
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
        accountId: this.accountId,
      });
  }
  private cleanup(preserveRecovery = false): void {
    this.clearPendingRespawn();
    this.clearPendingReaction();
    this.inventory = { slots: [] };
    this.pendingItem = undefined;
    this.persistencePaused = false;
    this.onInventoryChange?.();
    this.respawnAvailableAt = 0;
    this.reactionAvailableAt = 0;
    if (!preserveRecovery) this.stopRecoveryCheck();
    this.predictor?.dispose();
    this.predictor = undefined;
    this.simulation = undefined;
    this.input = undefined;
    this.room = undefined;
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
  get playerCount(): number {
    return this.room?.state?.players?.size ?? 0;
  }
  diagnostics() {
    const room = this.room;
    const self = room?.state?.players?.get(room.sessionId);
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
      renderedItemPosition:
        room?.state?.items?.size && this.predictor
          ? this.remotePose(room.state.items.values().next().value!)
          : null,
      correctionP95: percentile(this.corrections, 0.95),
      correctionMax: Math.max(0, ...this.corrections),
      correctionCount: this.correctionCount,
      pendingInputs: this.input?.pendingCount ?? 0,
      lastAck: this.input?.lastProcessed ?? 0,
      stalled: this.stalled,
      inputEnabled: this.inputEnabled,
      respawn: this.respawnStatus(),
      reaction: this.reactionStatus(),
      mapVersion: this.info?.mapVersion,
      simulationConfigHash: this.info?.simulationConfigHash,
      authoritative: self ? toPlayerState(self) : null,
      predicted: self && this.simulation ? this.physics?.getState() : null,
      items: room?.state?.items ? Array.from(room.state.items.values(), toItemState) : [],
      inventory: this.inventory,
      storagePaused: this.persistencePaused,
      entities: room?.state?.players ? Array.from(room.state.players.values(), toPlayerState) : [],
    };
  }
  dispose(): void {
    this.generation++;
    this.cleanup();
    this.physics?.dispose();
    this.resources.clear();
  }
}
