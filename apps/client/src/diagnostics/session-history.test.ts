import { describe, expect, it } from 'vitest';
import { HISTORY_LIMITS, HUD_REASONS, SessionHistory } from './session-history';

function recorder() {
  let now = 0,
    wall = 1_800_000_000_000;
  const history = new SessionHistory({
    clock: () => now,
    wallClock: () => wall,
    timeOriginMs: wall,
    runId: 'fixture-run',
  });
  return {
    history,
    at(value: number) {
      now = value;
    },
    wall(value: number) {
      wall = value;
    },
  };
}

describe('real-session diagnostic history contract', () => {
  it('keeps frames running if an external sample getter throws, and counts incomplete observations', () => {
    const r = recorder();
    r.history.beginFrame(10, 10, true);
    expect(() =>
      r.history.sampleSafely(
        'render.sample',
        () => {
          throw new Error('source failure');
        },
        10,
        true,
      ),
    ).not.toThrow();
    r.history.endFrame('rendered', 1);
    const data = r.history.snapshot();
    expect(data.frames.samples[0][5]).toBe(1);
    expect(data.samples.failures['render.sample']).toBe(1);
    expect(data.samples.records).toHaveLength(0);
    expect(data.events.records.at(-1)?.name).toBe('diagnostic.sample-error');
  });
  it('keeps warmup and deferred frame intervals independently of HUD filtering', () => {
    const r = recorder();
    r.history.setPhase('preparing');
    r.at(20);
    r.history.beginFrame(20, 20, true);
    r.history.hud('not-playing');
    r.at(30);
    r.history.endFrame('deferred');
    r.at(50);
    r.history.beginFrame(50, 30, true);
    r.history.hud('warmup');
    r.at(55);
    r.history.endFrame('rendered', 2);
    const frame = r.history.snapshot().frames;
    expect(frame.sampleCount).toBe(2);
    expect(frame.validIntervalCount).toBe(1);
    expect(frame.samples[0]).toEqual([
      1,
      20,
      null,
      10,
      null,
      2,
      HUD_REASONS.indexOf('not-playing'),
      3,
      0,
      0,
      0,
      null,
    ]);
    expect(frame.samples[1]).toEqual([
      2,
      50,
      30,
      5,
      2,
      1,
      HUD_REASONS.indexOf('warmup'),
      3,
      0,
      0,
      0,
      null,
    ]);
    expect(frame.coveredDurationMs).toBe(30);
  });

  it('does not turn a hidden interval into a hitch or discard a real visible hitch', () => {
    const r = recorder();
    r.at(10);
    r.history.beginFrame(10, 10, true);
    r.history.endFrame('rendered');
    r.at(100);
    r.history.beginFrame(100, 90, false);
    r.at(10_000);
    r.history.beginFrame(10_000, 9900, true);
    r.history.endFrame('rendered');
    r.at(10_307);
    r.history.beginFrame(10_307, 307, true);
    r.history.endFrame('rendered');
    const snapshot = r.history.snapshot();
    expect(snapshot.frames.samples.map((f) => f[2])).toEqual([null, null, 307]);
    expect(snapshot.frames.excluded).toEqual({
      hiddenCallbacks: 1,
      boundaryIntervals: 2,
      invalidIntervals: 0,
    });
    expect(snapshot.transitions.records.map((e) => e.fields.reason)).toEqual([
      'visibility-hidden',
      'visibility-resume',
    ]);
  });

  it('retains chronological IDs and explicitly counts overwrites at high refresh rates', () => {
    const r = recorder();
    for (let i = 1; i <= HISTORY_LIMITS.frames + 17; i++) {
      r.at(i * 7);
      r.history.beginFrame(i * 7, 7, true);
      r.history.endFrame('rendered');
    }
    const frames = r.history.snapshot().frames;
    expect(frames.sampleCount).toBe(3600);
    expect(frames.overwritten).toBe(17);
    expect(frames.firstFrameId).toBe(18);
    expect(frames.samples[0][0]).toBe(18);
    expect(frames.samples.at(-1)![0]).toBe(3617);
  });

  it('preserves peak context and spawn replacement after frequent event eviction', () => {
    const r = recorder();
    r.history.setContext({ quality: 'economy', mapVersion: 'publication-a' });
    r.at(10);
    r.history.beginFrame(10, 10, true);
    r.at(317);
    r.history.measure(
      'group.handoff',
      10,
      317,
      { groupId: 'g1', from: 'far', to: 'near' },
      'sync-elapsed',
      1,
      true,
    );
    r.history.endFrame('deferred');
    r.history.event('area.plan', { prepareId: 'saved-plan', spawnSource: 'saved' });
    r.history.measure(
      'area.prepare',
      0,
      317,
      { prepareId: 'saved-plan' },
      'async-elapsed',
      null,
      true,
    );
    r.history.event('area.result', { prepareId: 'saved-plan', code: 'PLAN_REPLACED', ok: false });
    r.history.event('spawn.fallback', { from: 'saved', to: 'default' });
    r.history.setContext({ quality: 'standard', mapVersion: 'publication-b' });
    for (let i = 0; i < 600; i++) {
      r.at(400 + i);
      r.history.event('cell.detail');
    }
    const snapshot = r.history.snapshot();
    expect(snapshot.events.overwritten).toBeGreaterThan(0);
    expect(snapshot.transitions.records.map((e) => e.name)).toEqual([
      'area.plan',
      'area.prepare',
      'area.result',
      'spawn.fallback',
    ]);
    expect(snapshot.transitions.records[1].durationMs).toBe(317);
    expect(snapshot.peaks['group.handoff']).toMatchObject({
      startMs: 10,
      atMs: 317,
      startFrameId: 1,
      frameId: 1,
      durationMs: 307,
      context: { quality: 'economy', mapVersion: 'publication-a' },
    });
  });

  it('retains the actual maximum when serialized durations round to the same value', () => {
    const r = recorder();
    r.history.measure('cell.connect', 0, 1.0004, { cellId: 'maximum' });
    expect(r.history.wants('cell.connect', 1.0002)).toBe(false);
    r.history.measure('cell.connect', 0, 1.0002, { cellId: 'smaller' });
    expect(r.history.snapshot().peaks['cell.connect'].fields.cellId).toBe('maximum');
  });

  it('distinguishes async wait completion from work inside a render callback', () => {
    const r = recorder();
    r.at(20);
    r.history.beginFrame(20, 20, true);
    r.history.endFrame('rendered');
    r.at(26_000);
    r.history.measure('group.prepare', 20, 26_000, { groupId: 'g1' }, 'async-elapsed', 1, true);
    expect(r.history.snapshot().peaks['group.prepare']).toMatchObject({
      timing: 'async-elapsed',
      frameId: null,
      lastFrameId: 1,
      startFrameId: 1,
      durationMs: 25_980,
    });
  });

  it('keeps explicit clock anchors and does not reset raw frames on HUD reset', () => {
    const r = recorder();
    r.at(100);
    r.history.beginFrame(100, 100, true);
    r.history.endFrame('rendered');
    r.history.event('hud.reset', { reason: 'quality-changed', count: 0 });
    r.wall(1_800_000_001_000);
    r.at(110);
    const snapshot = r.history.snapshot();
    expect(snapshot.clock.start).toEqual({ monoMs: 0, utcMs: 1_800_000_000_000 });
    expect(snapshot.clock.export).toEqual({ monoMs: 110, utcMs: 1_800_000_001_000 });
    expect(snapshot.frames.sampleCount).toBe(1);
    expect(JSON.parse(JSON.stringify(snapshot)).transitions.records[0].fields.reason).toBe(
      'quality-changed',
    );
  });

  it('keeps samples bounded and absent observations explicitly absent', () => {
    const r = recorder();
    const empty = r.history.snapshot();
    expect(empty.frames.status).toBe('no-visible-render-loop-observations');
    expect(empty.frames.startMs).toBeNull();
    expect(empty.frames.coveredDurationMs).toBeNull();
    expect(r.history.sampleDue('network.sample', 0)).toBe(true);
    expect(r.history.sampleDue('network.sample', 999)).toBe(false);
    for (let i = 0; i < 250; i++)
      r.history.sample('network.sample', { rttMs: null, replaySteps: i }, i * 1000);
    const sample = r.history.snapshot().samples;
    expect(sample.records).toHaveLength(240);
    expect(sample.overwritten).toBe(10);
    expect(sample.records[0].fields.rttMs).toBeNull();
  });

  it('does not serialize credentials, coordinates, arbitrary payloads or non-finite numbers', () => {
    const r = recorder();
    r.history.event('area.result', {
      prepareId: 'id',
      code: 'PLAN_REPLACED',
      rttMs: NaN,
      // Deliberately simulate a future accidental spread of a game payload.
      ...({
        token: 'SECRET',
        chat: 'PRIVATE',
        position: { x: 42 },
        inventory: ['PRIVATE'],
      } as object),
    });
    const json = JSON.stringify(r.history.snapshot());
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('PRIVATE');
    expect(json).not.toContain('position');
    expect(json).not.toContain('NaN');
    expect(r.history.snapshot().events.records[0].fields).toEqual({
      prepareId: 'id',
      code: 'PLAN_REPLACED',
    });
  });

  it('attributes re-planning work and asynchronous GPU results to the issuing frame', () => {
    const r = recorder();
    r.at(10);
    r.history.beginFrame(10, 10, true);
    r.history.addPlanning(1.5);
    r.history.addPlanning(0.25);
    for (let i = 0; i < 5; i++) r.history.countGraphicsFrame(i === 0);
    r.history.endFrame('rendered', 3);
    // Outside a callback nothing is attributed to the previous frame.
    r.history.countGraphicsFrame(true);
    r.history.addPlanning(9);
    r.at(30);
    r.history.beginFrame(30, 20, true);
    expect(r.history.gpuSample(1, 7.25)).toBe(true);
    r.history.endFrame('rendered', 2);
    const [first, second] = r.history.snapshot().frames.samples;
    const columns = r.history.snapshot().frames.columns;
    const at = (row: (number | null)[], name: string) => row[columns.indexOf(name as never)];
    expect(at(first, 'planningElapsedMs')).toBe(1.75);
    expect(at(first, 'graphicsFrameCalls')).toBe(5);
    expect(at(first, 'projectionRebuilds')).toBe(1);
    expect(at(first, 'gpuRenderElapsedMs')).toBe(7.25);
    expect(at(second, 'gpuRenderElapsedMs')).toBeNull();
    expect(at(second, 'graphicsFrameCalls')).toBe(0);
    // A late result for an overwritten or future frame is dropped, not misattributed.
    expect(r.history.gpuSample(3, 1)).toBe(false);
    for (let i = 0; i < HISTORY_LIMITS.frames; i++) {
      r.history.beginFrame(40 + i, 1, true);
      r.history.endFrame('rendered');
    }
    expect(r.history.gpuSample(1, 1)).toBe(false);
  });

  it('keeps every WorldEnvironment weather amount the render sample spreads in', () => {
    const r = recorder();
    const weather = { rain: 0, snow: 0, fog: 0.2, overcast: 0.7, wetness: 0.1, snowCover: 0 };
    r.history.sample('render.sample', weather, 0);
    expect(r.history.snapshot().samples.records[0].fields).toEqual(weather);
  });
});
