import { StateView } from '@colyseus/schema';
import type { Client } from '@colyseus/core';
import { INTEREST_RADII, type Vec3, type WorldGrid } from '@su/contracts';
import type { EntitySchema } from '@su/protocol';

type Entry = { entity: EntitySchema; key: string };
type Observer = { client: Client; ownId: string; visible: Set<string> };

/** Authoritative dynamic entities only. Cell crossings select candidates, distance controls visibility. */
export class DynamicInterest {
  private readonly entries = new Map<string, Entry>();
  private readonly buckets = new Map<string, Set<string>>();
  private readonly observers = new Map<string, Observer>();
  private additions = 0;
  private removals = 0;
  private updates = 0;
  constructor(private readonly grid: WorldGrid) {}
  private key(x: number, z: number) {
    return `${Math.floor((x - this.grid.origin.x) / this.grid.cellSize)}_${Math.floor((z - this.grid.origin.z) / this.grid.cellSize)}`;
  }
  upsert(entity: EntitySchema): void {
    const key = this.key(entity.x, entity.z);
    const previous = this.entries.get(entity.entityId);
    if (previous && previous.entity !== entity)
      throw new Error(`Changed live entity reference: ${entity.entityId}`);
    if (previous?.key === key) return;
    if (previous) this.removeBucket(previous.key, entity.entityId);
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = new Set()));
    bucket.add(entity.entityId);
    this.entries.set(entity.entityId, { entity, key });
  }
  private removeBucket(key: string, id: string) {
    const bucket = this.buckets.get(key)!;
    bucket.delete(id);
    if (!bucket.size) this.buckets.delete(key);
  }
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const observer of this.observers.values())
      if (observer.visible.delete(id)) {
        observer.client.view!.remove(entry.entity);
        this.removals++;
      }
    this.removeBucket(entry.key, id);
    this.entries.delete(id);
  }
  private candidates(position: Vec3) {
    const radius = INTEREST_RADII.leave;
    const [minX, minZ] = this.key(position.x - radius, position.z - radius)
      .split('_')
      .map(Number);
    const [maxX, maxZ] = this.key(position.x + radius, position.z + radius)
      .split('_')
      .map(Number);
    const ids = new Set<string>();
    for (let x = minX; x <= maxX; x++)
      for (let z = minZ; z <= maxZ; z++)
        for (const id of this.buckets.get(`${x}_${z}`) ?? []) ids.add(id);
    return ids;
  }
  /** Set before JOIN's full state. Reconnection deliberately starts without old hysteresis. */
  reset(client: Client, ownId: string): void {
    this.drop(client.sessionId);
    client.view?.dispose();
    client.view = new StateView();
    this.observers.set(client.sessionId, { client, ownId, visible: new Set() });
    this.refresh(client.sessionId);
  }
  refresh(sessionId?: string): void {
    const observers = sessionId
      ? [this.observers.get(sessionId)].filter((value): value is Observer => !!value)
      : this.observers.values();
    for (const observer of observers) {
      const own = this.entries.get(observer.ownId)?.entity;
      const wanted = new Set<string>();
      if (own) {
        wanted.add(observer.ownId);
        for (const id of this.candidates({ x: own.x, y: own.y, z: own.z })) {
          const entity = this.entries.get(id)!.entity;
          const radius = observer.visible.has(id) ? INTEREST_RADII.leave : INTEREST_RADII.enter;
          if ((entity.x - own.x) ** 2 + (entity.z - own.z) ** 2 <= radius ** 2) wanted.add(id);
        }
      }
      for (const id of observer.visible)
        if (!wanted.has(id)) {
          observer.client.view!.remove(this.entries.get(id)!.entity);
          observer.visible.delete(id);
          this.removals++;
        }
      for (const id of wanted)
        if (!observer.visible.has(id)) {
          observer.client.view!.add(this.entries.get(id)!.entity);
          observer.visible.add(id);
          this.additions++;
        }
      this.updates++;
    }
  }
  drop(sessionId: string): void {
    const observer = this.observers.get(sessionId);
    if (!observer) return;
    observer.client.view!.dispose();
    this.observers.delete(sessionId);
  }
  clear(): void {
    for (const id of [...this.observers.keys()]) this.drop(id);
    this.entries.clear();
    this.buckets.clear();
  }
  diagnostics() {
    return {
      indexed: this.entries.size,
      buckets: this.buckets.size,
      views: this.observers.size,
      memberships: [...this.observers.values()].reduce(
        (sum, observer) => sum + observer.visible.size,
        0,
      ),
      additions: this.additions,
      removals: this.removals,
      updates: this.updates,
    };
  }
}
