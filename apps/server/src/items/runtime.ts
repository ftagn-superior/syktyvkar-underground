import {
  canonicalJson,
  ITEM_SAVE_INTERVAL_MS,
  type InventoryView,
  type ItemCommand,
  type ItemError,
  type ItemResult,
  type ItemState,
  type WorldSoundEvent,
} from '@su/contracts';
import type { AuthoritativeWorld } from '@su/simulation/server';
import { ItemStore, type ItemMutationResult } from './store.js';

interface Job {
  run: () => Promise<void>;
  reject: (error: Error) => void;
}
export type ItemSound = Pick<
  WorldSoundEvent,
  'kind' | 'position' | 'typeId' | 'entityId' | 'actorId' | 'operationId' | 'strength'
>;
/** One ordered writer. A failed/uncertain commit stays at the head until it can be resolved. */
export class ItemRuntime {
  unavailable = false;
  closing = false;
  private reservations = 0;
  private queue: Job[] = [];
  private running = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lastCapture = 0;
  private saving = false;
  private snapshotSequence = 0;
  private saved = new Map<string, string>();
  private previous = new Map<string, ItemState>();
  constructor(
    readonly store: ItemStore,
    private readonly world: AuthoritativeWorld,
    private readonly statusChanged: () => void,
    private readonly onItemSound?: (event: ItemSound) => void,
  ) {}
  get paused() {
    return this.unavailable || this.closing || this.reservations > 0;
  }
  async initialize() {
    const items = await this.store.initialize();
    this.world.replaceItems(items);
    for (const item of items) this.saved.set(item.entityId, canonicalJson(item));
    this.store.onConnectionFailure = () => {
      if (this.closing) return;
      this.unavailable = true;
      this.statusChanged();
      this.retry();
    };
  }
  private retry() {
    if (this.stopped) return;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, 1000);
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: async () => {
          const result = await run();
          resolve(result);
        },
        reject,
      });
    });
    void this.drain();
    return promise;
  }
  private async drain() {
    if (this.running || this.timer || this.stopped) return;
    this.running = true;
    try {
      if (this.unavailable) await this.store.connect();
      while (this.queue.length) {
        try {
          await this.store.connect();
          await this.queue[0].run();
          this.queue.shift();
        } catch {
          this.unavailable = true;
          this.statusChanged();
          this.retry();
          return;
        }
      }
      if (this.unavailable && !this.closing) {
        // Preserve motion accumulated before the failure; reconcile confirmed transfers first.
        this.world.reconcileItems(await this.store.worldItems());
        const items = this.world.getSnapshot().items;
        await this.store.save(items, ++this.snapshotSequence);
        for (const i of items) this.saved.set(i.entityId, canonicalJson(i));
        this.unavailable = false;
      }
    } catch {
      this.unavailable = true;
      this.retry();
    } finally {
      this.running = false;
      this.statusChanged();
      if (this.queue.length && !this.timer) void this.drain();
    }
  }
  inventory(accountId: string): Promise<InventoryView> {
    return this.enqueue(() => this.store.inventory(accountId));
  }
  give(
    accountId: string,
    operationId: string,
    typeId: string,
    validate: () => ItemError | undefined,
  ): Promise<ItemMutationResult> {
    if (this.closing) return Promise.resolve({ operationId, ok: false, code: 'WORLD_NOT_READY' });
    // Inventory-only creation uses the same ordered writer and durable replay journal,
    // without reserving any physical body or pausing the simulation.
    return this.enqueue(() =>
      this.store.operation(accountId, operationId, { kind: 'give', typeId }, validate),
    );
  }
  command(
    accountId: string,
    playerId: string,
    command: ItemCommand,
    validate: () => ItemError | undefined,
  ): Promise<ItemResult> {
    if (this.closing)
      return Promise.resolve({
        operationId: command.operationId,
        ok: false,
        code: 'WORLD_NOT_READY',
      });
    this.reservations++;
    this.statusChanged();
    return this.enqueue(async () => {
      let fresh = false;
      let typeId: string | undefined;
      const action = command.action;
      const previous =
        action.kind === 'pickup'
          ? this.world.getSnapshot().items.find((item) => item.entityId === action.itemId)
          : undefined;
      const result = await this.store.operation(
        accountId,
        command.operationId,
        command.action,
        (action, validatedTypeId) => {
          typeId = validatedTypeId ?? typeId;
          const error = validate();
          if (error) return error;
          if (action.kind === 'pickup') return this.world.checkPickup(playerId, action.itemId);
          if (action.kind === 'place' && validatedTypeId)
            return this.world.checkPlacement(validatedTypeId, action.pose, playerId);
        },
        () => {
          fresh = true;
        },
      );
      // Reconcile even a replay: COMMIT may have succeeded before an earlier connection failed.
      this.world.reconcileItems(await this.store.worldItems());
      if (fresh && result.ok && typeId && (action.kind === 'place' || action.kind === 'pickup')) {
        const position = action.kind === 'place' ? action.pose.position : previous?.position;
        if (position) {
          try {
            this.onItemSound?.({
              kind: action.kind,
              position: { ...position },
              typeId,
              entityId: action.itemId,
              actorId: playerId,
              operationId: command.operationId,
              strength: 1,
            });
          } catch {
            /* Cosmetic delivery must never retry a committed operation. */
          }
        }
      }
      return result;
    }).finally(() => {
      this.reservations--;
      this.statusChanged();
    });
  }
  step(tick: number) {
    if (this.paused || this.saving) return;
    const items = this.world.getSnapshot().items;
    const liveIds = new Set(items.map((i) => i.entityId));
    for (const id of this.saved.keys()) if (!liveIds.has(id)) this.saved.delete(id);
    const stopped = items.some((i) => {
      const previous = this.previous.get(i.entityId);
      return (
        previous &&
        Math.hypot(
          previous.velocity.x,
          previous.velocity.y,
          previous.velocity.z,
          previous.angularVelocity.x,
          previous.angularVelocity.y,
          previous.angularVelocity.z,
        ) > 0.03 &&
        Math.hypot(
          i.velocity.x,
          i.velocity.y,
          i.velocity.z,
          i.angularVelocity.x,
          i.angularVelocity.y,
          i.angularVelocity.z,
        ) <= 0.03
      );
    });
    this.previous = new Map(items.map((i) => [i.entityId, i]));
    if (!stopped && tick - this.lastCapture < (ITEM_SAVE_INTERVAL_MS * 60) / 1000) return;
    this.lastCapture = tick;
    const dirty = items.filter((i) => this.saved.get(i.entityId) !== canonicalJson(i));
    this.saving = true;
    const sequence = ++this.snapshotSequence;
    void this.enqueue(async () => {
      await this.store.save(dirty, sequence);
      // Only clear the exact captured state, leaving subsequent motion dirty.
      for (const item of dirty) this.saved.set(item.entityId, canonicalJson(item));
    })
      .catch(() => {})
      .finally(() => {
        this.saving = false;
      });
  }
  async close() {
    this.closing = true;
    this.statusChanged();
    const flush = this.enqueue(async () => {
      await this.store.save(this.world.getSnapshot().items, ++this.snapshotSequence);
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        flush,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Final world save failed')), 10_000);
        }),
      ]);
    } finally {
      this.stopped = true;
      clearTimeout(deadline);
      clearTimeout(this.timer);
      this.timer = undefined;
      for (const job of this.queue)
        job.reject(new Error('World stopped before its write completed'));
      this.queue.length = 0;
      this.store.onConnectionFailure = undefined;
      await this.store.close();
    }
  }
}
