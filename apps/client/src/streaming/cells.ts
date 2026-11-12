import {
  loadCellPhysics,
  worldNeighborhood,
  type BuildingInstance,
  type BuildingPhysicsAsset,
  type LocalStaticSet,
  type StaticEntityDefinition,
  type Vec3,
  type WorldManifest,
  type WorldCell,
} from '@su/contracts';
import { VerifiedResources } from './resources';

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
type Cell = {
  id: string;
  state: 'loading' | 'verified' | 'prepared' | 'active' | 'releasing' | 'error';
  controller: AbortController;
  set?: LocalStaticSet;
  releaseModels?: () => void;
  releaseDecoration?: () => void;
  connected: string[];
  operations?: Generator<void>;
  releaseAt?: number;
  error?: string;
  startedAt: number;
  preparedMs?: number;
};
export const STREAMING_LIMITS = {
  http: 4,
  frameMs: 2,
  releaseMs: 5000,
  cacheBytes: 64 * 1024 * 1024,
  requiredCells: 64,
  staticEntities: 2048,
} as const;

export function cellNeighborhood(manifest: WorldManifest, position: Vec3): string[] {
  return worldNeighborhood(manifest.bounds, manifest.grid, position);
}

/** Pure area selection + async preparation. pump() connects resources only between fixed steps. */
export class CellStreamer {
  private readonly cells = new Map<string, Cell>();
  private wanted = new Map<string, number>();
  private readonly entities = new Map<string, number>();
  private disposed = false;
  private budgetError?: string;
  private readonly samples: { cellId: string; action: 'connect' | 'release'; ms: number }[] = [];
  private peakOperationMs = 0;
  private peakPumpMs = 0;
  private historyRequired: string[] = [];
  constructor(
    readonly manifest: WorldManifest,
    readonly resources: VerifiedResources,
    private readonly physics: CellPhysics,
    private readonly graphics: CellGraphics,
    private readonly clock = () => performance.now(),
  ) {}

  setArea(
    authoritative: Vec3,
    predicted = authoritative,
    historyCells: Iterable<string> = [],
  ): void {
    if (this.disposed) throw new Error('Cell streamer disposed');
    const server = cellNeighborhood(this.manifest, authoritative);
    const local = cellNeighborhood(this.manifest, predicted);
    this.historyRequired = [...new Set(historyCells)];
    const ids = [
      ...new Set([
        server[0],
        local[0],
        ...this.historyRequired,
        ...server.slice(1),
        ...local.slice(1),
      ]),
    ];
    if (ids.length > STREAMING_LIMITS.requiredCells)
      throw new Error('Required cell budget exceeded');
    for (const id of ids)
      if (!this.manifest.cells.some((cell) => cell.cellId === id))
        throw new Error(`Unknown history cell: ${id}`);
    this.wanted = new Map(ids.map((id, priority) => [id, priority]));
    const now = this.clock();
    for (const cell of this.cells.values()) {
      if (this.wanted.has(cell.id)) cell.releaseAt = undefined;
      else if (cell.state === 'active') cell.releaseAt ??= now + STREAMING_LIMITS.releaseMs;
      else if (cell.state !== 'releasing') this.beginRelease(cell);
    }
    this.ensureWanted();
  }
  private ensureWanted() {
    for (const [id, priority] of this.wanted) {
      if (this.cells.has(id)) continue;
      const cell: Cell = {
        id,
        state: 'loading',
        controller: new AbortController(),
        connected: [],
        startedAt: this.clock(),
      };
      this.cells.set(id, cell);
      void this.prepare(cell, priority);
    }
  }
  private async prepare(cell: Cell, priority: number) {
    const signal = cell.controller.signal;
    const valid = () =>
      !this.disposed &&
      !signal.aborted &&
      this.cells.get(cell.id) === cell &&
      this.wanted.has(cell.id);
    try {
      const set = await loadCellPhysics(this.manifest, cell.id, (path) =>
        this.resources.read(path, signal, priority),
      );
      if (!valid()) return;
      cell.state = 'verified';
      const descriptor = this.manifest.cells.find((item) => item.cellId === cell.id)!;
      const release = await this.graphics.prepareCellAssets(
        this.manifest,
        descriptor.assetIds,
        (path, assetSignal) => this.resources.read(path, assetSignal, priority),
        signal,
      );
      if (!valid()) {
        release();
        return;
      }
      cell.set = set;
      cell.releaseModels = release;
      cell.state = 'prepared';
      cell.operations = this.connect(cell);
    } catch (error) {
      if (!valid()) return;
      cell.error = String(error);
      cell.state = 'error';
    }
  }
  private *connect(cell: Cell): Generator<void> {
    const set = cell.set!;
    for (const item of [...set.cell.statics, ...set.cell.buildings]) {
      if (
        !this.entities.has(item.entityId) &&
        this.entities.size >= STREAMING_LIMITS.staticEntities
      )
        throw new Error('Required static content budget exceeded');
      const building = 'assetId' in item;
      const version = building
        ? this.manifest.assets[item.assetId].version
        : this.manifest.mapVersion;
      this.physics.retainStatic(
        item,
        version,
        building ? set.buildingAssets[item.assetId] : undefined,
      );
      try {
        this.graphics.retainStatic(item, version);
      } catch (error) {
        this.physics.releaseStatic(item.entityId);
        throw error;
      }
      this.entities.set(item.entityId, (this.entities.get(item.entityId) ?? 0) + 1);
      cell.connected.push(item.entityId);
      yield;
    }
    if (this.manifest.cells.length === 1)
      cell.releaseDecoration = this.graphics.activateCell?.(set.cell);
    cell.state = 'active';
    cell.preparedMs = this.clock() - cell.startedAt;
    cell.operations = undefined;
  }
  private beginRelease(cell: Cell) {
    if (cell.state === 'releasing') return;
    cell.controller.abort();
    cell.operations?.return(undefined);
    cell.state = 'releasing';
    cell.operations = this.release(cell);
  }
  private *release(cell: Cell): Generator<void> {
    while (cell.connected.length) {
      const id = cell.connected.pop()!;
      this.graphics.releaseStatic(id);
      this.physics.releaseStatic(id);
      const references = this.entities.get(id)! - 1;
      if (references) this.entities.set(id, references);
      else this.entities.delete(id);
      yield;
    }
    cell.connected.length = 0;
    cell.releaseDecoration?.();
    cell.releaseDecoration = undefined;
    cell.releaseModels?.();
    cell.releaseModels = undefined;
    cell.set = undefined;
    if (cell.error && this.wanted.has(cell.id)) {
      cell.state = 'error';
      cell.operations = undefined;
    } else this.cells.delete(cell.id);
  }
  /** Invoke before prediction/replay, never from an I/O callback. Required areas must be ready before stepping. */
  pump(budgetMs: number = STREAMING_LIMITS.frameMs) {
    if (this.disposed) return;
    const start = this.clock();
    for (const cell of this.cells.values())
      if (
        !this.wanted.has(cell.id) &&
        cell.state === 'active' &&
        (cell.releaseAt! <= start || this.entities.size >= STREAMING_LIMITS.staticEntities)
      )
        this.beginRelease(cell);
    const work = [...this.cells.values()]
      .filter((cell) => cell.operations)
      .sort(
        (a, b) =>
          (a.state === 'releasing' ? -1 : (this.wanted.get(a.id) ?? 1000)) -
          (b.state === 'releasing' ? -1 : (this.wanted.get(b.id) ?? 1000)),
      );
    outer: for (const cell of work) {
      while (cell.operations) {
        const operationStart = this.clock();
        const action = cell.state === 'releasing' ? 'release' : 'connect';
        try {
          if (cell.operations.next().done) cell.operations = undefined;
        } catch (error) {
          cell.error = String(error);
          this.budgetError = cell.error;
          this.beginRelease(cell);
          // Keep the failed target explicit until retry() instead of endlessly reconnecting it.
        }
        const ms = this.clock() - operationStart;
        this.peakOperationMs = Math.max(this.peakOperationMs, ms);
        this.samples.push({ cellId: cell.id, action, ms });
        if (this.samples.length > 4096) this.samples.shift();
        if (this.clock() - start >= budgetMs) break outer;
      }
    }
    this.peakPumpMs = Math.max(this.peakPumpMs, this.clock() - start);
    this.ensureWanted();
  }
  retry() {
    this.budgetError = undefined;
    for (const cell of [...this.cells.values()])
      if (cell.state === 'error') {
        cell.controller.abort();
        this.cells.delete(cell.id);
      }
    this.ensureWanted();
  }
  get problem(): string | undefined {
    return this.budgetError ?? [...this.cells.values()].find((cell) => cell.error)?.error;
  }
  get ready() {
    return (
      !this.budgetError &&
      this.wanted.size > 0 &&
      [...this.wanted.keys()].every((id) => this.cells.get(id)?.state === 'active')
    );
  }
  diagnostics() {
    return {
      ready: this.ready,
      error: this.budgetError,
      required: [...this.wanted.keys()],
      historyRequired: this.historyRequired,
      active: [...this.cells.values()]
        .filter((cell) => cell.state === 'active')
        .map((cell) => cell.id),
      retained: [...this.cells.values()]
        .filter((cell) => !this.wanted.has(cell.id) && cell.state === 'active')
        .map((cell) => cell.id),
      requested: [...this.cells.values()]
        .filter((cell) => ['loading', 'verified', 'prepared'].includes(cell.state))
        .map((cell) => cell.id),
      cells: [...this.cells.values()].map((cell) => ({
        id: cell.id,
        state: cell.state,
        references: cell.connected.length,
        releaseAt: cell.releaseAt,
        error: cell.error,
        preparedMs: cell.preparedMs,
      })),
      entities: this.entities.size,
      references: [...this.entities.values()].reduce((sum, n) => sum + n, 0),
      peakOperationMs: this.peakOperationMs,
      peakPumpMs: this.peakPumpMs,
      operations: this.samples.slice(),
      resources: this.resources.diagnostics(),
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.wanted.clear();
    for (const cell of [...this.cells.values()]) {
      this.beginRelease(cell);
      for (const _ of cell.operations!) {
        void _;
      }
    }
    this.resources.dispose();
  }
}
