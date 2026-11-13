import { decodeGraphicsPack, type WorldManifest } from '@su/contracts';

const aborted = () => new DOMException('Resource request cancelled', 'AbortError');
type Consumer = {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
  detach: () => void;
};
type Job = {
  path: string;
  priority: number;
  controller: AbortController;
  consumers: Set<Consumer>;
  started: boolean;
};
/** Session-owned, content-addressed LRU. Contexts never authorize access through cache keys. */
export class VerifiedByteCache {
  private readonly entries = new Map<string, Uint8Array>();
  private bytes = 0;
  private disposed = false;
  constructor(readonly limit = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid byte cache budget');
  }
  get(hash: string): Uint8Array | undefined {
    const value = this.entries.get(hash);
    if (value) {
      this.entries.delete(hash);
      this.entries.set(hash, value);
    }
    return value;
  }
  has(hash: string): boolean {
    return this.entries.has(hash);
  }
  set(hash: string, value: Uint8Array): void {
    if (this.disposed || value.byteLength > this.limit) return;
    this.delete(hash);
    this.entries.set(hash, value);
    this.bytes += value.byteLength;
    while (this.bytes > this.limit) this.delete(this.entries.keys().next().value!);
  }
  delete(hash: string): void {
    const value = this.entries.get(hash);
    if (value) this.bytes -= value.byteLength;
    this.entries.delete(hash);
  }
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
  diagnostics() {
    return { cacheBytes: this.bytes, cacheEntries: this.entries.size };
  }
  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}
export interface ResourceOptions {
  cache?: VerifiedByteCache;
  fetch?: typeof fetch;
  cacheBytes?: number;
}

/** One immutable world version. Only verified bytes enter the bounded LRU. */
export class VerifiedResources {
  private readonly cache: VerifiedByteCache;
  private readonly ownsCache: boolean;
  private readonly jobs = new Map<string, Job>();
  private readonly fetcher: typeof fetch;
  private readonly packPaths: Set<string>;
  private readonly packEntries = new Map<string, string[]>();
  private running = 0;
  private peakRunning = 0;
  private disposed = false;
  private downloads = 0;
  private retries = 0;
  private cacheHits = 0;
  private responseBodyBytes = 0;
  private readonly http: {
    path: string;
    startedAt: number;
    ms: number;
    status: number;
    bodyBytes: number;
    cache: RequestCache;
    error?: string;
  }[] = [];
  constructor(
    readonly manifest: WorldManifest,
    private readonly baseUrl: string,
    options: ResourceOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.ownsCache = !options.cache;
    this.cache = options.cache ?? new VerifiedByteCache(options.cacheBytes);
    this.packPaths = new Set((manifest.cells ?? []).flatMap((cell) => cell.graphicsPacks ?? []));
  }
  read(path: string, signal?: AbortSignal, priority = 0): Promise<Uint8Array> {
    if (this.disposed || signal?.aborted) return Promise.reject(aborted());
    if (!Object.hasOwn(this.manifest.files, path))
      return Promise.reject(new Error(`Unlisted resource: ${path}`));
    const cached = this.cache.get(this.manifest.files[path]);
    if (cached) {
      this.cacheHits++;
      return Promise.resolve(cached.slice());
    }
    let job = this.jobs.get(path);
    if (!job) {
      if (this.jobs.size >= 512) return Promise.reject(new Error('Resource queue budget exceeded'));
      job = {
        path,
        priority,
        controller: new AbortController(),
        consumers: new Set(),
        started: false,
      };
      this.jobs.set(path, job);
    }
    job.priority = Math.min(job.priority, priority);
    const selected = job;
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      const cancel = () => {
        selected.consumers.delete(consumer);
        consumer.detach();
        reject(aborted());
        if (!selected.consumers.size) {
          selected.controller.abort();
          if (this.jobs.get(path) === selected) this.jobs.delete(path);
        }
      };
      const consumer: Consumer = {
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', cancel),
      };
      selected.consumers.add(consumer);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    this.pump();
    return promise;
  }
  /** Packs change transport only: callers can still read every original file after LRU eviction. */
  async prefetchGraphics(cellId: string, signal?: AbortSignal, priority = 0): Promise<void> {
    if (this.disposed || signal?.aborted) throw aborted();
    const cell = this.manifest.cells.find((entry) => entry.cellId === cellId);
    if (!cell) throw new Error(`Unknown graphics cell: ${cellId}`);
    if (!cell.graphicsPacks?.length) return;
    const allowed = new Set(
      cell.assetIds.flatMap((id) => {
        const asset = this.manifest.assets[id];
        return asset.modelFile ? [asset.modelFile, asset.partsFile] : [asset.partsFile];
      }),
    );
    for (const pack of cell.graphicsPacks) {
      if ([...allowed].every((path) => this.cache.has(this.manifest.files[path]))) break;
      if (this.packEntries.get(pack)?.every((path) => this.cache.has(this.manifest.files[path])))
        continue;
      const entries = decodeGraphicsPack(await this.read(pack, signal, priority));
      // Validate the entire envelope before adding anything to the asset cache.
      for (const [path, bytes] of entries) {
        if (this.disposed || signal?.aborted) throw aborted();
        if (!allowed.has(path)) throw new Error(`Unexpected graphics pack entry: ${path}`);
        if ((await this.digest(bytes)) !== this.manifest.files[path])
          throw new Error(`Graphics pack entry SHA-256 mismatch: ${path}`);
      }
      if (this.disposed || signal?.aborted) throw aborted();
      this.packEntries.set(pack, [...entries.keys()]);
      for (const [path, bytes] of entries) {
        this.cacheVerified(path, bytes.slice());
        // A neighboring cell may already be waiting for this same individual file.
        const job = this.jobs.get(path);
        if (!job) continue;
        this.jobs.delete(path);
        job.controller.abort();
        for (const consumer of job.consumers) {
          consumer.detach();
          consumer.resolve(bytes.slice());
        }
        job.consumers.clear();
      }
    }
  }
  private cacheVerified(path: string, bytes: Uint8Array): void {
    this.cache.set(this.manifest.files[path], bytes);
  }
  private pump() {
    while (!this.disposed && this.running < 4) {
      const job = [...this.jobs.values()]
        .filter((item) => !item.started)
        .sort((a, b) => a.priority - b.priority)[0];
      if (!job) break;
      job.started = true;
      this.running++;
      this.peakRunning = Math.max(this.peakRunning, this.running);
      void this.download(job)
        .then(
          (bytes) => {
            if (this.jobs.get(job.path) === job) this.jobs.delete(job.path);
            if (this.disposed || job.controller.signal.aborted) return;
            // Only extracted files occupy the LRU; retaining envelopes would double raw memory.
            if (!this.packPaths.has(job.path)) this.cacheVerified(job.path, bytes);
            for (const consumer of job.consumers) {
              consumer.detach();
              consumer.resolve(bytes.slice());
            }
          },
          (error: unknown) => {
            if (this.jobs.get(job.path) === job) this.jobs.delete(job.path);
            for (const consumer of job.consumers) {
              consumer.detach();
              consumer.reject(error);
            }
          },
        )
        .finally(() => {
          job.consumers.clear();
          if (this.jobs.get(job.path) === job) this.jobs.delete(job.path);
          this.running--;
          this.pump();
        });
    }
  }
  private async download(job: Job): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (job.controller.signal.aborted) throw aborted();
      this.downloads++;
      const sample = {
        path: job.path,
        startedAt: performance.now(),
        ms: 0,
        status: 0,
        bodyBytes: 0,
        cache: (attempt ? 'reload' : 'default') as RequestCache,
        error: undefined as string | undefined,
      };
      let bytes: Uint8Array;
      try {
        const response = await this.fetcher(`${this.baseUrl}${job.path}`, {
          signal: job.controller.signal,
          cache: sample.cache,
        });
        sample.status = response.status;
        if (!response.ok) throw new Error(`Resource HTTP ${response.status}: ${job.path}`);
        bytes = new Uint8Array(await response.arrayBuffer());
        sample.bodyBytes = bytes.byteLength;
        this.responseBodyBytes += bytes.byteLength;
      } catch (error) {
        sample.error = String(error);
        throw error;
      } finally {
        sample.ms = performance.now() - sample.startedAt;
        this.http.push(sample);
        if (this.http.length > 256) this.http.shift();
      }
      if (bytes.byteLength > 8 * 1024 * 1024)
        throw new Error(`Resource byte budget exceeded: ${job.path}`);
      const hash = await this.digest(bytes);
      if (hash === this.manifest.files[job.path]) return bytes;
      if (!attempt) this.retries++;
    }
    throw new Error(`Resource version/SHA-256 mismatch: ${job.path}`);
  }
  private async digest(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  invalidate(path: string) {
    if (Object.hasOwn(this.manifest.files, path)) this.cache.delete(this.manifest.files[path]);
  }
  diagnostics() {
    return {
      ...this.cache.diagnostics(),
      pending: this.jobs.size,
      httpActive: this.running,
      httpPeak: this.peakRunning,
      downloads: this.downloads,
      integrityRetries: this.retries,
      cacheHits: this.cacheHits,
      responseBodyBytes: this.responseBodyBytes,
      byteDefinition:
        'Decoded HTTP resource bodies, including retries; not compressed transfer or WebSocket bytes.',
      http: this.http.slice(),
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs.values()) {
      job.controller.abort();
      for (const consumer of job.consumers) {
        consumer.detach();
        consumer.reject(aborted());
      }
      job.consumers.clear();
    }
    this.jobs.clear();
    if (this.ownsCache) this.cache.clear();
    this.packEntries.clear();
  }
}
