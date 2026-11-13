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
  readMoveInput,
  writeMoveInput,
  WorldState,
  toPlayerState,
  toItemState,
  toLocalSimulationSnapshot,
  type EntitySchema,
  type WireMoveInput,
} from '@su/protocol';
import type { PredictionWorld } from '@su/simulation/prediction';
import {
  MAX_INPUT_QUEUE,
  type WorldPublicationInfo,
  type StaticPlacementEffect,
  type PlaceStaticRequest,
  type PlaceStaticResult,
  parseStoredPlaceStaticRequest,
  type PlacementCatalogReference,
  type PlacementCatalog,
  parseItemCommand,
  isPlayerMoving,
  type InventoryView,
  type ItemAction,
  type ItemCommand,
  type ItemResult,
  type ItemPose,
  type ItemError,
  MAX_PREDICTION_MS,
  PROTOCOL_VERSION,
  RESPAWN_COOLDOWN_MS,
  REACTION_COOLDOWN_MS,
  CHAT_MAX_COOLDOWN_MS,
  normalizeChatText,
  DEFAULT_DAY_CLOCK,
  type DayClock,
  TICK_RATE,
  findReaction,
  findAnimation,
  type AnimationId,
  type AnimationRequest,
  DEFAULT_AVATAR_SKIN,
  resolveAvatarSkinId,
  type AvatarSkinId,
  NEUTRAL_INPUT,
  itemSupportDistance,
  type ActionResult,
  type ReactionRequest,
  type ChatRequest,
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
import {
  CellStreamer,
  cellNeighborhood,
  type CellGraphics,
  type CellPhysics,
} from '../streaming/cells';
import wasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url';
import type { DisplayEntity } from '../presentation/display-state';
import { AnimationBuffer, REMOTE_INTERPOLATION_MS } from '../presentation/animation-buffer';
import { AnimationRequestState } from '../presentation/animation-request';
import { WorldSoundEvents } from '../presentation/world-sound-events';
import { messages, staticPlacementMessages, readableError } from './errors';
import { PendingAction } from './pending-action';
import { PersistentOperation } from './persistent-operation';
import { readPlacementCatalog, PlacementCatalogChanged } from './placement-catalog';
import { getResponse, loadWorldPublication, WorldVersionMismatch } from './world-publication';
export { readableError } from './errors';

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
type StoredSession = { token: string; epoch: string; actionId: number; accountId?: string };
const storageKey = 'su:session:v1';
const fields = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const;
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
  private readonly staticOperation = new PersistentOperation<PlaceStaticRequest>(
    'su:static-operation',
    parseStoredPlaceStaticRequest,
  );
  private publicationTask?: Promise<void>;
  private publicationTarget?: string;
  private switchingPublication = false;
  onStaticPlacementOpen?: (effect: StaticPlacementEffect) => void;
  onStaticPlacementResult?: (result: PlaceStaticResult) => void;
  private openedStaticActions = new Set<number>();
  private pendingChatCommand = false;
  private readonly itemOperation = new PersistentOperation<ItemCommand>(
    'su:item-operation',
    parseItemCommand,
  );
  private liveItemOperation?: string;
  private persistencePaused = false;
  onInventoryChange?: () => void;
  onItemResult?: (result: ItemResult) => void;
  onChatResult?: (result: ActionResult) => void;
  /** Игровые часы комнаты; вне комнаты идут по настенному времени. */
  dayClock: DayClock = DEFAULT_DAY_CLOCK;
  onDayClock?: (clock: DayClock) => void;
  onSpawn?: () => void;
  onActionFeedback?: (cue: 'click' | 'error') => void;
  private readonly worldSounds = new WorldSoundEvents();
  private pendingSpawnSound = false;
  private soundActive = true;
  state: ConnectionState = 'loading';
  definition!: WorldHeader;
  manifest!: WorldManifest;
  info!: WorldInfo;
  room?: Room<WorldState>;
  reloadRequired = false;
  private physics?: PredictionWorld;
  private physicsPreparation?: { controller: AbortController; promise: Promise<void> };
  // Preview streaming is graphical only. Joining installs the physics target before a room
  // can deliver an area plan, so promoting existing cells does not rebuild their graphics.
  private readonly streamingPhysics: CellPhysics = {
    retainStatic: (...args) => {
      if (!this.physics) throw new Error('Local physics is not prepared');
      this.physics.retainStatic(...args);
    },
    releaseStatic: (id) => this.physics?.releaseStatic(id),
  };
  private manifestUrl?: URL;
  private resources?: VerifiedResources;
  private graphics?: CellGraphics;
  private streamer?: CellStreamer;
  private visualArea?: { center: Vec3; drawRadius: number };
  private preparationConfirmed = false;
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
  private simulation?: SimReconciler<WireMoveInput, Pose, { physics: PredictionWorld }>;
  private readonly revisions = new Map<string, number>();
  private readonly trackedEntities = new Map<string, EntitySchema>();
  private actionId = 0;
  private readonly chatRequest = new PendingAction();
  private readonly reactionRequest = new PendingAction();
  private readonly respawnRequest = new PendingAction();
  private readonly animationBuffer = new AnimationBuffer();
  private readonly animationRequest = new AnimationRequestState();
  private animationMoving = false;
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
    if (['loading', 'ready', 'error', 'reconnecting'].includes(state)) {
      this.worldSounds.clear();
      this.pendingSpawnSound = false;
      this.liveItemOperation = undefined;
      this.respawnRequest.cancel();
      this.reactionRequest.cancel();
      this.animationRequest.clear();
      this.animationBuffer.clear();
      this.chatRequest.cancel();
    }
    this.state = state;
    this.onState(state, message);
  }
  private versionMismatch(): never {
    this.reloadRequired = true;
    throw new Error('VERSION_MISMATCH');
  }
  async load(): Promise<void> {
    const generation = ++this.generation;
    this.cancelPhysicsPreparation();
    this.setState('loading');
    try {
      const info = (await (await getResponse('/api/world')).json()) as WorldInfo;
      if (generation !== this.generation) return;
      if (info.protocolVersion !== PROTOCOL_VERSION) this.versionMismatch();
      const publication = await loadWorldPublication(info);
      if (generation !== this.generation) {
        publication.resources.dispose();
        return;
      }
      this.streamer?.dispose();
      this.streamer = undefined;
      this.resources?.dispose();
      this.manifest = publication.manifest;
      this.manifestUrl = publication.url;
      this.definition = publication.definition;
      this.resources = publication.resources;
      this.info = info;
      this.physics?.dispose();
      this.physics = undefined;
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof WorldVersionMismatch) this.versionMismatch();
      throw error;
    }
  }
  /** Replaces the resource/physics generation while preserving the room and character. */
  private changePublication(info: WorldInfo | WorldPublicationInfo): Promise<void> {
    if (
      info.worldEpoch === this.info.worldEpoch &&
      info.assetReleaseVersion === this.info.assetReleaseVersion &&
      info.layoutRevision !== undefined &&
      this.info.layoutRevision !== undefined &&
      info.layoutRevision < this.info.layoutRevision
    )
      return Promise.resolve();
    if (this.publicationTarget === info.mapVersion && this.publicationTask)
      return this.publicationTask;
    if (this.info.mapVersion === info.mapVersion && !this.switchingPublication)
      return Promise.resolve();
    const generation = ++this.generation;
    this.publicationTarget = info.mapVersion;
    this.switchingPublication = true;
    this.cancelPhysicsPreparation();
    this.pausePrediction();
    this.neutral();
    this.clearEntityTracking();
    this.predictor?.dispose();
    this.predictor = undefined;
    this.animationBuffer.clear();
    this.preparationConfirmed = false;
    this.plan = undefined;
    this.planAcknowledged = undefined;
    this.waitingTarget = undefined;
    this.streamer?.dispose();
    this.streamer = undefined;
    this.resources?.dispose();
    this.resources = undefined;
    this.physics?.dispose();
    this.physics = undefined;
    const playing = !!this.room;
    this.setState(playing ? 'preparing' : 'loading');
    const task = (async () => {
      const publication = await loadWorldPublication(info);
      if (generation !== this.generation) {
        publication.resources.dispose();
        return;
      }
      this.manifest = publication.manifest;
      this.manifestUrl = publication.url;
      this.definition = publication.definition;
      this.resources = publication.resources;
      this.info = { ...this.info, ...info };
      if (playing) await this.preparePhysics(generation);
      if (generation !== this.generation) return;
      this.ensureStreamer();
      this.switchingPublication = false;
      this.resetFrameMeasurements();
      if (!playing) this.setState('ready');
    })().catch((error: unknown) => {
      if (generation !== this.generation) return;
      if (error instanceof WorldVersionMismatch) this.versionMismatch();
      throw error;
    });
    this.publicationTask = task;
    return task.finally(() => {
      if (this.publicationTask === task) {
        this.publicationTask = undefined;
        this.publicationTarget = undefined;
      }
    });
  }
  async refreshPublication(): Promise<void> {
    if (
      ['connecting', 'reconnecting'].includes(this.state) ||
      this.switchingPublication ||
      document.hidden
    )
      return;
    const generation = this.generation;
    const info = (await (await getResponse('/api/world')).json()) as WorldInfo;
    if (generation !== this.generation) return;
    if (info.protocolVersion !== PROTOCOL_VERSION) this.versionMismatch();
    if (info.mapVersion !== this.info.mapVersion) await this.changePublication(info);
    else this.info = info;
  }
  readStaticAsset(path: string, signal?: AbortSignal) {
    return this.resources!.read(path, signal);
  }
  async loadPlacementCatalog(
    reference: PlacementCatalogReference,
    signal?: AbortSignal,
  ): Promise<PlacementCatalog> {
    for (let attempt = 0; ; attempt++) {
      const generation = this.generation;
      try {
        const catalog = await readPlacementCatalog(reference, this.info, this.manifest, signal);
        if (generation !== this.generation)
          throw new PlacementCatalogChanged('Мир обновлён во время загрузки каталога.');
        return catalog;
      } catch (error) {
        if (signal?.aborted || !(error instanceof PlacementCatalogChanged) || attempt > 0)
          throw error;
        await this.refreshPublication();
        if (!this.info.placementCatalog) throw new Error('Каталог размещения недоступен.');
        reference = this.info.placementCatalog;
      }
    }
  }
  get staticPlacementPending() {
    return !!this.staticOperation.current;
  }
  placeStatic(
    position: { x: number; z: number },
    yawStep: number,
    assetId: string,
    placementCatalogVersion: string,
  ): boolean {
    if (
      this.staticOperation.current ||
      this.state !== 'playing' ||
      !this.accountId ||
      this.worldPaused
    )
      return false;
    this.staticOperation.begin(
      {
        operationId: crypto.randomUUID(),
        worldEpoch: this.info.worldEpoch,
        assetReleaseVersion: this.info.assetReleaseVersion!,
        assetId,
        placementCatalogVersion,
        expectedLayoutRevision: this.info.layoutRevision!,
        position,
        yawStep,
      },
      this.accountId,
    );
    this.staticOperation.sendIfDue(performance.now(), (request) =>
      this.room!.send('placeStatic', request),
    );
    return true;
  }
  private async preparePhysics(generation: number): Promise<void> {
    if (this.physics) return;
    this.cancelPhysicsPreparation();
    const controller = new AbortController();
    const definition = this.definition;
    const valid = () => !controller.signal.aborted && generation === this.generation;
    const promise = (async () => {
      const [{ createLocalPredictionWorld }, wasm] = await Promise.all([
        import('@su/simulation/prediction'),
        this.wasm ??
          getResponse(wasmUrl, 'default', controller.signal).then((response) =>
            response.arrayBuffer(),
          ),
      ]);
      if (!valid()) return;
      this.wasm = wasm;
      const physics = await createLocalPredictionWorld(definition, wasm);
      if (!valid()) {
        physics.dispose();
        return;
      }
      this.physics = physics;
      this.predictionWorlds++;
    })();
    const preparation = { controller, promise };
    this.physicsPreparation = preparation;
    try {
      await promise;
    } finally {
      if (this.physicsPreparation === preparation) this.physicsPreparation = undefined;
    }
  }
  private cancelPhysicsPreparation(): void {
    this.physicsPreparation?.controller.abort();
    this.physicsPreparation = undefined;
  }
  connectGraphics(graphics: CellGraphics): void {
    this.graphics = graphics;
    this.ensureStreamer();
  }
  private ensureStreamer(): void {
    this.resources ??= new VerifiedResources(this.manifest, new URL('.', this.manifestUrl!).href);
    if (!this.streamer && this.graphics)
      this.streamer = new CellStreamer(
        this.manifest,
        this.resources,
        this.streamingPhysics,
        this.graphics,
      );
  }
  updateVisualArea(center: Vec3, drawRadius: number): number {
    this.visualArea = { center, drawRadius };
    if (!this.room) this.streamer?.setPreview(center, drawRadius);
    else this.streamer?.setVisualArea(center, drawRadius);
    return this.streamer?.graphicsReadyRadius(center, drawRadius) ?? 0;
  }
  get areaProblem(): string | undefined {
    return this.streamer?.problem ?? this.streamer?.backgroundProblem;
  }
  retryArea(): void {
    this.streamer?.retry();
  }
  /** The graphical preview is available before the first gameplay physics initialization. */
  markPrepared(): void {
    if (this.state === 'loading') this.setState('ready');
  }
  markPreparationFailed(message: string): void {
    this.generation++;
    this.cancelPhysicsPreparation();
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
  async join(restore?: StoredSession, retried = false): Promise<void> {
    if (this.room || this.state === 'connecting') return;
    let generation = ++this.generation;
    this.setState(restore ? 'reconnecting' : 'connecting');
    try {
      const info = (await (await getResponse('/api/world')).json()) as WorldInfo;
      if (generation !== this.generation) return;
      if (info.protocolVersion !== PROTOCOL_VERSION) this.versionMismatch();
      if (info.mapVersion !== this.info.mapVersion) {
        await this.changePublication(info);
        generation = this.generation;
        this.setState(restore ? 'reconnecting' : 'connecting');
      }
      this.info = info;
      // Advisory preflight improves feedback; the server still reserves atomically.
      if (!restore && !info.available) throw new Error('WORLD_FULL');
      await this.preparePhysics(generation);
      if (generation !== this.generation) return;
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
      this.preparationConfirmed = false;
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
        this.preparationConfirmed = false;
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
          this.preparationConfirmed = false;
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
      room.onMessage<InventoryView>('inventory', (inventory) => {
        if (this.room !== room) return;
        this.inventory = inventory;
        this.onInventoryChange?.();
      });
      room.onMessage<WorldPublicationInfo>('layoutChanged', (publication) => {
        if (this.room !== room || publication.worldEpoch !== this.info.worldEpoch) return;
        void this.changePublication(publication).catch((error) => {
          if (this.room === room) void this.leave(readableError(error));
        });
      });
      room.onMessage<PlaceStaticResult>('staticPlacementResult', (result) => {
        if (this.room !== room || result.operationId !== this.staticOperation.current?.operationId)
          return;
        if (!result.ok && ['WORLD_NOT_READY', 'STORAGE_UNAVAILABLE'].includes(result.code)) {
          this.staticOperation.defer();
          return;
        }
        this.staticOperation.complete();
        this.onNotice(
          result.ok
            ? 'Объект сохранён.'
            : (result.message ??
                staticPlacementMessages[result.code] ??
                messages[result.code] ??
                result.code),
        );
        this.onStaticPlacementResult?.(result);
      });
      room.onMessage<unknown>('worldSound', (value) => {
        if (this.room !== room) return;
        this.worldSounds.receive(value, {
          epoch: this.info.worldEpoch,
          serverTick: room.state.serverTick,
          sessionId: room.sessionId,
          now: performance.now(),
          active:
            this.soundActive && this.state === 'playing' && this.inputEnabled && !document.hidden,
        });
      });
      room.onMessage<ItemResult>('itemResult', (result) => {
        if (this.room !== room || result.operationId !== this.itemOperation.current?.operationId)
          return;
        if (
          result.code === 'STORAGE_UNAVAILABLE' ||
          result.code === 'WORLD_NOT_READY' ||
          result.code === 'RATE_LIMITED'
        ) {
          this.itemOperation.defer();
          return;
        }
        if (!result.ok && this.liveItemOperation === result.operationId)
          this.onActionFeedback?.('error');
        this.liveItemOperation = undefined;
        this.itemOperation.complete();
        if (!result.ok && result.code) this.onNotice(messages[result.code] ?? result.code);
        this.onItemResult?.(result);
        this.onInventoryChange?.();
      });
      room.onMessage<ActionResult>('actionResult', (result) => {
        if (this.room !== room) return;
        if (
          result.ok &&
          result.effect?.kind === 'staticPlacement' &&
          !this.openedStaticActions.has(result.requestId)
        ) {
          this.openedStaticActions.add(result.requestId);
          if (this.openedStaticActions.size > 32)
            this.openedStaticActions.delete(this.openedStaticActions.values().next().value!);
          this.onStaticPlacementOpen?.(result.effect);
        }
        if (this.animationRequest.result(result)) {
          this.onActionFeedback?.(result.ok ? 'click' : 'error');
          return;
        }
        if (this.chatRequest.settle(result, this.pendingChatCommand ? 0 : CHAT_MAX_COOLDOWN_MS)) {
          if (result.message) this.onNotice(result.message);
          else if (!result.ok && result.code)
            this.onNotice(
              result.code === 'RATE_LIMITED'
                ? 'Дождитесь окончания показа текущего сообщения.'
                : (messages[result.code] ?? result.code),
            );
          this.onChatResult?.(result);
          if (!result.ok) this.onActionFeedback?.('error');
          return;
        }
        if (this.reactionRequest.settle(result, REACTION_COOLDOWN_MS)) {
          if (!result.ok) this.onActionFeedback?.('error');
          if (!result.ok && result.code)
            this.onNotice(
              result.code === 'RATE_LIMITED'
                ? 'Дождитесь окончания текущей реакции.'
                : (messages[result.code] ?? result.code),
            );
          return;
        }
        if (!this.respawnRequest.settle(result, RESPAWN_COOLDOWN_MS)) return;
        if (!result.ok) this.onActionFeedback?.('error');
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
      room.onMessage<PrepareArea>('prepareArea', async (plan) => {
        if (this.room !== room) return;
        try {
          await this.publicationTask;
        } catch {
          return;
        }
        if (this.room !== room) return;
        if (
          plan.worldEpoch !== this.info.worldEpoch ||
          plan.mapVersion !== this.info.mapVersion ||
          plan.layoutRevision !== this.info.layoutRevision
        ) {
          if (plan.worldEpoch !== this.info.worldEpoch) void this.leave(messages.STALE_WORLD);
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
        this.pendingSpawnSound = false;
        this.pausePrediction();
        this.waitingTarget = undefined;
        this.preparationConfirmed = false;
        this.plan = plan;
        this.prepareStartedAt = performance.now();
        this.planAcknowledged = undefined;
        const self = room.state.players?.get(room.sessionId);
        this.resumeRevision = plan.reason === 'respawn' && self ? self.revision + 1 : undefined;
        this.setState('preparing');
      });
      room.onMessage<AreaResult>('areaResult', (result) => {
        if (
          this.room !== room ||
          result.prepareId !== this.plan?.prepareId ||
          result.mapVersion !== this.info.mapVersion ||
          result.layoutRevision !== this.info.layoutRevision ||
          result.worldEpoch !== this.info.worldEpoch
        )
          return;
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
        this.preparationConfirmed = result.ok || !!room.state.players?.get(room.sessionId);
        this.pendingSpawnSound = result.ok && this.plan.reason !== 'reconnect';
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
      if (!retried && error instanceof Error && error.message.includes('VERSION_MISMATCH')) {
        try {
          const latest = (await (await getResponse('/api/world')).json()) as WorldInfo;
          if (
            latest.protocolVersion === PROTOCOL_VERSION &&
            latest.mapVersion !== this.info.mapVersion
          ) {
            await this.changePublication(latest);
            this.setState('ready');
            await this.join(restore, true);
            return;
          }
        } catch {
          /* Fall through to ordinary connection feedback. */
        }
      }
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
            this.reloadRequired = info.protocolVersion !== PROTOCOL_VERSION;
            // Keep the old map identity until preview refresh / join replaces its context.
            // A layout change across restart does not require a new application bundle.
            if (this.reloadRequired || info.mapVersion === previous.mapVersion) this.info = info;
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
    this.animationBuffer.capture(
      room.state.worldEpoch,
      room.state.serverTick,
      room.clock.lastServerTime(),
      room.state.players.values(),
      room.state.paused,
    );
    const animationSelf = room.state.players.get(room.sessionId);
    const observed =
      animationSelf && this.animationBuffer.sample(animationSelf.entityId, room.clock.serverNow());
    if (observed) this.animationRequest.observe(observed.animation);
    if (this.persistencePaused !== room.state.paused) {
      this.persistencePaused = room.state.paused;
      this.simulation?.reset();
      if (room.state.pauseReason === 'STORAGE_UNAVAILABLE')
        this.onNotice(messages.STORAGE_UNAVAILABLE);
    }
    this.setDayClock({
      offsetMs: room.state.dayOffsetMs,
      frozenHour: room.state.dayFrozenHour,
    });
    const self = room.state.players.get(room.sessionId);
    this.physics?.syncRemote(toLocalSimulationSnapshot(room.state), self?.entityId ?? '');
    const previousRevision = self && this.revisions.get(self.entityId);
    if (
      this.simulation &&
      self &&
      previousRevision !== undefined &&
      previousRevision !== self.revision
    )
      this.pausePrediction();
    const liveIds = new Set([
      ...Array.from(room.state.items.values(), (item) => item.entityId),
      ...Array.from(room.state.players.values(), (player) => player.entityId),
    ]);
    for (const [id, entity] of this.trackedEntities)
      if (!liveIds.has(id)) {
        this.predictor?.detach(entity);
        this.trackedEntities.delete(id);
        this.revisions.delete(id);
      }
    if (!this.predictor) return;
    for (const player of room.state.players?.values() ?? []) this.attach(player);
    for (const item of room.state.items.values()) this.attach(item);
  }
  private setDayClock(clock: DayClock): void {
    if (clock.offsetMs === this.dayClock.offsetMs && clock.frozenHour === this.dayClock.frozenHour)
      return;
    this.dayClock = clock;
    this.onDayClock?.(clock);
  }
  private clearEntityTracking(): void {
    for (const entity of this.trackedEntities.values()) this.predictor?.detach(entity);
    this.trackedEntities.clear();
    this.revisions.clear();
    this.physics?.syncRemote(
      { scope: 'local', players: [], items: [] },
      this.room?.state?.players?.get(this.room.sessionId)?.entityId ?? '',
    );
  }
  private pausePrediction(): void {
    this.motionRevision++;
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
      Object.fromEntries(
        (entity.kind === 'player' ? ['x', 'y', 'z'] : fields).map((field) => [
          field,
          { mode: 'lerp', delay: REMOTE_INTERPOLATION_MS, snap: 2 },
        ]),
      ),
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
        world.physics.step(readMoveInput(command), context.dt);
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
    if (room && this.state !== 'reconnecting')
      this.staticOperation.sendIfDue(now, (request) => room.send('placeStatic', request));
    if (this.switchingPublication)
      return room ? this.authoritativeDisplay() : { entities: this.preview() };
    this.planArea();
    this.streamer?.pumpFrame(delta);
    if (/SHA-256|version/i.test(this.areaProblem ?? '')) this.reloadRequired = true;
    if (!room?.state?.worldEpoch || !this.streamer) return { entities: this.preview() };
    const selfNow = room.state.players?.get(room.sessionId);
    if (this.plan && this.streamer.criticalReady && this.planAcknowledged !== this.plan.prepareId) {
      this.planAcknowledged = this.plan.prepareId;
      room.send('areaReady', {
        prepareId: this.plan.prepareId,
        layoutRevision: this.plan.layoutRevision,
        worldEpoch: this.plan.worldEpoch,
        mapVersion: this.plan.mapVersion,
      });
    }
    const ready =
      selfNow &&
      this.preparationConfirmed &&
      !this.plan &&
      this.streamer.criticalReady &&
      (this.resumeRevision === undefined || selfNow.revision >= this.resumeRevision) &&
      (!this.waitingResync ||
        (this.resyncTick !== undefined && room.state.serverTick >= this.resyncTick));
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
        writeMoveInput(this.input.data, NEUTRAL_INPUT);
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
      if (this.accountId) {
        this.staticOperation.restore(this.accountId);
        this.itemOperation.restore(this.accountId);
      }
    }
    if (this.pendingSpawnSound) {
      this.pendingSpawnSound = false;
      this.onSpawn?.();
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
        writeMoveInput(this.input.data, command);
        this.input.send();
      }
    }
    this.discardNextInputFrame = false;
    if (this.state === 'playing' && !this.persistencePaused)
      this.itemOperation.sendIfDue(now, (command) => room.send('itemCommand', command));
    const self = room.state.players.get(room.sessionId);
    this.animationMoving =
      this.inputEnabled &&
      !this.persistencePaused &&
      !document.hidden &&
      (command.moveX !== 0 || command.moveZ !== 0);
    const remoteTime = this.animationDisplayTime(false);
    const entities: DisplayEntity[] = [];
    for (const player of room.state.players?.values() ?? []) {
      const pose = player === self ? this.simulation.pose() : this.remotePose(player);
      const state = player === self ? this.physics!.getState() : toPlayerState(player);
      const remainingMs = player.reactionExpiresAtTick
        ? this.displayRemainingMs(player.reactionExpiresAtTick, now)
        : Infinity;
      const presentation = this.animationBuffer.sample(
        player.entityId,
        player === self ? this.animationDisplayTime(true) : remoteTime,
      );
      entities.push({
        ...state,
        grounded: player === self ? state.grounded : (presentation?.grounded ?? state.grounded),
        animation: presentation?.animation,
        position: { x: pose.x, y: pose.y, z: pose.z },
        rotation:
          player === self || !presentation
            ? state.rotation
            : {
                x: 0,
                y: Math.sin(presentation.facingYaw / 2),
                z: 0,
                w: Math.cos(presentation.facingYaw / 2),
              },
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
        chat:
          this.state === 'playing' && player.chatText
            ? {
                text: player.chatText,
                sequence: player.chatSequence,
                remainingMs: player.chatExpiresAtTick
                  ? this.displayRemainingMs(player.chatExpiresAtTick, now)
                  : Infinity,
              }
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
      skinId: resolveAvatarSkinId(player.skinId),
      motionRevision: this.motionRevision,
      motionEnabled: false,
      connected: player.connected,
    }));
    for (const item of room.state.items.values())
      entities.push({
        ...toItemState(item),
        typeId: item.typeId,
        color: this.definition.itemCatalog.types[item.typeId].color,
      });
    return { entities, ownId: room.state.players?.get(room.sessionId)?.entityId };
  }
  private remotePose(entity: EntitySchema): Pose {
    return {
      x: this.predictor!.value(entity, 'x'),
      y: this.predictor!.value(entity, 'y'),
      z: this.predictor!.value(entity, 'z'),
    };
  }
  private animationDisplayTime(own: boolean): number {
    // Match this SDK version's lerp target, including its one-way latency estimate.
    return (
      this.room!.clock.serverNow() -
      (own ? 0 : REMOTE_INTERPOLATION_MS + this.room!.clock.smoothedRtt() / 2)
    );
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
    return !!this.itemOperation.current;
  }
  get worldPaused() {
    return this.persistencePaused;
  }
  takeWorldSounds(now: number, active = true) {
    return this.worldSounds.drain(
      now,
      active && this.soundActive && this.state === 'playing' && !document.hidden,
    );
  }
  setSoundActive(active: boolean): void {
    this.soundActive = active;
    if (!active) this.worldSounds.suspend();
  }
  get gameplayInputEnabled(): boolean {
    return (
      this.state === 'playing' && this.inputEnabled && !this.stalled && !this.persistencePaused
    );
  }
  get layoutUpdating() {
    return this.room?.state.pauseReason === 'LAYOUT_UPDATING';
  }
  /** Eyes follow the collision controller, never the SDK's decorative correction offset. */
  ownPhysicalPosition(): Vec3 | undefined {
    if (this.simulation && this.physics) return this.physics.getState().position;
    const room = this.room;
    const own = room?.state.players.get(room.sessionId);
    return own ? { x: own.x, y: own.y, z: own.z } : undefined;
  }
  overlayBlocked(from: Vec3, to: Vec3, targetId?: string): boolean {
    const hit = this.physics?.surfaceRay(from, to);
    return (
      !!hit &&
      (targetId === undefined || hit.entityId !== targetId) &&
      Math.hypot(hit.point.x - from.x, hit.point.y - from.y, hit.point.z - from.z) <
        Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) - 0.08
    );
  }
  get storageUnavailable() {
    return this.room?.state.pauseReason === 'STORAGE_UNAVAILABLE';
  }
  itemAction(action: ItemAction) {
    if (
      !this.accountId ||
      !this.room ||
      this.state !== 'playing' ||
      this.itemOperation.current ||
      this.persistencePaused
    )
      return;
    const command: ItemCommand = {
      operationId: crypto.randomUUID(),
      worldEpoch: this.info.worldEpoch,
      action,
    };
    this.itemOperation.begin(command, this.accountId);
    this.liveItemOperation = command.operationId;
    this.onInventoryChange?.();
  }
  placement(
    typeId: string,
    from: Vec3,
    to: Vec3,
    rotation: ItemPose['rotation'],
  ): { pose?: ItemPose; error?: ItemError } {
    const hit = this.physics?.surfaceRay(from, to);
    if (!hit) return { error: 'NO_SUPPORT' };
    const n = hit.normal;
    const radius = itemSupportDistance(this.definition.itemCatalog.types[typeId], rotation, {
      x: -n.x,
      y: -n.y,
      z: -n.z,
    });
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
    if (
      !this.input ||
      this.input.pendingCount >= MAX_INPUT_QUEUE ||
      this.state !== 'playing' ||
      this.stalled
    )
      return;
    writeMoveInput(this.input.data, NEUTRAL_INPUT);
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
      pending: this.respawnRequest.pending,
      remainingMs: this.respawnRequest.remainingMs(),
    };
  }
  private displayRemainingMs(expiresAtTick: number, now = performance.now()): number {
    const serverTick = this.room?.state?.serverTick ?? 0;
    return Math.max(
      0,
      ((expiresAtTick - serverTick) * 1000) / TICK_RATE - (now - this.lastPatchAt),
    );
  }
  reactionStatus(): { pending: boolean; remainingMs: number; available: boolean } {
    const self = this.room?.state?.players?.get(this.room.sessionId);
    return {
      pending: this.reactionRequest.pending,
      remainingMs: Math.max(
        0,
        this.reactionRequest.remainingMs(),
        this.displayRemainingMs(self?.reactionExpiresAtTick ?? 0),
      ),
      available: this.state === 'playing' && this.inputEnabled && !this.stalled,
    };
  }

  animationStatus() {
    this.animationRequest.expire(performance.now());
    const player = this.room?.state?.players?.get(this.room.sessionId);
    const presentation =
      player && this.animationBuffer.sample(player.entityId, this.room!.clock.serverNow());
    const playback = presentation?.animation;
    const definition = findAnimation(playback?.animationId);
    const busy =
      !!definition &&
      !!playback &&
      playback.displayTick <
        Math.max(
          playback.startedAtTick + (definition.cooldownMs * TICK_RATE) / 1000,
          playback.endsAtTick,
        );
    const state = player && this.simulation ? this.physics?.getState() : undefined;
    return {
      available: this.state === 'playing' && this.inputEnabled && !this.stalled,
      pending: !!this.animationRequest.pending,
      accepted: this.animationRequest.accepted,
      busy,
      grounded: state?.grounded ?? false,
      moving: this.animationMoving || (!!state && isPlayerMoving(state.velocity)),
      paused: this.persistencePaused,
      message: this.animationRequest.message,
    };
  }
  animate(animationId: AnimationId): void {
    const status = this.animationStatus();
    const definition = findAnimation(animationId);
    if (
      !definition ||
      !status.available ||
      status.pending ||
      status.busy ||
      status.paused ||
      !status.grounded ||
      (definition.mode === 'fullBody' && status.moving) ||
      document.hidden
    )
      return;
    const player = this.room!.state.players.get(this.room!.sessionId)!;
    this.actionId++;
    this.animationRequest.begin(
      this.actionId,
      animationId,
      player.animationSequence,
      performance.now(),
    );
    this.save();
    this.room!.send('requestAnimation', {
      requestId: this.actionId,
      worldEpoch: this.info.worldEpoch,
      animationId,
    } satisfies AnimationRequest);
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
    this.reactionRequest.begin(this.actionId, 5000, () => {
      this.onNotice('Ответ на реакцию не получен. Проверьте связь и попробуйте снова.');
    });
    this.save();
    this.room!.send('requestReaction', {
      requestId: this.actionId,
      worldEpoch: this.info.worldEpoch,
      reactionId,
    } satisfies ReactionRequest);
  }
  chatStatus(): { pending: boolean; remainingMs: number; available: boolean } {
    const self = this.room?.state?.players?.get(this.room.sessionId);
    return {
      pending: this.chatRequest.pending,
      remainingMs: Math.max(
        0,
        this.chatRequest.remainingMs(),
        this.displayRemainingMs(self?.chatExpiresAtTick ?? 0),
      ),
      available:
        this.state === 'playing' && this.inputEnabled && !this.stalled && !this.persistencePaused,
    };
  }

  sendChat(value: string): boolean {
    const status = this.chatStatus();
    const text = normalizeChatText(value);
    const command = text?.startsWith('/');
    if (
      !status.available ||
      status.pending ||
      (!command && status.remainingMs > 0) ||
      !text ||
      document.hidden
    )
      return false;
    this.actionId++;
    this.pendingChatCommand = !!command;
    this.chatRequest.begin(this.actionId, 5000, () => {
      this.onNotice('Ответ на сообщение не получен. Проверьте связь и попробуйте снова.');
    });
    this.save();
    this.room!.send('requestChat', {
      requestId: this.actionId,
      worldEpoch: this.info.worldEpoch,
      text,
    } satisfies ChatRequest);
    return true;
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
    this.respawnRequest.begin(this.actionId, 21000, () => {
      this.onNotice('Ответ на возврат не получен. Проверьте связь и попробуйте снова.');
    });
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
    this.worldSounds.clear();
    this.pendingSpawnSound = false;
    this.liveItemOperation = undefined;
    this.cancelPhysicsPreparation();
    this.respawnRequest.cancel();
    this.reactionRequest.cancel();
    this.animationRequest.clear();
    this.animationBuffer.clear();
    this.animationMoving = false;
    this.chatRequest.cancel();
    this.inventory = { slots: [] };
    this.itemOperation.reset();
    this.staticOperation.reset();
    this.openedStaticActions.clear();
    this.switchingPublication = false;
    this.publicationTask = undefined;
    this.publicationTarget = undefined;
    this.persistencePaused = false;
    this.setDayClock(DEFAULT_DAY_CLOCK);
    this.onInventoryChange?.();
    this.respawnRequest.reset();
    this.reactionRequest.reset();
    this.chatRequest.reset();
    if (!preserveRecovery) this.stopRecoveryCheck();
    this.predictor?.dispose();
    this.predictor = undefined;
    this.simulation = undefined;
    this.input = undefined;
    this.room = undefined;
    this.preparationConfirmed = false;
    this.physics?.clear();
    if (this.visualArea)
      this.streamer?.setPreview(this.visualArea.center, this.visualArea.drawRadius);
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
      areaWaiting: this.areaWaiting || !!this.plan,
      areaProblem: this.areaProblem,
      waitingTarget: this.waitingTarget,
      publication: {
        mapVersion: this.info?.mapVersion,
        layoutRevision: this.info?.layoutRevision,
        layoutHash: this.info?.layoutHash,
      },
      staticPlacementPending: this.staticOperation.current,
      plan: this.plan,
      areaResults: this.planResults.slice(),
      streaming: this.streamer?.diagnostics(),
      physics: this.physics?.staticDiagnostics() ?? {
        entities: 0,
        references: 0,
        buildings: { instances: 0, assets: 0, shapes: 0, references: 0 },
        bodies: 0,
        items: 0,
        remotePlayers: 0,
      },
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
      reaction: this.reactionStatus(),
      animation: this.animationStatus(),
      animationBuffers: this.animationBuffer.size,
      displayAnimations: room?.state?.players
        ? Array.from(room.state.players.values(), (player) => ({
            entityId: player.entityId,
            ...this.animationBuffer.sample(
              player.entityId,
              this.animationDisplayTime(player === self),
            )?.animation,
          }))
        : [],
      chat: this.chatStatus(),
      mapVersion: this.info?.mapVersion,
      simulationConfigHash: this.info?.simulationConfigHash,
      authoritative: self ? toPlayerState(self) : null,
      predicted: self && this.simulation ? this.physics?.getState() : null,
      trackedEntities: [...this.trackedEntities.keys()],
      remotePoses: this.predictor
        ? [...this.trackedEntities.values()]
            .filter((entity) => entity.entityId !== self?.entityId)
            .map((entity) => ({ entityId: entity.entityId, position: this.remotePose(entity) }))
        : [],
      items: room?.state?.items ? Array.from(room.state.items.values(), toItemState) : [],
      inventory: this.inventory,
      itemPending: !!this.itemOperation.current,
      storagePaused: this.persistencePaused,
      entities: room?.state?.players ? Array.from(room.state.players.values(), toPlayerState) : [],
    };
  }
  dispose(): void {
    this.generation++;
    this.cleanup();
    this.streamer?.dispose();
    this.physics?.dispose();
    this.resources?.dispose();
  }
}
