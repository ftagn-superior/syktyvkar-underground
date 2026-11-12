/** Bounded raw window plus a cumulative 0.1 ms histogram (overflow retains the real maximum). */
export class DurationMetric {
  private readonly samples: number[] = [];
  private readonly histogram = new Uint32Array(1001);
  private count = 0;
  private total = 0;
  private maximum = 0;
  private readonly startedAt = performance.now();
  record(ms: number) {
    this.samples.push(ms);
    if (this.samples.length > 3600) this.samples.shift();
    this.histogram[Math.min(1000, Math.ceil(ms * 10))]++;
    this.count++;
    this.total += ms;
    this.maximum = Math.max(this.maximum, ms);
  }
  snapshot() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const cumulative = (fraction: number) => {
      let count = 0;
      for (let i = 0; i < this.histogram.length; i++) {
        count += this.histogram[i];
        if (count >= Math.ceil(this.count * fraction)) return i === 1000 ? this.maximum : i / 10;
      }
      return 0;
    };
    return {
      count: this.count,
      totalMs: this.total,
      maxMs: this.maximum,
      p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0,
      p99Ms: sorted[Math.floor((sorted.length - 1) * 0.99)] ?? 0,
      cumulativeP95Ms: this.count ? cumulative(0.95) : null,
      cumulativeP99Ms: this.count ? cumulative(0.99) : null,
      windowSamples: this.samples.length,
      windowLimit: 3600,
      elapsedSeconds: (performance.now() - this.startedAt) / 1000,
    };
  }
}
