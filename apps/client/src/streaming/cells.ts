import {
  canonicalJson,
  worldPublicationBaseIdentity,
  changedWorldPublicationCells,
  loadCellPhysics,
  loadWorldCell,
  worldNeighborhood,
  worldCellBounds,
  cellsIntersectingCircle,
  distanceToBoundsXZ,
  type BuildingInstance,
  type BuildingPhysicsAsset,
  type LocalStaticSet,
  type StaticEntityDefinition,
  type Vec3,
  type WorldManifest,
  type WorldCell,
} from '@su/contracts';
import { VerifiedResources } from './resources';

/** Detach a cancelled generation even when a model loader finishes after abort. */
function preparedModels(pending: Promise<() => void>, signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let cancelled = signal.aborted;
    const abort = () => {
      cancelled = true;
      reject(new DOMException('Preparation cancelled', 'AbortError'));
    };
    if (cancelled) abort();
    else signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (release) => {
        signal.removeEventListener('abort', abort);
        if (cancelled) release();
        else resolve(release);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

type StaticItem = StaticEntityDefinition | BuildingInstance;
export interface CellPhysics {
  retainStatic(item: StaticItem, version: string, asset?: BuildingPhysicsAsset): void;
  releaseStatic(id: string): void;
}
export interface CellGraphics {
  activateCell?(cell: WorldCell): () => void;
  prepareCellAssets(
    manifest: WorldManifest,
    ids: string[],
    read: (path: string, signal?: AbortSignal) => Promise<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<() => void>;
  retainStatic(item: StaticItem, version: string): void;
  releaseStatic(id: string): void;
}
type PublicationContext = Readonly<{ manifest: WorldManifest; resources: VerifiedResources }>;
type Transition = {
  context: PublicationContext;
  changed: Set<string>;
  cells?: Map<string, Cell>;
  controller: AbortController;
  resolve: () => void;
  reject: (error: unknown) => void;
  startedAt: number;
  preparationMs?: number;
};
type Cell = {
  id: string;
  controller: AbortController;
  set?: LocalStaticSet;
  physicsLoaded?: boolean;
  physicsBytes?: number;
  physicsController?: AbortController;
  graphicsController?: AbortController;
  loading: boolean;
  releaseModels?: () => void;
  releaseDecoration?: () => void;
  physics: Set<string>;
  graphics: Set<string>;
  physicsReleaseAt?: number;
  graphicsReleaseAt?: number;
  operations?: Generator<void>;
  releasing?: boolean;
  error?: string;
  startedAt: number;
  preparedMs?: number;
};
export const STREAMING_LIMITS = {
  http: 4,
  preparations: 4,
  frameMs: 2,
  preparationFrameMs: 6,
  releaseMs: 5000,
  cacheBytes: 64 * 1024 * 1024,
  // The manifest validates the finite grid; even the entire 256-cell reference is legal.
  requiredCells: 10_000,
  // Modular fences increase the full ring-block to ~3,750 unique objects. Keep a
  // bounded budget that also permits previewing a valid 10,000-placement layout
  // plus its fixed ground tiles and boundary primitives.
  staticEntities: 16_384,
} as const;
export function cellNeighborhood(manifest: WorldManifest, position: Vec3): string[] {
  return worldNeighborhood(manifest.bounds, manifest.grid, position);
}
export function cellDistance(manifest: WorldManifest, id: string, position: Vec3): number {
  return distanceToBoundsXZ(position, worldCellBounds(manifest.bounds, manifest.grid, id));
}
export function circularCells(manifest: WorldManifest, center: Vec3, radius: number): string[] {
  return cellsIntersectingCircle(manifest.bounds, manifest.grid, center, radius);
}

/** Independent graphics/physics pins. Only pump() mutates scenes, between fixed steps. */
export class CellStreamer {
  private readonly cells = new Map<string, Cell>();
  private critical = new Set<string>();
  private physicsWanted = new Set<string>();
  private graphicsWanted = new Set<string>();
  private readonly entities = new Map<string, number>();
  private historyRequired: string[] = [];
  private visual?: { center: Vec3; radius: number };
  private visualExplicit = false;
  private disposed = false;
  private terminalError?: string;
  private cleanupErrors = 0;
  private preparing = 0;
  private generation = 0;
  private context: PublicationContext;
  private pendingTransition?: Transition;
  private lastTransition?: { preparationMs: number; swapMs: number; changedCells: string[] };
  private peakOperationMs = 0;
  private peakPumpMs = 0;
  private readonly samples: { cellId: string; action: 'connect' | 'release'; ms: number }[] = [];
  constructor(
    manifest: WorldManifest,
    resources: VerifiedResources,
    private readonly physics: CellPhysics,
    private readonly graphics: CellGraphics,
    private readonly clock = () => performance.now(),
  ) {
    this.context = Object.freeze({ manifest, resources });
  }
  get manifest() {
    return this.context.manifest;
  }
  get resources() {
    return this.context.resources;
  }
  get failed() {
    return this.terminalError !== undefined;
  }
  get transitioning() {
    return !!this.pendingTransition;
  }
  get transitionChangedCellIds(): string[] {
    return [...(this.pendingTransition?.changed ?? [])];
  }

  /** Prepare a new immutable context; pump() applies its ownership delta between physics steps. */
  transition(manifest: WorldManifest, resources: VerifiedResources): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Cell streamer disposed'));
    if (this.pendingTransition)
      return Promise.reject(new Error('Publication transition already active'));
    if (resources.manifest !== manifest)
      return Promise.reject(new Error('Resource context mismatch'));
    if (
      canonicalJson(worldPublicationBaseIdentity(manifest)) !==
      canonicalJson(worldPublicationBaseIdentity(this.manifest))
    )
      return Promise.reject(new Error('Incompatible live publication'));
    const changed = new Set(changedWorldPublicationCells(this.manifest, manifest));
    this.generation++;
    this.preparing = 0;
    // Every async continuation captures its immutable context and generation. Old partial
    // preparations and suspended release generators can never mutate the transferred cells.
    for (const cell of this.cells.values()) {
      cell.controller.abort();
      cell.operations?.return(undefined);
      cell.operations = undefined;
      cell.releasing = false;
      cell.loading = false;
      cell.controller = new AbortController();
      cell.physicsController = undefined;
      cell.graphicsController = undefined;
    }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const completion = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const transition: Transition = {
      context: Object.freeze({ manifest, resources }),
      changed,
      controller: new AbortController(),
      resolve,
      reject,
      startedAt: this.clock(),
    };
    this.transitionPrepared = false;
    this.pendingTransition = transition;
    void this.prepareTransition(transition).catch((error: unknown) => {
      this.cancelTransition(error, transition);
    });
    return completion;
  }
  /** Leaving cancels preparation, retaining the coherent previous publication for preview. */
  cancelTransition(
    reason: unknown = new DOMException('Publication transition cancelled', 'AbortError'),
    expected = this.pendingTransition,
  ): void {
    const transition = this.pendingTransition;
    if (!transition || transition !== expected) return;
    this.pendingTransition = undefined;
    this.transitionPrepared = false;
    transition.controller.abort();
    for (const cell of transition.cells?.values() ?? [])
      if (transition.changed.has(cell.id)) {
        const release = cell.releaseModels;
        cell.releaseModels = undefined;
        try {
          release?.();
        } catch {
          this.cleanupErrors++;
        }
      }
    try {
      transition.context.resources.dispose();
    } catch {
      this.cleanupErrors++;
    }
    transition.reject(reason);
    this.refresh();
  }
  private async prepareTransition(transition: Transition): Promise<void> {
    const { manifest, resources } = transition.context;
    const modelResources = this.context.resources;
    const signal = transition.controller.signal;
    const cells = new Map<string, Cell>();
    transition.cells = cells;
    // Keep model pins of the old generation until every replacement has acquired its pins.
    // Bounded concurrency avoids turning a city transition into hundreds of active loaders.
    const pending = [...this.cells.values()]
      .filter((cell) => !!cell.set)
      .sort((a, b) => this.priority(a) - this.priority(b));
    const heldVersions = new Set(
      [...this.cells.values()].flatMap((cell) =>
        cell.releaseModels
          ? this.manifest.cells
              .find((entry) => entry.cellId === cell.id)!
              .assetIds.map((id) => this.manifest.assets[id].version)
          : [],
      ),
    );
    let index = 0;
    const prepare = async () => {
      while (index < pending.length) {
        const old = pending[index++];
        if (signal.aborted || this.pendingTransition !== transition)
          throw new DOMException('Cancelled', 'AbortError');
        if (!transition.changed.has(old.id)) {
          cells.set(old.id, {
            ...old,
            controller: new AbortController(),
            operations: undefined,
            physicsController: undefined,
            graphicsController: undefined,
            loading: false,
            releasing: false,
          });
          continue;
        }
        const cell: Cell = {
          ...old,
          controller: new AbortController(),
          operations: undefined,
          physicsController: undefined,
          graphicsController: undefined,
          loading: false,
          releasing: false,
          error: undefined,
          set: undefined,
          releaseModels: undefined,
          releaseDecoration: undefined,
          physics: new Set(),
          graphics: new Set(),
          physicsLoaded: false,
          physicsBytes: 0,
        };
        cells.set(old.id, cell);
        const read = (path: string, requestSignal?: AbortSignal) =>
          resources.read(
            path,
            requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
            this.priority(old),
          );
        const loaded = await loadWorldCell(manifest, old.id, (path) => read(path));
        cell.set = { cell: loaded, buildingAssets: {} };
        if (old.physicsLoaded || this.physicsWanted.has(old.id)) {
          await resources.prefetchPhysics(old.id, signal, this.priority(old));
          const set = await loadCellPhysics(manifest, old.id, (path) => read(path), loaded);
          cell.set = set;
          cell.physicsLoaded = true;
          cell.physicsBytes = new TextEncoder().encode(
            JSON.stringify(set.buildingAssets),
          ).byteLength;
          if (old.physics.size || this.physicsWanted.has(old.id))
            cell.physics = new Set(
              [...loaded.statics, ...loaded.buildings].map((item) => item.entityId),
            );
        }
        if (old.releaseModels || this.graphicsWanted.has(old.id)) {
          // Already pinned models have parsed/GPU resources even if their raw bytes left
          // the LRU. Retain them directly instead of downloading a changed pack for them.
          const descriptor = manifest.cells.find((entry) => entry.cellId === old.id)!;
          if (descriptor.assetIds.some((id) => !heldVersions.has(manifest.assets[id].version)))
            await resources.prefetchGraphics(old.id, signal, this.priority(old));
          const release = await preparedModels(
            this.graphics.prepareCellAssets(
              manifest,
              manifest.cells.find((entry) => entry.cellId === old.id)!.assetIds,
              // Base models can acquire an ordinary old-context consumer during
              // staging. New/changed generated supports belong to the next context.
              (path, modelSignal) => {
                const owner =
                  Object.hasOwn(modelResources.manifest.files, path) &&
                  modelResources.manifest.files[path] === manifest.files[path]
                    ? modelResources
                    : resources;
                return owner.read(path, modelSignal ?? signal, this.priority(old));
              },
              signal,
            ),
            signal,
          );
          if (signal.aborted || this.pendingTransition !== transition) {
            release();
            throw new DOMException('Cancelled', 'AbortError');
          }
          cell.releaseModels = release;
          cell.graphics = new Set(
            [...loaded.statics, ...loaded.buildings].map((item) => item.entityId),
          );
        }
      }
    };
    const results = await Promise.allSettled(
      Array.from({ length: STREAMING_LIMITS.preparations }, async () => {
        try {
          await prepare();
        } catch (error) {
          transition.controller.abort();
          throw error;
        }
      }),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (signal.aborted || this.pendingTransition !== transition)
      throw new DOMException('Cancelled', 'AbortError');
    const signatures = new Map<string, string>();
    for (const cell of cells.values())
      for (const item of [...cell.set!.cell.statics, ...cell.set!.cell.buildings]) {
        const signature = canonicalJson(item);
        const previous = signatures.get(item.entityId);
        if (previous !== undefined && previous !== signature)
          throw new Error(`Conflicting static cell references: ${item.entityId}`);
        signatures.set(item.entityId, signature);
      }
    // This flag is set only after all asynchronous work; the actual scene swap is synchronous.
    transition.preparationMs = this.clock() - transition.startedAt;
    this.transitionPrepared = true;
  }
  private transitionPrepared = false;
  private applyTransition(): void {
    const transition = this.pendingTransition;
    if (!transition || !this.transitionPrepared || !transition.cells) return;
    const startedAt = this.clock();
    const previous = this.context;
    const next = transition.cells;
    // An unchanged critical area may finish loading while distant replacement graphics
    // are pending. Transfer its latest ownership, rather than the preparation snapshot.
    this.generation++;
    this.preparing = 0;
    for (const [id] of next)
      if (!transition.changed.has(id) && !this.cells.has(id)) next.delete(id);
    for (const cell of this.cells.values()) {
      cell.controller.abort();
      cell.operations?.return(undefined);
      cell.operations = undefined;
      cell.loading = false;
      if (!transition.changed.has(cell.id) && cell.set)
        next.set(cell.id, {
          ...cell,
          controller: new AbortController(),
          physicsController: undefined,
          graphicsController: undefined,
          operations: undefined,
          loading: false,
          releasing: false,
        });
    }
    type Reference = {
      count: number;
      item: StaticItem;
      asset?: BuildingPhysicsAsset;
      version: string;
    };
    const references = (
      cells: Iterable<Cell>,
      context: PublicationContext,
      channel: 'physics' | 'graphics',
    ) => {
      const result = new Map<string, Reference>();
      for (const cell of cells)
        for (const item of [...cell.set!.cell.statics, ...cell.set!.cell.buildings]) {
          if (!cell[channel].has(item.entityId)) continue;
          const building = 'assetId' in item;
          const ref = result.get(item.entityId);
          if (ref) ref.count++;
          else
            result.set(item.entityId, {
              count: 1,
              item,
              version: building ? context.manifest.assets[item.assetId].version : 'primitive-v1',
              asset: building ? cell.set!.buildingAssets[item.assetId] : undefined,
            });
        }
      return result;
    };
    // Cell ownership still describes the old publication until the final pointer switch.
    // Journal successful mutations separately so a failed swap can release both old and
    // newly acquired references once, without ever replaying a partially applied delta.
    const previousCells = [...this.cells.values()];
    const held = { physics: new Map<string, number>(), graphics: new Map<string, number>() };
    for (const channel of ['physics', 'graphics'] as const)
      for (const cell of previousCells)
        for (const id of cell[channel]) held[channel].set(id, (held[channel].get(id) ?? 0) + 1);
    const record = (channel: 'physics' | 'graphics', id: string, delta: number) => {
      const count = (held[channel].get(id) ?? 0) + delta;
      if (count) held[channel].set(id, count);
      else held[channel].delete(id);
      this.count(id, delta);
    };
    try {
      for (const channel of ['physics', 'graphics'] as const) {
        const before = references(
          previousCells.filter((cell) => !!cell.set && transition.changed.has(cell.id)),
          previous,
          channel,
        );
        const after = references(
          [...next.values()].filter((cell) => transition.changed.has(cell.id)),
          transition.context,
          channel,
        );
        const target = channel === 'physics' ? this.physics : this.graphics;
        const different = (a: Reference, b: Reference) =>
          a.version !== b.version || canonicalJson(a.item) !== canonicalJson(b.item);
        for (const [id, old] of before) {
          const replacement = after.get(id);
          if (!replacement || different(old, replacement))
            for (let n = 0; n < old.count; n++) {
              target.releaseStatic(id);
              record(channel, id, -1);
            }
        }
        // Equal signatures acquire extra memberships before releasing old memberships.
        for (const [id, value] of after) {
          const old = before.get(id);
          const retained = old && !different(old, value) ? old.count : 0;
          for (let n = retained; n < value.count; n++) {
            if (channel === 'physics')
              this.physics.retainStatic(value.item, value.version, value.asset);
            else this.graphics.retainStatic(value.item, value.version);
            record(channel, id, 1);
          }
        }
        for (const [id, old] of before) {
          const replacement = after.get(id);
          if (replacement && !different(old, replacement))
            for (let n = replacement.count; n < old.count; n++) {
              target.releaseStatic(id);
              record(channel, id, -1);
            }
        }
      }
      for (const cell of previousCells)
        if (transition.changed.has(cell.id)) {
          const releaseDecoration = cell.releaseDecoration;
          cell.releaseDecoration = undefined;
          releaseDecoration?.();
          const releaseModels = cell.releaseModels;
          cell.releaseModels = undefined;
          releaseModels?.();
        }
      this.cells.clear();
      for (const [id, cell] of next) this.cells.set(id, cell);
      this.context = transition.context;
      previous.resources.dispose();
      this.lastTransition = {
        preparationMs: transition.preparationMs ?? 0,
        swapMs: this.clock() - startedAt,
        changedCells: [...transition.changed],
      };
      this.transitionPrepared = false;
      this.pendingTransition = undefined;
      this.refresh();
      transition.resolve();
    } catch (error) {
      this.terminalError = String(error);
      this.disposed = true;
      this.generation++;
      this.pendingTransition = undefined;
      this.transitionPrepared = false;
      transition.controller.abort();
      const clean = (release: () => void) => {
        try {
          release();
        } catch {
          this.cleanupErrors++;
        }
      };
      for (const cell of [...previousCells, ...this.cells.values(), ...next.values()]) {
        cell.controller.abort();
        clean(() => {
          cell.operations?.return(undefined);
        });
      }
      for (const channel of ['physics', 'graphics'] as const) {
        const target = channel === 'physics' ? this.physics : this.graphics;
        for (const [id, count] of held[channel])
          for (let n = 0; n < count; n++) clean(() => target.releaseStatic(id));
      }
      const releases = new Set<() => void>();
      for (const cell of [
        ...previousCells,
        ...[...next.values()].filter((cell) => transition.changed.has(cell.id)),
      ]) {
        if (cell.releaseDecoration) releases.add(cell.releaseDecoration);
        if (cell.releaseModels) releases.add(cell.releaseModels);
        cell.releaseDecoration = undefined;
        cell.releaseModels = undefined;
        cell.physics.clear();
        cell.graphics.clear();
      }
      for (const release of releases) clean(release);
      clean(() => previous.resources.dispose());
      clean(() => transition.context.resources.dispose());
      this.critical.clear();
      this.physicsWanted.clear();
      this.graphicsWanted.clear();
      this.cells.clear();
      this.entities.clear();
      transition.reject(error);
    }
  }

  setArea(
    authoritative: Vec3,
    predicted = authoritative,
    historyCells: Iterable<string> = [],
  ): void {
    if (this.disposed) throw new Error('Cell streamer disposed');
    this.historyRequired = [...new Set(historyCells)];
    this.critical = new Set([
      ...cellNeighborhood(this.manifest, authoritative),
      ...cellNeighborhood(this.manifest, predicted),
      ...this.historyRequired,
    ]);
    for (const id of this.critical)
      if (!this.manifest.cells.some((cell) => cell.cellId === id))
        throw new Error(`Unknown history cell: ${id}`);
    const next = new Set([
      ...this.critical,
      ...circularCells(this.manifest, authoritative, 500),
      ...circularCells(this.manifest, predicted, 500),
    ]);
    for (const id of this.physicsWanted)
      if (
        Math.min(
          cellDistance(this.manifest, id, authoritative),
          cellDistance(this.manifest, id, predicted),
        ) <= 800
      )
        next.add(id);
    this.physicsWanted = next;
    this.setVisualArea(
      this.visualExplicit ? this.visual!.center : predicted,
      this.visualExplicit ? this.visual!.radius : 500,
      false,
    );
  }
  /** Replace preparation pins without carrying old-area hysteresis into a new server plan. */
  setPreparationArea(center: Vec3): void {
    this.physicsWanted.clear();
    this.graphicsWanted.clear();
    if (this.visual) this.visual = { ...this.visual, center: { ...center } };
    this.setArea(center);
  }
  /** The preview has no physics, player reservation or network lifecycle. */
  setPreview(center: Vec3, drawRadius = 500): void {
    this.critical.clear();
    this.physicsWanted.clear();
    this.historyRequired = [];
    this.setVisualArea(center, drawRadius);
  }
  setVisualArea(center: Vec3, drawRadius: number, explicit = true): void {
    if (explicit) this.visualExplicit = true;
    if (this.disposed) return;
    this.visual = { center: { ...center }, radius: Math.max(125, drawRadius) };
    const next = new Set([
      ...this.critical,
      ...circularCells(this.manifest, center, this.visual.radius + 125),
    ]);
    for (const id of this.graphicsWanted)
      if (cellDistance(this.manifest, id, center) <= this.visual.radius + 300) next.add(id);
    this.graphicsWanted = next;
    this.refresh();
  }
  private refresh() {
    const wanted = new Set([...this.critical, ...this.physicsWanted, ...this.graphicsWanted]);
    if (wanted.size > STREAMING_LIMITS.requiredCells)
      throw new Error('Required cell budget exceeded');
    const now = this.clock();
    for (const id of wanted)
      if (!this.cells.has(id))
        this.cells.set(id, {
          id,
          controller: new AbortController(),
          loading: false,
          physics: new Set(),
          graphics: new Set(),
          startedAt: now,
        });
    for (const cell of this.cells.values()) {
      if (!this.physicsWanted.has(cell.id)) cell.physicsController?.abort();
      if (!this.graphicsWanted.has(cell.id)) cell.graphicsController?.abort();
      // Joining may promote a still-loading graphical preview to critical physics.
      if (this.physicsWanted.has(cell.id) && !cell.physicsLoaded) cell.graphicsController?.abort();
      if (this.physicsWanted.has(cell.id)) cell.physicsReleaseAt = undefined;
      else cell.physicsReleaseAt ??= now + STREAMING_LIMITS.releaseMs;
      if (this.graphicsWanted.has(cell.id)) cell.graphicsReleaseAt = undefined;
      else cell.graphicsReleaseAt ??= now + STREAMING_LIMITS.releaseMs;
      if (!wanted.has(cell.id) && cell.loading && !cell.physics.size && !cell.graphics.size)
        cell.controller.abort();
    }
    this.schedule();
  }
  private priority(cell: Cell): number {
    return (
      (this.critical.has(cell.id) ? -1e9 : 0) +
      (this.visual ? cellDistance(this.manifest, cell.id, this.visual.center) : 0)
    );
  }
  private schedule() {
    if (this.disposed) return;
    const pending = [...this.cells.values()]
      .filter(
        (cell) =>
          (!this.pendingTransition ||
            (this.critical.has(cell.id) && !this.pendingTransition.changed.has(cell.id))) &&
          !cell.error &&
          !cell.loading &&
          !cell.controller.signal.aborted &&
          ((!cell.set && (this.physicsWanted.has(cell.id) || this.graphicsWanted.has(cell.id))) ||
            (cell.set && !cell.releaseModels && this.graphicsWanted.has(cell.id)) ||
            (cell.set && !cell.physicsLoaded && this.physicsWanted.has(cell.id))),
      )
      .sort((a, b) => this.priority(a) - this.priority(b));
    for (const cell of pending) {
      if (this.preparing >= STREAMING_LIMITS.preparations) break;
      // A stalled background GLB must never occupy every preparation slot on a new plan.
      const background = [...this.cells.values()].filter(
        (candidate) => candidate.loading && !this.critical.has(candidate.id),
      ).length;
      if (!this.critical.has(cell.id) && background >= STREAMING_LIMITS.preparations - 1) continue;
      cell.loading = true;
      this.preparing++;
      void this.prepare(cell);
    }
  }
  private async prepare(cell: Cell) {
    const signal = cell.controller.signal;
    const context = this.context,
      generation = this.generation;
    const valid = () =>
      !this.disposed &&
      this.generation === generation &&
      !signal.aborted &&
      this.cells.get(cell.id) === cell;
    try {
      const read = (path: string, requestSignal?: AbortSignal) =>
        context.resources.read(path, requestSignal ?? signal, this.priority(cell));
      if (!cell.set) {
        const loaded = await loadWorldCell(context.manifest, cell.id, (path) => read(path));
        if (!valid()) return;
        cell.set = { cell: loaded, buildingAssets: {} };
      }
      if (this.physicsWanted.has(cell.id) && !cell.physicsLoaded) {
        const controller = new AbortController();
        cell.physicsController = controller;
        const physicsSignal = AbortSignal.any([signal, controller.signal]);
        try {
          await context.resources.prefetchPhysics(cell.id, physicsSignal, this.priority(cell));
          const set = await loadCellPhysics(
            context.manifest,
            cell.id,
            (path) => read(path, physicsSignal),
            cell.set.cell,
          );
          if (!valid()) return;
          if (this.physicsWanted.has(cell.id)) {
            cell.set.buildingAssets = set.buildingAssets;
            cell.physicsLoaded = true;
            cell.physicsBytes = new TextEncoder().encode(
              JSON.stringify(set.buildingAssets),
            ).byteLength;
          }
        } catch (error) {
          if (!controller.signal.aborted || this.physicsWanted.has(cell.id)) throw error;
        } finally {
          if (cell.physicsController === controller) cell.physicsController = undefined;
        }
      }
      if (this.graphicsWanted.has(cell.id) && !cell.releaseModels) {
        const controller = new AbortController();
        cell.graphicsController = controller;
        const graphicsSignal = AbortSignal.any([signal, controller.signal]);
        try {
          const descriptor = context.manifest.cells.find((item) => item.cellId === cell.id)!;
          await context.resources.prefetchGraphics(cell.id, graphicsSignal, this.priority(cell));
          if (!valid() || graphicsSignal.aborted) return;
          const release = await preparedModels(
            this.graphics.prepareCellAssets(
              context.manifest,
              descriptor.assetIds,
              read,
              graphicsSignal,
            ),
            graphicsSignal,
          );
          if (!valid() || controller.signal.aborted || !this.graphicsWanted.has(cell.id)) {
            release();
            return;
          }
          cell.releaseModels = release;
        } catch (error) {
          // Promotion to physics or replacement can cancel graphics while the cell stays alive.
          if (!controller.signal.aborted) throw error;
        } finally {
          if (cell.graphicsController === controller) cell.graphicsController = undefined;
        }
      }
    } catch (error) {
      if (valid()) cell.error = String(error);
    } finally {
      if (this.generation === generation) {
        cell.loading = false;
        this.preparing--;
        this.schedule();
      }
    }
  }
  private count(id: string, delta: number) {
    const count = (this.entities.get(id) ?? 0) + delta;
    if (count > 0) this.entities.set(id, count);
    else this.entities.delete(id);
  }
  private *reconcile(cell: Cell): Generator<void> {
    const set = cell.set;
    if (!set) return;
    for (const item of [...set.cell.statics, ...set.cell.buildings]) {
      const id = item.entityId;
      const building = 'assetId' in item;
      const version = building ? this.manifest.assets[item.assetId].version : 'primitive-v1';
      if (
        !cell.error &&
        cell.physicsLoaded &&
        this.physicsWanted.has(cell.id) &&
        !cell.physics.has(id)
      ) {
        if (!this.entities.has(id) && this.entities.size >= STREAMING_LIMITS.staticEntities)
          throw new Error('Required static content budget exceeded');
        this.physics.retainStatic(
          item,
          version,
          building ? set.buildingAssets[item.assetId] : undefined,
        );
        cell.physics.add(id);
        this.count(id, 1);
        yield;
      }
      if (
        !cell.error &&
        this.graphicsWanted.has(cell.id) &&
        cell.releaseModels &&
        !cell.graphics.has(id)
      ) {
        if (!this.entities.has(id) && this.entities.size >= STREAMING_LIMITS.staticEntities)
          throw new Error('Required static content budget exceeded');
        this.graphics.retainStatic(item, version);
        cell.graphics.add(id);
        this.count(id, 1);
        yield;
      }
      if (
        (cell.error ||
          (!this.physicsWanted.has(cell.id) &&
            (cell.physicsReleaseAt ?? Infinity) <= this.clock())) &&
        cell.physics.delete(id)
      ) {
        this.physics.releaseStatic(id);
        this.count(id, -1);
        yield;
      }
      if (
        (cell.error ||
          (!this.graphicsWanted.has(cell.id) &&
            (cell.graphicsReleaseAt ?? Infinity) <= this.clock())) &&
        cell.graphics.delete(id)
      ) {
        this.graphics.releaseStatic(id);
        this.count(id, -1);
        yield;
      }
    }
    this.releasePhysicsData(cell);
    if (this.graphicsReady(cell) && this.manifest.cells.length === 1 && !cell.releaseDecoration)
      cell.releaseDecoration = this.graphics.activateCell?.(set.cell);
    if (!cell.graphics.size && (!this.graphicsWanted.has(cell.id) || cell.error)) {
      cell.releaseDecoration?.();
      cell.releaseDecoration = undefined;
      cell.releaseModels?.();
      cell.releaseModels = undefined;
    }
    if (this.physicsReady(cell) && this.graphicsReady(cell))
      cell.preparedMs ??= this.clock() - cell.startedAt;
  }
  private releaseDue(cell: Cell, now: number): boolean {
    return (
      !!(cell.error && (cell.physics.size || cell.graphics.size || cell.releaseModels)) ||
      (!this.physicsWanted.has(cell.id) &&
        cell.physics.size > 0 &&
        (cell.physicsReleaseAt ?? Infinity) <= now) ||
      (!this.graphicsWanted.has(cell.id) &&
        (cell.graphics.size > 0 || !!cell.releaseModels) &&
        (cell.graphicsReleaseAt ?? Infinity) <= now)
    );
  }
  /** Releasing one ownership channel must not allocate another channel along the way. */
  private *releaseExpired(cell: Cell): Generator<void> {
    for (const id of [...cell.physics]) {
      if (
        !cell.error &&
        (this.physicsWanted.has(cell.id) || (cell.physicsReleaseAt ?? Infinity) > this.clock())
      )
        continue;
      this.physics.releaseStatic(id);
      cell.physics.delete(id);
      this.count(id, -1);
      yield;
    }
    for (const id of [...cell.graphics]) {
      if (
        !cell.error &&
        (this.graphicsWanted.has(cell.id) || (cell.graphicsReleaseAt ?? Infinity) > this.clock())
      )
        continue;
      this.graphics.releaseStatic(id);
      cell.graphics.delete(id);
      this.count(id, -1);
      yield;
    }
    if (
      !cell.graphics.size &&
      (cell.error ||
        (!this.graphicsWanted.has(cell.id) && (cell.graphicsReleaseAt ?? Infinity) <= this.clock()))
    ) {
      cell.releaseDecoration?.();
      cell.releaseDecoration = undefined;
      cell.releaseModels?.();
      cell.releaseModels = undefined;
    }
    this.releasePhysicsData(cell);
  }
  private releasePhysicsData(cell: Cell) {
    if (
      cell.set &&
      !cell.physics.size &&
      !this.physicsWanted.has(cell.id) &&
      (cell.physicsReleaseAt ?? Infinity) <= this.clock()
    ) {
      cell.set.buildingAssets = {};
      cell.physicsLoaded = false;
      cell.physicsBytes = 0;
    }
  }
  private physicsReady(cell: Cell): boolean {
    return (
      !!cell.set &&
      !!cell.physicsLoaded &&
      !cell.error &&
      cell.physics.size === cell.set.cell.statics.length + cell.set.cell.buildings.length
    );
  }
  private graphicsReady(cell: Cell): boolean {
    return (
      !!cell.set &&
      !!cell.releaseModels &&
      !cell.error &&
      cell.graphics.size === cell.set.cell.statics.length + cell.set.cell.buildings.length
    );
  }
  /** Spend a bounded share of a frame on preparation while movement is not yet active. */
  pumpFrame(deltaSeconds: number) {
    const preparing = this.critical.size === 0 || !this.criticalReady;
    const budget =
      preparing && Number.isFinite(deltaSeconds) && deltaSeconds > 0
        ? Math.min(
            STREAMING_LIMITS.preparationFrameMs,
            Math.max(STREAMING_LIMITS.frameMs, deltaSeconds * 1000 * 0.25),
          )
        : STREAMING_LIMITS.frameMs;
    this.pump(budget);
  }
  pump(budgetMs: number = STREAMING_LIMITS.frameMs) {
    if (this.disposed) return;
    this.applyTransition();
    if (this.disposed) return;
    // Keep distant replacement graphics coherent while unchanged critical areas continue
    // preparing as the character moves. Changed cells are owned exclusively by the stage.
    const start = this.clock();
    const needsWork = (cell: Cell) => {
      if (cell.operations) return true;
      if (!cell.set) return false;
      const count = cell.set.cell.statics.length + cell.set.cell.buildings.length;
      return (
        (cell.error && (cell.physics.size > 0 || cell.graphics.size > 0 || !!cell.releaseModels)) ||
        (!cell.error &&
          cell.physicsLoaded &&
          this.physicsWanted.has(cell.id) &&
          cell.physics.size < count) ||
        (!cell.error &&
          this.graphicsWanted.has(cell.id) &&
          !!cell.releaseModels &&
          cell.graphics.size < count) ||
        (!this.physicsWanted.has(cell.id) &&
          cell.physics.size > 0 &&
          (cell.physicsReleaseAt ?? Infinity) <= start) ||
        (!this.graphicsWanted.has(cell.id) &&
          (cell.graphics.size > 0 || !!cell.releaseModels) &&
          (cell.graphicsReleaseAt ?? Infinity) <= start)
      );
    };
    // Completed near cells must not consume the whole frame budget again: otherwise distant
    // prepared cells starve permanently on a detailed city even with an empty HTTP queue.
    const workPriority = (cell: Cell) =>
      this.critical.has(cell.id)
        ? -2e9 + this.priority(cell)
        : this.releaseDue(cell, start)
          ? -1e9 + this.priority(cell)
          : this.priority(cell);
    const preparingCritical = this.critical.size > 0 && !this.criticalReady;
    const work = [...this.cells.values()]
      .filter(
        (cell) =>
          (!this.pendingTransition ||
            (this.critical.has(cell.id) && !this.pendingTransition.changed.has(cell.id))) &&
          needsWork(cell) &&
          (!preparingCritical || this.critical.has(cell.id) || this.releaseDue(cell, start)),
      )
      .sort((a, b) => workPriority(a) - workPriority(b));
    outer: for (const cell of work) {
      if (this.releaseDue(cell, start) && !cell.releasing) {
        // Preempt a suspended background connection after its ownership expired.
        cell.operations?.return(undefined);
        cell.operations = this.releaseExpired(cell);
        cell.releasing = true;
      }
      cell.operations ??= this.reconcile(cell);
      while (cell.operations) {
        const operationStart = this.clock();
        const action = cell.releasing ? 'release' : 'connect';
        try {
          if (cell.operations.next().done) {
            cell.operations = undefined;
            cell.releasing = false;
          }
        } catch (error) {
          cell.error = String(error);
          cell.operations = this.releaseExpired(cell);
          cell.releasing = true;
        }
        const ms = this.clock() - operationStart;
        this.peakOperationMs = Math.max(this.peakOperationMs, ms);
        this.samples.push({
          cellId: cell.id,
          action,
          ms,
        });
        if (this.samples.length > 4096) this.samples.shift();
        if (this.clock() - start >= budgetMs) break outer;
      }
    }
    for (const cell of this.cells.values()) {
      this.releasePhysicsData(cell);
      if (
        !cell.loading &&
        !cell.physics.size &&
        !cell.graphics.size &&
        !this.physicsWanted.has(cell.id) &&
        !this.graphicsWanted.has(cell.id)
      ) {
        cell.controller.abort();
        cell.releaseDecoration?.();
        cell.releaseModels?.();
        this.cells.delete(cell.id);
      } else if (cell.controller.signal.aborted && !cell.loading) this.cells.delete(cell.id);
    }
    this.peakPumpMs = Math.max(this.peakPumpMs, this.clock() - start);
    this.refresh();
  }
  retry() {
    for (const cell of this.cells.values())
      if (cell.error) {
        cell.error = undefined;
        cell.operations = undefined;
        cell.releasing = false;
      }
    this.schedule();
  }
  /** Background failures are diagnostic only; they cannot freeze a safe local character. */
  get problem(): string | undefined {
    return (
      this.terminalError ?? [...this.critical].map((id) => this.cells.get(id)?.error).find(Boolean)
    );
  }
  get backgroundProblem(): string | undefined {
    return [...this.cells.values()].map((cell) => cell.error).find(Boolean);
  }
  get criticalReady(): boolean {
    return (
      this.critical.size > 0 &&
      ![...this.critical].some((id) => this.pendingTransition?.changed.has(id)) &&
      [...this.critical].every((id) => {
        const cell = this.cells.get(id);
        return !!cell && this.physicsReady(cell) && this.graphicsReady(cell);
      })
    );
  }
  get ready(): boolean {
    return this.criticalReady;
  }
  get backgroundReady(): boolean {
    return (
      [...this.physicsWanted].every((id) => {
        const cell = this.cells.get(id);
        return !!cell && this.physicsReady(cell);
      }) &&
      [...this.graphicsWanted].every((id) => {
        const cell = this.cells.get(id);
        return !!cell && this.graphicsReady(cell);
      })
    );
  }
  graphicsReadyRadius(center: Vec3, targetRadius: number): number {
    let radius = targetRadius;
    for (const descriptor of this.manifest.cells) {
      const cell = this.cells.get(descriptor.cellId);
      if (!cell || !this.graphicsReady(cell))
        radius = Math.min(radius, cellDistance(this.manifest, descriptor.cellId, center));
    }
    return Math.max(0, radius);
  }
  diagnostics() {
    const releaseAt = (cell: Cell) =>
      (!this.physicsWanted.has(cell.id) && cell.physics.size ? cell.physicsReleaseAt : undefined) ??
      (!this.graphicsWanted.has(cell.id) && (cell.graphics.size || cell.releaseModels)
        ? cell.graphicsReleaseAt
        : undefined);
    const active = (cell: Cell) =>
      (!this.physicsWanted.has(cell.id) || this.physicsReady(cell)) &&
      (!this.graphicsWanted.has(cell.id) || this.graphicsReady(cell)) &&
      (this.physicsReady(cell) || this.graphicsReady(cell));
    return {
      failed: this.failed,
      cleanupErrors: this.cleanupErrors,
      lastTransition: this.lastTransition,
      transitioning: this.transitioning,
      changedCellIds: this.transitionChangedCellIds,
      ready: this.ready,
      criticalReady: this.criticalReady,
      backgroundReady: this.backgroundReady,
      parsedPhysicsCells: [...this.cells.values()].filter((cell) => cell.physicsLoaded).length,
      parsedCollisionBytes: [...this.cells.values()].reduce(
        (sum, cell) => sum + (cell.physicsBytes ?? 0),
        0,
      ),
      error: this.problem,
      required: [...this.critical],
      physicsRequired: [...this.physicsWanted],
      graphicsRequired: [...this.graphicsWanted],
      historyRequired: this.historyRequired,
      active: [...this.cells.values()].filter(active).map((cell) => cell.id),
      physicsActive: [...this.cells.values()]
        .filter((cell) => this.physicsReady(cell))
        .map((cell) => cell.id),
      graphicsActive: [...this.cells.values()]
        .filter((cell) => this.graphicsReady(cell))
        .map((cell) => cell.id),
      retained: [...this.cells.values()]
        .filter((cell) => !this.physicsWanted.has(cell.id) && !this.graphicsWanted.has(cell.id))
        .map((cell) => cell.id),
      requested: [...this.cells.values()].filter((cell) => cell.loading).map((cell) => cell.id),
      cells: [...this.cells.values()].map((cell) => ({
        id: cell.id,
        state: cell.error
          ? 'error'
          : cell.releasing
            ? 'releasing'
            : cell.operations
              ? 'prepared'
              : active(cell)
                ? 'active'
                : cell.loading
                  ? 'loading'
                  : releaseAt(cell) !== undefined
                    ? 'releasing'
                    : 'verified',
        references: cell.physics.size + cell.graphics.size,
        error: cell.error,
        releaseAt: releaseAt(cell),
        preparedMs: cell.preparedMs,
        physicsReady: this.physicsReady(cell),
        graphicsReady: this.graphicsReady(cell),
      })),
      entities: this.entities.size,
      references: [...this.entities.values()].reduce((a, b) => a + b, 0),
      peakOperationMs: this.peakOperationMs,
      peakPumpMs: this.peakPumpMs,
      operations: this.samples.slice(),
      resources: this.resources.diagnostics(),
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTransition(new DOMException('Cancelled', 'AbortError'));
    this.critical.clear();
    this.physicsWanted.clear();
    this.graphicsWanted.clear();
    for (const cell of this.cells.values()) {
      cell.controller.abort();
      cell.operations?.return(undefined);
      for (const id of cell.graphics) this.graphics.releaseStatic(id);
      for (const id of cell.physics) this.physics.releaseStatic(id);
      cell.releaseDecoration?.();
      cell.releaseModels?.();
    }
    this.cells.clear();
    this.entities.clear();
    this.resources.dispose();
  }
}
