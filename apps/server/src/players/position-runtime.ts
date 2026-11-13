import type { Pool } from 'pg';
import type { Vec3 } from '@su/contracts';
import {
  PlayerPositionStore,
  validPositionSnapshot,
  type PlayerPositionSnapshot,
  type PositionLoadResult,
  type PositionWriteResult,
} from './position-store.js';

interface PositionStorage {
  load(accountId: string, worldId: string): Promise<PositionLoadResult>;
  save(snapshot: PlayerPositionSnapshot): Promise<PositionWriteResult>;
  abort(): void;
}

interface RuntimeOptions {
  pool: Pool;
  worldId: string;
  writeEpoch: string;
  isAccountActive(accountId: string): boolean;
  onOwnershipLost(): void;
  /** Dependency and timing overrides keep queue and deadline tests deterministic. */
  store?: PositionStorage;
  loadTimeoutMs?: number;
  retryMs?: number;
  closeTimeoutMs?: number;
  maxPendingAccounts?: number;
}

interface PendingPosition {
  snapshot: PlayerPositionSnapshot;
  capturedAt: number;
  retryAt: number;
}

interface ReadRequest {
  accountId: string;
  deadline: number;
  finish(result: PositionLoadResult): void;
}

const copySnapshot = (snapshot: PlayerPositionSnapshot): PlayerPositionSnapshot => ({
  ...snapshot,
  position: { ...snapshot.position },
});

/** A bounded coalescing worker; no position failure enters the durable item-operation queue. */
export class PlayerPositionRuntime {
  readonly store: PositionStorage;
  private sequence = 0;
  private pending = new Map<string, PendingPosition>();
  private reads = new Set<ReadRequest>();
  private running?: Promise<void>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private wakeAt = Infinity;
  private closing = false;
  private stopped = false;
  private ownershipLost = false;
  private closePromise?: Promise<void>;
  private idleListeners = new Set<() => void>();
  private metrics = {
    reads: 0,
    readTimeouts: 0,
    readErrors: 0,
    lastReadMs: 0,
    totalReadMs: 0,
    writes: 0,
    writeErrors: 0,
    retries: 0,
    dropped: 0,
    lastCloseError: undefined as string | undefined,
  };

  constructor(private readonly options: RuntimeOptions) {
    this.store = options.store ?? new PlayerPositionStore(options.pool);
  }

  capture(accountId: string, position: Vec3): PlayerPositionSnapshot {
    if (this.closing || this.stopped) throw new Error('Player position runtime closed');
    const snapshot: PlayerPositionSnapshot = {
      accountId,
      worldId: this.options.worldId,
      position: { ...position },
      writeEpoch: this.options.writeEpoch,
      writeSequence: ++this.sequence,
    };
    if (!validPositionSnapshot(snapshot)) throw new Error('Invalid player position capture');
    const previous = this.pending.get(accountId);
    this.pending.set(accountId, {
      snapshot,
      capturedAt: performance.now(),
      retryAt: previous?.retryAt ?? 0,
    });
    this.enforceLimit();
    this.kick();
    return copySnapshot(snapshot);
  }

  private enforceLimit() {
    const limit = this.options.maxPendingAccounts ?? 64;
    while (this.pending.size > limit) {
      let oldest: PendingPosition | undefined;
      for (const entry of this.pending.values()) {
        if (this.options.isAccountActive(entry.snapshot.accountId)) continue;
        if (!oldest || entry.capturedAt < oldest.capturedAt) oldest = entry;
      }
      // The room's player limit is below the queue limit; active accounts are never evicted.
      if (!oldest) break;
      this.pending.delete(oldest.snapshot.accountId);
      this.metrics.dropped++;
    }
  }

  loadForJoin(accountId: string): Promise<PositionLoadResult> {
    const cached = this.pending.get(accountId);
    if (cached)
      return Promise.resolve({ status: 'found', snapshot: copySnapshot(cached.snapshot) });
    if (this.closing || this.stopped || this.ownershipLost || this.reads.size >= 64)
      return Promise.resolve({ status: 'unavailable', reason: 'storage' });
    const startedAt = performance.now();
    this.metrics.reads++;
    return new Promise((resolve) => {
      let settled = false;
      const request: ReadRequest = {
        accountId,
        deadline: startedAt + (this.options.loadTimeoutMs ?? 1000),
        finish: (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.reads.delete(request);
          this.metrics.lastReadMs = performance.now() - startedAt;
          this.metrics.totalReadMs += this.metrics.lastReadMs;
          if (result.status === 'unavailable') {
            if (result.reason === 'timeout') this.metrics.readTimeouts++;
            else this.metrics.readErrors++;
          }
          resolve(result);
        },
      };
      const timeout = setTimeout(() => {
        request.finish({ status: 'unavailable', reason: 'timeout' });
      }, this.options.loadTimeoutMs ?? 1000);
      this.reads.add(request);
      this.kick();
    });
  }

  private kick(delay = 0) {
    if (this.stopped || this.ownershipLost || this.running) return;
    const at = performance.now() + delay;
    if (this.wakeTimer && this.wakeAt <= at) return;
    clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.wakeAt = Infinity;
      this.running = this.work().finally(() => {
        this.running = undefined;
        for (const listener of this.idleListeners) listener();
        if (this.stopped || this.ownershipLost) return;
        if (this.reads.size) this.kick();
        else if (this.pending.size) {
          const next = Math.min(...[...this.pending.values()].map((p) => p.retryAt));
          this.kick(Math.max(0, next - performance.now()));
        }
      });
    }, delay);
    this.wakeTimer.unref();
  }

  private async work() {
    if (this.stopped || this.ownershipLost) return;
    const read = this.reads.values().next().value as ReadRequest | undefined;
    if (read) {
      // A request can expire while waiting behind another account's SQL.
      if (performance.now() >= read.deadline) {
        read.finish({ status: 'unavailable', reason: 'timeout' });
        return;
      }
      try {
        const result = await this.store.load(read.accountId, this.options.worldId);
        const latest = this.pending.get(read.accountId);
        read.finish(latest ? { status: 'found', snapshot: copySnapshot(latest.snapshot) } : result);
      } catch (error) {
        read.finish({
          status: 'unavailable',
          reason: (error as { code?: string }).code === '57014' ? 'timeout' : 'storage',
        });
      }
      return;
    }
    const entry = [...this.pending.values()].find((p) => p.retryAt <= performance.now());
    if (!entry) return;
    const { snapshot } = entry;
    try {
      const result = await this.store.save(snapshot);
      if (this.stopped) return;
      if (result === 'ownership-lost') {
        this.ownershipLost = true;
        this.options.onOwnershipLost();
        return;
      }
      this.metrics.writes++;
      if (this.pending.get(snapshot.accountId)?.snapshot.writeSequence === snapshot.writeSequence)
        this.pending.delete(snapshot.accountId);
    } catch {
      if (this.stopped) return;
      this.metrics.writeErrors++;
      this.metrics.retries++;
      const latest = this.pending.get(snapshot.accountId);
      if (latest) latest.retryAt = performance.now() + (this.options.retryMs ?? 1000);
    }
  }

  diagnostics() {
    return {
      ...this.metrics,
      pendingAccounts: this.pending.size,
      oldestPendingMs: this.pending.size
        ? Math.max(
            0,
            performance.now() - Math.min(...[...this.pending.values()].map((p) => p.capturedAt)),
          )
        : 0,
      pendingReads: this.reads.size,
      busy: Boolean(this.running),
      ownershipLost: this.ownershipLost,
      closing: this.closing,
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const request of this.reads) request.finish({ status: 'unavailable', reason: 'storage' });
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose() {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.ownershipLost) reject(new Error('Player position ownership lost'));
        else if (!this.pending.size && !this.running) resolve();
      };
      this.idleListeners.add(check);
      deadlineTimer = setTimeout(() => {
        this.idleListeners.delete(check);
        reject(new Error('Final player position save exceeded deadline'));
      }, this.options.closeTimeoutMs ?? 10_000);
      check();
    });
    this.kick();
    try {
      await drained;
    } catch (error) {
      this.metrics.lastCloseError = (error as Error).message;
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      clearTimeout(this.wakeTimer);
      this.idleListeners.clear();
      this.stopped = true;
      this.store.abort();
      // Aborting a checked-out client rejects its active SQL; the worker cannot write again.
      await this.running;
    }
  }
}
