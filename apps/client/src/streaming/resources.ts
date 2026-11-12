import type { WorldManifest } from '@su/contracts';

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
export interface ResourceOptions {
  fetch?: typeof fetch;
  cacheBytes?: number;
}

/** One immutable world version. Only verified bytes enter the bounded LRU. */
export class VerifiedResources {
  private readonly cache = new Map<string, Uint8Array>();
  private readonly jobs = new Map<string, Job>();
  private readonly fetcher: typeof fetch;
  private readonly limit: number;
  private bytes = 0;
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
    this.limit = options.cacheBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.limit) || this.limit < 0)
      throw new Error('Invalid byte cache budget');
  }
  read(path: string, signal?: AbortSignal, priority = 0): Promise<Uint8Array> {
    if (this.disposed || signal?.aborted) return Promise.reject(aborted());
    if (!Object.hasOwn(this.manifest.files, path))
      return Promise.reject(new Error(`Unlisted resource: ${path}`));
    const cached = this.cache.get(path);
    if (cached) {
      this.cacheHits++;
      this.cache.delete(path);
      this.cache.set(path, cached);
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
            if (!this.disposed && bytes.byteLength <= this.limit) {
              this.invalidate(job.path);
              this.cache.set(job.path, bytes);
              this.bytes += bytes.byteLength;
              while (this.bytes > this.limit) this.invalidate(this.cache.keys().next().value!);
            }
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
      const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      if (hash === this.manifest.files[job.path]) return bytes;
      if (!attempt) this.retries++;
    }
    throw new Error(`Resource version/SHA-256 mismatch: ${job.path}`);
  }
  invalidate(path: string) {
    const bytes = this.cache.get(path);
    if (bytes) {
      this.bytes -= bytes.byteLength;
      this.cache.delete(path);
    }
  }
  diagnostics() {
    return {
      cacheBytes: this.bytes,
      cacheEntries: this.cache.size,
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
    this.cache.clear();
    this.bytes = 0;
  }
}
