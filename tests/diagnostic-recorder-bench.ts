/**
 * Node micro-benchmark of the S-60 recorder's own per-frame bookkeeping and snapshot cost.
 * It isolates recorder code from rendering; browser A/B is tests/browser-diagnostic-overhead.ts.
 *   node --import tsx tests/diagnostic-recorder-bench.ts
 */
import { SessionHistory } from '../apps/client/src/diagnostics/session-history';

const history = new SessionHistory({ runId: 'bench' });
const lookups = Number(process.env.SU_BENCH_LOOKUPS ?? 1200); // S-63: 1,176-4,225 per frame.
const frame = (i: number) => {
  const now = performance.now();
  history.beginFrame(now, 16.7, true);
  history.hud('included');
  history.addPlanning(0.5);
  history.addPlanning(0.2);
  for (let n = 0; n < lookups; n++) history.countGraphicsFrame(n === 0);
  history.measure('stream.pump', now, now + 1, { scopeId: 1 }); // Below threshold: dropped.
  if (i % 60 === 0) history.sample('network.sample', { rttMs: 40, replaySteps: i }, now);
  if (i % 10 === 0)
    history.measure(
      'group.handoff',
      now,
      now + 0.3,
      { groupId: 'g', activateMs: 0.1 },
      'sync-elapsed',
      i,
      true,
    );
  history.endFrame('rendered', 2);
};
for (let i = 0; i < 20_000; i++) frame(i); // Warm up and fill every ring.
const frames = 200_000;
let started = performance.now();
for (let i = 0; i < frames; i++) frame(i);
const perFrameUs = ((performance.now() - started) * 1000) / frames;
started = performance.now();
const snapshots = 20;
let bytes = 0;
for (let i = 0; i < snapshots; i++) bytes = JSON.stringify(history.snapshot()).length;
const snapshotMs = (performance.now() - started) / snapshots;
console.log(
  JSON.stringify({
    graphicsFrameLookupsPerFrame: lookups,
    recorderMicrosecondsPerFrame: Number(perFrameUs.toFixed(3)),
    fullHistorySnapshotAndStringifyMs: Number(snapshotMs.toFixed(2)),
    fullHistoryCompactJsonBytes: bytes,
    node: process.version,
  }),
);
