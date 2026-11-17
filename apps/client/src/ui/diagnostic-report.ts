import {
  PROTOCOL_VERSION,
  WORLD_FORMAT_VERSION,
  readBuildIdentity,
  type BuildIdentity,
} from '@su/contracts';
import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';
import { CLIENT_CATALOG_VERSIONS } from '../presentation/catalog-versions';

declare const __SU_BUILD_INFO__: BuildIdentity;

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export const DIAGNOSTIC_SEMANTICS = {
  elapsed:
    'Measured monotonic wall durations, not CPU execution time or utilization; async-elapsed includes waits.',
  frames:
    'Visible WorldView callbacks, including warmup/preparation/deferred. Not physical display presentation. HUD filters do not filter this ring.',
  frameOutcome:
    'rendered means scene.render returned; it does not prove GPU completion. Deferred means no scene.render call.',
  current: [
    'rendering',
    'physics',
    'streaming.ready',
    'streaming.criticalReady',
    'streaming.backgroundReady',
    'streaming.resources.cacheBytes',
    'metrics.rttMs',
    'metrics.serverStepMs',
    'metrics.pendingInputs',
  ],
  cumulative: [
    'rendering.deferredFrames',
    'rendering.shadowMaps.staticRefreshes',
    'rendering.shadowMaps.staticDiscarded',
    'rendering.shadowMaps.staticFallbacks',
    'prediction.pauses',
    'prediction.replaySteps',
    'prediction.worlds',
    'metrics.correctionCount',
    'streaming.resources.downloads',
    'streaming.resources.cacheHits',
    'streaming.resources.responseBodyBytes',
    'streaming.resources.integrityRetries',
  ],
  cumulativeScope:
    'Owning view/streamer/resource context lifetime, not necessarily the whole run. stream.created scope IDs identify new streamers; old legacy fields have no retrospective timestamps.',
  rolling: { hudFrames: 3600, corrections: 3600, operations: 4096, http: 256, preparations: 32 },
  legacyPeaks:
    'Lifetime maxima of their owning objects; only history.peaks have newly recorded time/context. History covers observations after this client loaded.',
  memory:
    'cacheBytes counts retained decoded byte-cache payloads. Geometry/CPU-array/texture payload values are estimates with overlap, not RAM/RSS/physical VRAM; do not add them.',
  httpBytes:
    'responseBodyBytes counts decoded HTTP bodies including retries, not wire transfer, retained memory, or WebSocket traffic.',
  histories:
    'Independent bounded rings: overwritten counts mean overwritten observations, not lost display frames. No fixed time retention. Peaks survive ring eviction.',
  correlation:
    'frameId identifies a visible callback; async completion between callbacks has frameId=null and lastFrameId as a reference, not causal attribution. Peaks include last sampled render context, which can be older than the span.',
  eventSampling:
    'Group handoffs/substages and area results are retained; ordinary cell/pump spans retain >=4 ms and new maxima. Corrections log >=0.05 m, all observations still contribute to cumulative count.',
  sampleFields: {
    current:
      'quality/camera/zoom, render dimensions (pixels), radii (world meters), hour, weather mix (0..1), RTT/ack/patch ages and server step (ms), readiness/connection flags, pending counts and cacheBytes (bytes).',
    cumulative:
      'staticRefreshes/staticDiscarded/staticFallbacks per renderer; predictionPauses/replaySteps/correctionCount per GameSession; downloads/cacheHits/responseBodyBytes/integrityRetries per resource context. No deltas/rates are implied.',
    sequence: 'ack is lastProcessed input sequence; serverTick is authoritative server tick.',
  },
} as const;

/** Deliberate field selection: session credentials and entity snapshots are not a report. */
export function diagnosticReport(
  session: GameSession,
  view: WorldView | undefined,
  graphicsLost: boolean,
) {
  const data = session.diagnostics();
  const rendererSnapshot = view?.renderingDiagnostics();
  const { dynamicEntities: _dynamic, ...rendering } = rendererSnapshot ?? {};
  const { entities: staticCount, ...streaming } = data.streaming ?? {};
  const { entities: physicsStaticCount, ...physics } = data.physics ?? {};
  const clientBuild = typeof __SU_BUILD_INFO__ === 'undefined' ? null : __SU_BUILD_INFO__;
  const serverBuild = readBuildIdentity(session.info?.serverBuild);
  const heap = (
    performance as Performance & {
      memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
    }
  ).memory;
  return {
    formatVersion: 3,
    generatedAt: new Date().toISOString(),
    build: {
      version: clientBuild?.version ?? null,
      builtAt: clientBuild?.builtAt ?? null,
      commit: clientBuild?.commit ?? null,
      buildId: clientBuild?.buildId ?? null,
      dirty: clientBuild?.dirty ?? null,
      source: clientBuild?.source ?? 'unavailable',
      mode: import.meta.env.MODE,
    },
    server: {
      build: serverBuild,
      status: serverBuild ? 'reported' : 'unknown',
      source: '/api/world',
      protocolVersion: session.info?.protocolVersion ?? null,
      catalogVersions: session.info?.catalogVersions ?? null,
    },
    publication: {
      worldId: session.manifest?.worldId ?? null,
      worldEpoch: data.worldEpoch ?? null,
      mapVersion: data.mapVersion ?? null,
      layoutRevision: data.publication?.layoutRevision ?? null,
      layoutHash: data.publication?.layoutHash ?? null,
      assetReleaseVersion: session.info?.assetReleaseVersion ?? null,
    },
    history: session.diagnosticHistory.snapshot(),
    semantics: DIAGNOSTIC_SEMANTICS,
    measurements: {
      cpuUtilization: {
        value: null,
        status: 'unavailable-in-page',
        unit: 'percent',
        scope: 'process/system',
      },
      gpuUtilization: {
        value: null,
        status: 'unavailable-in-page',
        unit: 'percent',
        scope: 'adapter/process',
      },
      processRam: {
        value: null,
        status: 'unavailable-in-page',
        unit: 'bytes',
        scope: 'browser-process',
      },
      physicalVram: {
        value: null,
        status: 'unavailable-in-page',
        unit: 'bytes',
        scope: 'adapter/process',
      },
      gpuTimer: {
        samples: [],
        status: !view
          ? 'no-context'
          : graphicsLost
            ? 'context-lost'
            : rendererSnapshot?.capabilities?.timerQuerySupported
              ? 'not-collected'
              : 'unsupported',
        unit: 'ms',
        source: 'WebGL disjoint timer query',
        scope: 'game-context',
      },
      jsHeap: {
        status: finite(heap?.usedJSHeapSize) === null ? 'unavailable' : 'reported',
        source: 'performance.memory (non-standard)',
        unit: 'bytes',
        scope: 'browser-defined JS heap; partial',
        usedBytes: finite(heap?.usedJSHeapSize),
        allocatedBytes: finite(heap?.totalJSHeapSize),
        limitBytes: finite(heap?.jsHeapSizeLimit),
      },
      availability: {
        connection: !!session.room,
        physics: !!data.preparationConfirmed,
        legacyZeroDefaults:
          'Legacy metrics may default to zero before connection/physics; network history uses null for missing sources.',
      },
    },
    catalogVersions: CLIENT_CATALOG_VERSIONS,
    environment: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      visibility: document.visibilityState,
      graphics: graphicsLost ? 'unavailable' : view ? 'ready' : 'loading',
    },
    versions: {
      protocol: PROTOCOL_VERSION,
      worldFormat: WORLD_FORMAT_VERSION,
      map: data.mapVersion ?? null,
      simulation: data.simulationConfigHash ?? null,
    },
    rendering: view ? rendering : null,
    streaming: data.streaming ? { ...streaming, staticCount } : null,
    physics: data.physics ? { ...physics, staticCount: physicsStaticCount } : null,
    prediction: {
      historyInputs: data.historyInputs,
      historyCells: data.historyCells,
      historyMaxAgeMs: data.historyMaxAgeMs,
      pauses: data.predictionPauses,
      replaySteps: data.replaySteps,
      worlds: data.predictionWorlds,
    },
    preparations: data.preparations,
    metrics: {
      connection: data.connection,
      playerCount: data.playerCount,
      occupancy: data.occupancy,
      rttMs: data.rttMs,
      frameP95Ms: data.frameP95Ms,
      frameSampleCount: data.frameSampleCount,
      warmingUp: data.warmingUp,
      frameWarmupSeconds: 60,
      frameWindowLimit: 3600,
      serverStepMs: data.serverStepMs,
      serverTick: data.serverTick,
      correctionP95: data.correctionP95,
      correctionMax: data.correctionMax,
      correctionCount: data.correctionCount,
      pendingInputs: data.pendingInputs,
      stalled: data.stalled,
    },
  };
}

export function downloadDiagnosticReport(report: ReturnType<typeof diagnosticReport>): void {
  const blob = new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `syktyvkar-diagnostics-${report.generatedAt.replace(/[:.]/g, '-')}.json`;
  link.click();
  // Give the browser time to start the download before releasing the backing blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
