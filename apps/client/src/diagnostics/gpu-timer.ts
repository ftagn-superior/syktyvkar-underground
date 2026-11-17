type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
export type GpuTimerStatus = 'collecting' | 'unsupported' | 'context-lost' | 'error' | 'disposed';
const MAX_QUERY_AGE_MS = 5000;

/**
 * Opt-in GPU elapsed time of the commands issued by one `scene.render()`, sampled rarely.
 * At most one query is in flight; results are polled on later callbacks and never waited for
 * (no finish/readPixels/busy loop). Results overlapping a disjoint event are discarded.
 */
export class GpuRenderTimer {
  status: GpuTimerStatus = 'unsupported';
  samples = 0;
  disjoint = 0;
  busySkips = 0;
  lostQueries = 0;
  expired = 0;
  invalidResults = 0;
  conflicts = 0;
  errors = 0;
  private extension?: TimerExtension;
  private query?: WebGLQuery;
  private queryFrame = 0;
  private open = false;
  private calls = 0;
  private issuedAt = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext | null,
    private readonly every = 30,
    private readonly clock = () => performance.now(),
    private readonly canMeasure = () => true,
  ) {
    this.acquire();
  }
  private acquire(): void {
    try {
      this.extension =
        (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null) ??
        undefined;
      this.status = this.extension ? 'collecting' : 'unsupported';
    } catch {
      this.fail();
    }
  }
  private discard(): void {
    const query = this.query;
    this.query = undefined;
    this.open = false;
    if (query) this.gl?.deleteQuery(query);
  }
  /** Never end a query owned by a profiler or another engine instrument. */
  private ownsActiveQuery(): boolean {
    return (
      !!this.query &&
      this.gl?.getQuery(this.extension!.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) === this.query
    );
  }
  private fail(): void {
    this.errors++;
    try {
      if (this.extension && this.ownsActiveQuery())
        this.gl?.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.discard();
    } catch {
      /* A failed diagnostic API must not replace an exception from scene.render(). */
    }
    this.query = undefined;
    this.open = false;
    this.extension = undefined;
    this.status = 'error';
  }
  /** Starts a sample for this frame when due and no earlier result is outstanding. */
  begin(frameId: number | null): void {
    const { gl, extension } = this;
    if (
      !gl ||
      !extension ||
      this.status !== 'collecting' ||
      frameId === null ||
      this.open ||
      this.calls++ % this.every
    )
      return;
    if (this.query) {
      this.busySkips++;
      return;
    }
    try {
      if (gl.isContextLost()) {
        this.contextLost();
        return;
      }
      if (!this.canMeasure() || gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) {
        this.busySkips++;
        return;
      }
      gl.getParameter(extension.GPU_DISJOINT_EXT); // Clear stale state before our interval only.
      const query = gl.createQuery();
      if (!query) return;
      this.query = query;
      this.queryFrame = frameId;
      this.issuedAt = this.clock();
      gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      this.open = this.ownsActiveQuery();
      if (!this.open) {
        this.conflicts++;
        this.discard();
      }
    } catch {
      this.fail();
    }
  }
  end(): void {
    if (!this.open || !this.gl || !this.extension) return;
    try {
      if (this.gl.isContextLost()) {
        this.contextLost();
        return;
      }
      if (!this.ownsActiveQuery()) {
        this.conflicts++;
        this.discard();
        return;
      }
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.open = false;
    } catch {
      this.fail();
    }
  }
  /** Non-blocking: returns a finished sample, or null while unavailable/discarded. */
  poll(): { frameId: number; ms: number } | null {
    const { gl, extension, query } = this;
    if (!gl || !extension || !query || this.open) return null;
    try {
      if (gl.isContextLost()) {
        this.contextLost();
        return null;
      }
      // Disjoint state is shared. Do not read/clear it while a different instrument owns the timer.
      if (!this.canMeasure() || gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) {
        this.conflicts++;
        this.discard();
        return null;
      }
      // Check even while the result is unavailable: disjoint invalidates the whole pending sample.
      if (gl.getParameter(extension.GPU_DISJOINT_EXT)) {
        this.disjoint++;
        this.discard();
        return null;
      }
      if (this.clock() - this.issuedAt > MAX_QUERY_AGE_MS) {
        this.expired++;
        this.discard();
        return null;
      }
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return null;
      const ns: unknown = gl.getQueryParameter(query, gl.QUERY_RESULT);
      this.discard();
      if (typeof ns !== 'number' || !Number.isFinite(ns) || ns < 0) {
        this.invalidResults++;
        return null;
      }
      this.samples++;
      return { frameId: this.queryFrame, ms: ns / 1e6 };
    } catch {
      this.fail();
      return null;
    }
  }
  /** Query objects die with the context; extensions must be re-acquired after restoration. */
  contextLost(): void {
    if (this.query || this.open) this.lostQueries++;
    this.query = undefined;
    this.open = false;
    this.extension = undefined;
    if (this.status === 'collecting') this.status = 'context-lost';
  }
  contextRestored(): void {
    if (this.status === 'disposed') return;
    this.acquire();
  }
  dispose(): void {
    try {
      if (this.open) this.end();
      this.discard();
    } catch {
      this.fail();
    }
    this.extension = undefined;
    this.status = 'disposed';
  }
}
