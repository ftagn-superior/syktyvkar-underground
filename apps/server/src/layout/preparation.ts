import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorldLayoutSnapshot } from '@su/contracts';
import type { PreparationJob, PreparationReply, PreparedLayout } from './preparation-types.js';

export class LayoutPreparationError extends Error {
  constructor(
    readonly code: 'CONTENT_LIMIT' | 'STORAGE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}
/** A single reusable publisher thread, scoped to one immutable asset release. */
export class LayoutPreparation {
  private worker?: Worker;
  private active?: { reject: (error: Error) => void; stagingDirectory: string };
  private closed = false;
  constructor(
    readonly releaseDirectory: string,
    readonly assetReleaseVersion: string,
    readonly timeoutMs = 15_000,
  ) {}

  async prepare(
    snapshot: WorldLayoutSnapshot,
    operationId: string,
    worldEpoch: string,
  ): Promise<PreparedLayout> {
    if (this.closed || this.active)
      throw new LayoutPreparationError('STORAGE_UNAVAILABLE', 'Publisher is unavailable');
    const id = randomUUID();
    const stagingDirectory = resolve(this.releaseDirectory, 'layouts', `.pending-${id}`);
    const source = import.meta.url.endsWith('.ts');
    const worker = (this.worker ??= source
      ? new Worker(
          new URL(
            `data:text/javascript,${encodeURIComponent(
              'import { register } from ' +
                JSON.stringify(
                  pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href,
                ) +
                '; register(); await import(' +
                JSON.stringify(new URL('./preparation-worker.ts', import.meta.url).href) +
                ');',
            )}`,
          ),
          { execArgv: [] },
        )
      : new Worker(new URL('./preparation-worker.mjs', import.meta.url)));
    if (worker.listenerCount('error') === 0) {
      worker.on('error', () => {
        if (this.worker === worker) this.worker = undefined;
      });
      worker.on('exit', () => {
        if (this.worker === worker) this.worker = undefined;
      });
    }
    const job: PreparationJob = {
      id,
      operationId,
      worldEpoch,
      releaseDirectory: this.releaseDirectory,
      assetReleaseVersion: this.assetReleaseVersion,
      snapshot,
      stagingDirectory,
    };
    try {
      return await new Promise<PreparedLayout>((resolveJob, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = (error?: Error, result?: PreparedLayout) => {
          clearTimeout(timer);
          worker.off('message', message);
          worker.off('error', failed);
          worker.off('exit', exited);
          this.active = undefined;
          if (error) reject(error);
          else resolveJob(result!);
        };
        const failed = (error: Error) => done(error);
        const exited = (code: number) => failed(new Error(`Publisher exited (${code})`));
        const message = (reply: PreparationReply) => {
          const receivedAt = performance.timeOrigin + performance.now();
          if ((reply.ok ? reply.value.id : reply.id) !== id) return;
          if (!reply.ok) return done(new LayoutPreparationError(reply.code, reply.message));
          if (
            reply.value.operationId !== operationId ||
            reply.value.worldEpoch !== worldEpoch ||
            reply.value.assetReleaseVersion !== this.assetReleaseVersion ||
            this.closed
          )
            return done(new Error('Obsolete publisher result'));
          done(undefined, { ...reply.value, workerReturnMs: receivedAt - reply.value.completedAt });
        };
        this.active = { reject: failed, stagingDirectory };
        timer = setTimeout(
          () => failed(new Error('Publisher preparation timed out')),
          this.timeoutMs,
        );
        worker.on('message', message);
        worker.once('error', failed);
        worker.once('exit', exited);
        worker.postMessage(job);
      });
    } catch (error) {
      if (this.worker === worker) this.worker = undefined;
      await worker.terminate();
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  async close() {
    this.closed = true;
    const active = this.active;
    this.active?.reject(new Error('Publisher is shutting down'));
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
    if (active) await rm(active.stagingDirectory, { recursive: true, force: true });
  }
}
