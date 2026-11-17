type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
export type GpuTimerStatus = 'collecting' | 'unsupported' | 'context-lost';

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
  private extension?: TimerExtension;
  private query?: WebGLQuery;
  private queryFrame = 0;
  private open = false;
  private calls = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext | null,
    private readonly every = 30,
  ) {
    this.acquire();
  }
  private acquire(): void {
    this.extension =
      (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null) ??
      undefined;
    this.status = this.extension ? 'collecting' : 'unsupported';
  }
  /** Starts a sample for this frame when due and no earlier result is outstanding. */
  begin(frameId: number | null): void {
    const { gl, extension } = this;
    if (!gl || !extension || frameId === null || this.open || this.calls++ % this.every) return;
    if (this.query) {
      this.busySkips++;
      return;
    }
    gl.getParameter(extension.GPU_DISJOINT_EXT); // Reading clears a stale disjoint flag.
    const query = gl.createQuery();
    if (!query) return;
    gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
    this.query = query;
    this.queryFrame = frameId;
    this.open = true;
  }
  end(): void {
    if (!this.open || !this.gl || !this.extension) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.open = false;
  }
  /** Non-blocking: returns a finished sample, or null while unavailable/discarded. */
  poll(): { frameId: number; ms: number } | null {
    const { gl, extension, query } = this;
    if (!gl || !extension || !query || this.open) return null;
    if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return null;
    const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT) as boolean;
    const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
    gl.deleteQuery(query);
    this.query = undefined;
    if (disjoint) {
      this.disjoint++;
      return null;
    }
    this.samples++;
    return { frameId: this.queryFrame, ms: ns / 1e6 };
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
    this.acquire();
  }
  dispose(): void {
    if (this.open) this.end();
    if (this.query && this.extension) this.gl?.deleteQuery(this.query);
    this.query = undefined;
    this.extension = undefined;
  }
}
