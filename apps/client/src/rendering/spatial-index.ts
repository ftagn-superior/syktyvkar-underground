import type { Bounds } from '@su/contracts';

/** Small X/Z buckets shared by sight-ray and shadow candidate selection. */
export class SpatialIndex {
  private readonly buckets = new Map<string, Set<string>>();
  private readonly entries = new Map<string, string[]>();
  private keys(bounds: Bounds) {
    const keys: string[] = [];
    for (let x = Math.floor(bounds.min.x / 32); x <= Math.floor(bounds.max.x / 32); x++)
      for (let z = Math.floor(bounds.min.z / 32); z <= Math.floor(bounds.max.z / 32); z++)
        keys.push(`${x}_${z}`);
    return keys;
  }
  add(id: string, bounds: Bounds) {
    this.remove(id);
    const keys = this.keys(bounds);
    this.entries.set(id, keys);
    for (const key of keys) {
      let bucket = this.buckets.get(key);
      if (!bucket) this.buckets.set(key, (bucket = new Set()));
      bucket.add(id);
    }
  }
  remove(id: string) {
    for (const key of this.entries.get(id) ?? []) {
      const bucket = this.buckets.get(key)!;
      bucket.delete(id);
      if (!bucket.size) this.buckets.delete(key);
    }
    this.entries.delete(id);
  }
  query(bounds: Bounds): Set<string> {
    const ids = new Set<string>();
    for (const key of this.keys(bounds)) for (const id of this.buckets.get(key) ?? []) ids.add(id);
    return ids;
  }
}
