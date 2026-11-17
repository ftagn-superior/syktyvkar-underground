/** Page-local, bounded observations. This module never reads player payloads or sends data. */
export const HISTORY_LIMITS = {
  frames: 3600,
  events: 512,
  transitions: 128,
  samples: 240,
} as const;
export const FRAME_PHASES = [
  'loading',
  'ready',
  'connecting',
  'preparing',
  'waiting',
  'playing',
  'reconnecting',
  'error',
] as const;
export const HUD_REASONS = [
  'not-observed',
  'included',
  'not-playing',
  'input-disabled',
  'discarded-input',
  'warmup',
  'hidden',
  'invalid-interval',
] as const;
export type HudReason = (typeof HUD_REASONS)[number];
const FIELD_NAMES = [
  'reason',
  'code',
  'ok',
  'from',
  'to',
  'stage',
  'groupId',
  'cellId',
  'scopeId',
  'prepareId',
  'spawnSource',
  'count',
  'mapVersion',
  'layoutRevision',
  'layoutHash',
  'worldEpoch',
  'assetReleaseVersion',
  'quality',
  'cameraMode',
  'zoom',
  'renderWidth',
  'renderHeight',
  'drawRadius',
  'readyRadius',
  'shownRadius',
  'renderDeferred',
  'staticRefreshes',
  'staticDiscarded',
  'staticFallbacks',
  'rttMs',
  'ack',
  'ackAgeMs',
  'patchAgeMs',
  'pendingInputs',
  'serverTick',
  'serverStepMs',
  'predictionPauses',
  'replaySteps',
  'correctionCount',
  'correctionM',
  'stalled',
  'waitingResync',
  'storagePaused',
  'inputEnabled',
  'criticalReady',
  'backgroundReady',
  'connectionNumber',
  'hour',
  'clouds',
  'rain',
  'snow',
  'fog',
  'cacheBytes',
  'downloads',
  'cacheHits',
  'responseBodyBytes',
  'integrityRetries',
  'pendingDownloads',
  'httpActive',
  'contextSampledAtMs',
  'activateMs',
  'reconcileMs',
  'residencyMs',
  'releaseMs',
  'antialias',
  'pipeline',
  'msaaSamples',
  'hdr',
  'bloom',
  'bloomWeight',
  'bloomThreshold',
  'hardwareScaling',
  'shadows',
  'shadowMapSize',
  'drawCalls',
  'submittedTriangles',
  'nearGroups',
  'farGroups',
  'timeFixed',
  'shadowCasterInvalidations',
  'shadowSunStepInvalidations',
  'shadowFollowInvalidations',
  'shadowResizeInvalidations',
  'shadowQualityInvalidations',
  'shadowRetryInvalidations',
  'shadowContextInvalidations',
  'gpuSamples',
  'gpuDisjoint',
  'gpuBusySkips',
] as const;
export type DiagnosticFields = Partial<
  Record<(typeof FIELD_NAMES)[number], string | number | boolean | null>
>;
export type DiagnosticSpan =
  | 'stream.pump'
  | 'cell.connect'
  | 'cell.release'
  | 'cell.prepare'
  | 'publication.prepare'
  | 'publication.swap'
  | 'group.prepare'
  | 'group.activate'
  | 'group.reconcile'
  | 'group.residency'
  | 'group.release'
  | 'group.handoff'
  | 'group.adopt'
  | 'prediction.pause'
  | 'area.prepare';
type Observation = {
  sequence: number;
  name: string;
  atMs: number;
  frameId: number | null;
  lastFrameId: number | null;
  phase: string;
  timing: 'instant' | 'sync-elapsed' | 'async-elapsed';
  startMs?: number;
  startFrameId?: number | null;
  durationMs?: number;
  fields: DiagnosticFields;
};
const rounded = (n: number) => Math.round(n * 1000) / 1000;
/** Exported frame columns after frameId; one extra internal slot keeps the callback start. */
const FRAME_COLUMNS = [
  'atMs',
  'intervalMs',
  'workElapsedMs',
  'renderSubmitElapsedMs',
  'renderOutcome',
  'hudReason',
  'phase',
  'planningElapsedMs',
  'graphicsFrameCalls',
  'projectionRebuilds',
  'gpuRenderElapsedMs',
] as const;
const F = Object.fromEntries(FRAME_COLUMNS.map((name, i) => [name, i])) as Record<
  (typeof FRAME_COLUMNS)[number],
  number
>;
const STRIDE = FRAME_COLUMNS.length + 1,
  STARTED = FRAME_COLUMNS.length;

class Ring<T> {
  private readonly values: T[] = [];
  total = 0;
  constructor(readonly limit: number) {}
  push(value: T): void {
    this.values[this.total++ % this.limit] = value;
  }
  snapshot(): T[] {
    const count = Math.min(this.total, this.limit),
      first = this.total - count;
    return Array.from({ length: count }, (_, i) => this.values[(first + i) % this.limit]);
  }
  coverage() {
    return {
      limit: this.limit,
      total: this.total,
      overwritten: Math.max(0, this.total - this.limit),
    };
  }
}

export class SessionHistory {
  readonly runId: string;
  private readonly clock: () => number;
  private readonly wallClock: () => number;
  private readonly timeOriginMs: number;
  private readonly startedAtMs: number;
  private readonly startedUtcMs: number;
  private readonly frames = new Float64Array(HISTORY_LIMITS.frames * STRIDE);
  private frameCount = 0;
  private active = false;
  private activeOffset = 0;
  private boundaryPending = true;
  private visible = true;
  private phase = 'loading';
  private context: DiagnosticFields = {};
  private readonly events = new Ring<Observation>(HISTORY_LIMITS.events);
  private readonly transitions = new Ring<Observation>(HISTORY_LIMITS.transitions);
  private readonly samples = new Ring<Observation>(HISTORY_LIMITS.samples);
  private readonly peaks = new Map<DiagnosticSpan, Observation & { context: DiagnosticFields }>();
  private readonly peakDurations = new Map<DiagnosticSpan, number>();
  private readonly lastSamples = new Map<'render.sample' | 'network.sample', number>();
  private sequence = 0;
  private scopeSequence = 0;
  private readonly excluded = { hiddenCallbacks: 0, boundaryIntervals: 0, invalidIntervals: 0 };

  constructor(
    options: {
      clock?: () => number;
      wallClock?: () => number;
      timeOriginMs?: number;
      runId?: string;
    } = {},
  ) {
    this.clock = options.clock ?? (() => performance.now());
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.startedAtMs = this.clock();
    this.startedUtcMs = this.wallClock();
    this.timeOriginMs = options.timeOriginMs ?? performance.timeOrigin;
    this.runId =
      options.runId ??
      globalThis.crypto?.randomUUID?.() ??
      `local-${this.startedUtcMs}-${Math.random().toString(36).slice(2)}`;
  }
  get frameId(): number | null {
    return this.active ? this.frameCount : null;
  }
  get currentPhase(): string {
    return this.phase;
  }
  nextScope(): number {
    return ++this.scopeSequence;
  }
  private select(fields: DiagnosticFields): DiagnosticFields {
    const selected: DiagnosticFields = {};
    for (const key of FIELD_NAMES) {
      const value = fields[key];
      if (value === null || typeof value === 'boolean') selected[key] = value;
      else if (typeof value === 'string') selected[key] = value.slice(0, 128);
      else if (typeof value === 'number' && Number.isFinite(value)) selected[key] = rounded(value);
    }
    return selected;
  }
  setPhase(phase: string): void {
    if (phase === this.phase) return;
    const from = this.phase;
    this.phase = FRAME_PHASES.includes(phase as (typeof FRAME_PHASES)[number]) ? phase : 'error';
    this.event('connection.state', { from, to: this.phase });
  }
  setContext(fields: DiagnosticFields): void {
    this.context = { ...this.context, ...this.select(fields) };
  }
  boundary(reason: string): void {
    this.boundaryPending = true;
    this.event('frame.boundary', { reason });
  }
  visibility(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.boundary(visible ? 'visibility-resume' : 'visibility-hidden');
  }
  beginFrame(atMs: number, intervalMs: number, visible: boolean): void {
    this.visibility(visible);
    this.active = false;
    if (!visible) {
      this.excluded.hiddenCallbacks++;
      return;
    }
    const offset = (this.frameCount++ % HISTORY_LIMITS.frames) * STRIDE;
    let interval = intervalMs;
    if (this.boundaryPending) {
      interval = NaN;
      this.excluded.boundaryIntervals++;
    } else if (!Number.isFinite(interval) || interval <= 0) {
      interval = NaN;
      this.excluded.invalidIntervals++;
    }
    this.boundaryPending = false;
    const row = this.frames;
    row.fill(0, offset, offset + STRIDE);
    row[offset + F.atMs] = atMs;
    row[offset + F.intervalMs] = interval;
    row[offset + F.workElapsedMs] = row[offset + F.renderSubmitElapsedMs] = NaN;
    row[offset + F.gpuRenderElapsedMs] = NaN;
    row[offset + F.phase] = FRAME_PHASES.indexOf(this.phase as (typeof FRAME_PHASES)[number]);
    this.activeOffset = offset;
    this.active = true;
    row[offset + STARTED] = this.clock();
  }
  hud(reason: HudReason): void {
    if (this.active) this.frames[this.activeOffset + F.hudReason] = HUD_REASONS.indexOf(reason);
  }
  /** Synchronous area/visual planning wall time inside the current callback. */
  addPlanning(ms: number): void {
    if (this.active && ms >= 0) this.frames[this.activeOffset + F.planningElapsedMs] += ms;
  }
  /** Called on every camera-frame lookup; costs one increment, no clock read. */
  countGraphicsFrame(rebuilt: boolean): void {
    if (!this.active) return;
    this.frames[this.activeOffset + F.graphicsFrameCalls]++;
    if (rebuilt) this.frames[this.activeOffset + F.projectionRebuilds]++;
  }
  /** Attaches an asynchronous GPU result to the frame that issued it, if still retained. */
  gpuSample(frameId: number, ms: number): boolean {
    if (
      frameId < 1 ||
      frameId > this.frameCount ||
      this.frameCount - frameId >= HISTORY_LIMITS.frames
    )
      return false;
    this.frames[((frameId - 1) % HISTORY_LIMITS.frames) * STRIDE + F.gpuRenderElapsedMs] = ms;
    return true;
  }
  endFrame(
    outcome: 'rendered' | 'deferred' | 'failed',
    renderSubmitMs: number | null = null,
  ): void {
    if (!this.active) return;
    const offset = this.activeOffset;
    this.frames[offset + F.workElapsedMs] = Math.max(
      0,
      this.clock() - this.frames[offset + STARTED],
    );
    this.frames[offset + F.renderSubmitElapsedMs] = renderSubmitMs === null ? NaN : renderSubmitMs;
    this.frames[offset + F.renderOutcome] =
      outcome === 'rendered' ? 1 : outcome === 'deferred' ? 2 : 3;
    this.active = false;
  }
  private observation(name: string, fields: DiagnosticFields, atMs: number): Observation {
    return {
      sequence: ++this.sequence,
      name,
      atMs: rounded(atMs),
      frameId: this.frameId,
      lastFrameId: this.frameCount || null,
      phase: this.phase,
      timing: 'instant',
      fields: this.select(fields),
    };
  }
  wants(name: DiagnosticSpan, durationMs: number): boolean {
    return durationMs >= 4 || durationMs > (this.peakDurations.get(name) ?? -Infinity);
  }
  event(name: string, fields: DiagnosticFields = {}, atMs = this.clock()): void {
    this.append(this.observation(name, fields, atMs));
  }
  private append(value: Observation): void {
    this.events.push(value);
    if (
      /^(connection\.|area\.|spawn\.|hud\.|frame\.boundary|publication\.|render\.(quality|defer|camera)|graphics\.|prediction\.(pause|server-pause)$|input\.enabled$)/.test(
        value.name,
      )
    )
      this.transitions.push(value);
  }
  measure(
    name: DiagnosticSpan,
    startMs: number,
    endMs: number,
    fields: DiagnosticFields = {},
    timing: 'sync-elapsed' | 'async-elapsed' = 'sync-elapsed',
    startFrameId: number | null = this.frameId,
    always = false,
  ): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return;
    const durationMs = endMs - startMs;
    const isPeak = durationMs > (this.peakDurations.get(name) ?? -Infinity);
    if (!always && !isPeak && durationMs < 4) return;
    const observation = {
      ...this.observation(name, fields, endMs),
      timing,
      startMs: rounded(startMs),
      startFrameId,
      durationMs: rounded(durationMs),
    };
    if (isPeak) {
      this.peakDurations.set(name, durationMs);
      this.peaks.set(name, { ...observation, context: { ...this.context } });
    }
    this.append(observation);
  }
  sampleDue(name: 'render.sample' | 'network.sample', atMs: number): boolean {
    if (atMs - (this.lastSamples.get(name) ?? -Infinity) < 1000) return false;
    this.lastSamples.set(name, atMs);
    return true;
  }
  sample(name: 'render.sample' | 'network.sample', fields: DiagnosticFields, atMs: number): void {
    this.samples.push(this.observation(name, fields, atMs));
  }
  snapshot() {
    const exportedAtMs = this.clock(),
      count = Math.min(this.frameCount, HISTORY_LIMITS.frames);
    const first = this.frameCount - count;
    let validIntervals = 0;
    const samples = Array.from({ length: count }, (_, i) => {
      const offset = ((first + i) % HISTORY_LIMITS.frames) * STRIDE;
      if (Number.isFinite(this.frames[offset + F.intervalMs])) validIntervals++;
      const row: (number | null)[] = [first + i + 1];
      for (let n = 0; n < FRAME_COLUMNS.length; n++) {
        const value = this.frames[offset + n];
        row.push(Number.isFinite(value) ? rounded(value) : null);
      }
      return row;
    });
    const events = this.events.snapshot(),
      gauges = this.samples.snapshot(),
      transitions = this.transitions.snapshot();
    return {
      runId: this.runId,
      clock: {
        unit: 'ms',
        domain: 'performance.now',
        timeOriginUtcMs: this.timeOriginMs,
        start: { monoMs: this.startedAtMs, utcMs: this.startedUtcMs },
        export: { monoMs: exportedAtMs, utcMs: this.wallClock() },
        utcIsClientClock: true,
      },
      frames: {
        status: count ? 'recorded' : 'no-visible-render-loop-observations',
        limit: HISTORY_LIMITS.frames,
        sampleCount: count,
        validIntervalCount: validIntervals,
        total: this.frameCount,
        overwritten: Math.max(0, this.frameCount - count),
        firstFrameId: count ? first + 1 : null,
        lastFrameId: count ? this.frameCount : null,
        startMs: count ? samples[0][1] : null,
        endMs: count ? samples.at(-1)![1] : null,
        coveredDurationMs:
          count > 1
            ? rounded(
                this.frames[((this.frameCount - 1) % HISTORY_LIMITS.frames) * STRIDE] -
                  this.frames[(first % HISTORY_LIMITS.frames) * STRIDE],
              )
            : null,
        columns: ['frameId', ...FRAME_COLUMNS],
        renderOutcomes: ['unfinished', 'rendered', 'deferred', 'failed'],
        hudReasons: HUD_REASONS,
        phases: FRAME_PHASES,
        excluded: { ...this.excluded },
        samples,
      },
      events: {
        ...this.events.coverage(),
        startMs: events[0]?.atMs ?? null,
        endMs: events.at(-1)?.atMs ?? null,
        records: events,
      },
      transitions: {
        ...this.transitions.coverage(),
        startMs: transitions[0]?.atMs ?? null,
        endMs: transitions.at(-1)?.atMs ?? null,
        records: transitions,
      },
      samples: {
        ...this.samples.coverage(),
        nominalPeriodMsPerSource: 1000,
        startMs: gauges[0]?.atMs ?? null,
        endMs: gauges.at(-1)?.atMs ?? null,
        records: gauges,
      },
      peaks: Object.fromEntries(this.peaks),
    };
  }
}
