import { PROTOCOL_VERSION, WORLD_FORMAT_VERSION } from '@su/contracts';
import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';

declare const __SU_BUILD_INFO__: { version: string; builtAt: string };

/** Deliberate field selection: session credentials and entity snapshots are not a report. */
export function diagnosticReport(
  session: GameSession,
  view: WorldView | undefined,
  graphicsLost: boolean,
) {
  const data = session.diagnostics();
  const { dynamicEntities: _dynamic, ...rendering } = view?.renderingDiagnostics() ?? {};
  const { entities: staticCount, ...streaming } = data.streaming ?? {};
  const { entities: physicsStaticCount, ...physics } = data.physics ?? {};
  return {
    formatVersion: 2,
    generatedAt: new Date().toISOString(),
    build: { ...__SU_BUILD_INFO__, mode: import.meta.env.MODE },
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
