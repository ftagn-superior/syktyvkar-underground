import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionHistory } from '../diagnostics/session-history';
import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';
import { diagnosticReport } from './diagnostic-report';

const build = {
  version: '0.1.0',
  builtAt: '2026-11-17T10:00:00.000Z',
  commit: 'a'.repeat(40),
  buildId: 'release-client',
  dirty: false,
  source: 'git' as const,
};
function fixture(serverBuild?: unknown) {
  const history = new SessionHistory({
    runId: 'real-run',
    clock: () => 10,
    wallClock: () => 1000,
    timeOriginMs: 990,
  });
  history.beginFrame(10, 10, true);
  history.hud('warmup');
  history.endFrame('deferred');
  const session = {
    diagnosticHistory: history,
    info: { serverBuild, protocolVersion: 27, assetReleaseVersion: 'assets', catalogVersions: {} },
    manifest: { worldId: 'ring-block' },
    diagnostics: () => ({
      connection: 'playing',
      worldEpoch: 'epoch',
      mapVersion: 'map',
      publication: { layoutRevision: 8, layoutHash: 'layout' },
      preparations: [{ code: 'PLAN_REPLACED' }],
      frameP95Ms: null,
      frameSampleCount: 0,
      warmingUp: true,
      streaming: { entities: 3, resources: { cacheBytes: 123 } },
      physics: { entities: 2 },
      chat: 'PRIVATE',
      inventory: 'PRIVATE',
      token: 'SECRET',
      entities: ['PRIVATE'],
    }),
  } as unknown as GameSession;
  const view = {
    renderingDiagnostics: () => ({
      dynamicEntities: ['PRIVATE'],
      quality: 'economy',
      camera: { mode: 'overview', zoom: 1.35 },
      capabilities: { timerQuerySupported: true },
    }),
  } as unknown as WorldView;
  vi.stubGlobal('__SU_BUILD_INFO__', build);
  vi.stubGlobal('navigator', { userAgent: 'fixture', language: 'ru' });
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  return { session, view };
}
afterEach(() => vi.unstubAllGlobals());
describe('downloaded diagnostic JSON v3', () => {
  it('includes real raw observations even when legacy HUD p95 is empty', () => {
    const { session, view } = fixture();
    const report = JSON.parse(JSON.stringify(diagnosticReport(session, view, false)));
    expect(report.formatVersion).toBe(3);
    expect(report.metrics).toMatchObject({
      frameP95Ms: null,
      frameSampleCount: 0,
      warmingUp: true,
    });
    expect(report.history.frames.sampleCount).toBe(1);
    expect(report.history.frames.samples[0][5]).toBe(2);
    expect(report.rendering.camera.mode).toBe('overview');
    expect(report.preparations[0].code).toBe('PLAN_REPLACED');
  });
  it('keeps client/server artifacts distinct and remains compatible with a v27 server omitting metadata', () => {
    const { session, view } = fixture();
    const unknown = diagnosticReport(session, view, false);
    expect(unknown.build.commit).toBe(build.commit);
    expect(unknown.server).toMatchObject({ status: 'unknown', build: null, protocolVersion: 27 });
    const server = { ...build, commit: 'b'.repeat(40), buildId: 'server-release' };
    session.info.serverBuild = server;
    expect(diagnosticReport(session, view, false).server.build?.commit).toBe(server.commit);
  });
  it('does not invent system utilization/VRAM or GPU timer samples from supported capabilities', () => {
    const { session, view } = fixture();
    const report = diagnosticReport(session, view, false);
    // Supported but not opted in (`?gpuTiming=1`): no per-frame GPU values exist.
    expect(report.measurements.gpuTimer).toMatchObject({ status: 'not-collected' });
    expect(report.measurements.gpuTimer).not.toHaveProperty('samples');
    expect(report.history.frames.samples.every((row) => row.at(-1) === null)).toBe(true);
    expect(report.measurements.gpuUtilization.value).toBeNull();
    expect(report.measurements.cpuUtilization.value).toBeNull();
    expect(report.measurements.physicalVram.value).toBeNull();
    expect(diagnosticReport(session, view, true).measurements.gpuTimer.status).toBe('context-lost');
    expect(diagnosticReport(session, undefined, true).measurements.gpuTimer.status).toBe(
      'no-context',
    );
  });
  it('keeps selected report data but excludes arbitrary player payloads and credentials', () => {
    const { session, view } = fixture({ ...build, token: 'SECRET' });
    const json = JSON.stringify(diagnosticReport(session, view, false));
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('PRIVATE');
    expect(JSON.parse(json).streaming.resources.cacheBytes).toBe(123);
  });
});
