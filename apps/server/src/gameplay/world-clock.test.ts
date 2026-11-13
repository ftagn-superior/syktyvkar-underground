import { describe, expect, it } from 'vitest';
import { DEFAULT_DAY_CLOCK, dayClockHour, type DayClockAction } from '@su/contracts';
import { ActionLedger } from './action-ledger.js';
import { WorldClock } from './world-clock.js';

const now = 1_800_000_123_456;
function fixture() {
  const state = {
    dayOffsetMs: DEFAULT_DAY_CLOCK.offsetMs,
    dayFrozenHour: DEFAULT_DAY_CLOCK.frozenHour,
  };
  return { state, clock: new WorldClock(state) };
}

describe('room day clock commands', () => {
  it('shares one change cooldown and lets players read time without consuming it', () => {
    const { state, clock } = fixture();
    expect(clock.command(undefined, now)).toMatchObject({ ok: true, retryAfterMs: 0 });
    expect(clock.command({ kind: 'set', hour: 18.5 }, now)).toEqual({
      ok: true,
      retryAfterMs: 1000,
      message: 'Время идёт: 18:30.',
    });
    const changed = { ...state };
    expect(clock.command({ kind: 'stop' }, now + 500)).toMatchObject({
      ok: false,
      code: 'RATE_LIMITED',
      retryAfterMs: 500,
    });
    expect(state).toEqual(changed);
    expect(clock.command(undefined, now + 500)).toMatchObject({ ok: true, retryAfterMs: 0 });
    expect(clock.command({ kind: 'stop' }, now + 1000)).toEqual({
      ok: true,
      retryAfterMs: 1000,
      message: 'Время остановлено: 18:31.',
    });
  });

  it('keeps set on a frozen clock frozen, resumes from it, and resets the replicated state', () => {
    const { state, clock } = fixture();
    clock.command({ kind: 'stop' }, now);
    expect(clock.command({ kind: 'set', hour: 7 }, now + 1000)).toMatchObject({
      message: 'Время остановлено: 07:00.',
    });
    expect(state.dayFrozenHour).toBe(7);
    expect(clock.command({ kind: 'start' }, now + 2000)).toMatchObject({
      message: 'Время идёт: 07:00.',
    });
    expect(state.dayFrozenHour).toBe(-1);
    expect(
      dayClockHour({ offsetMs: state.dayOffsetMs, frozenHour: state.dayFrozenHour }, now + 62_000),
    ).toBeCloseTo(8, 3);
    expect(clock.command({ kind: 'reset' }, now + 3000)).toMatchObject({
      ok: true,
      message: expect.stringContaining('Часы идут по общему времени:'),
    });
    expect(state).toEqual({ dayOffsetMs: 0, dayFrozenHour: -1 });
  });

  it('replays a completed command through the shared ledger without changing the clock again', () => {
    const { state, clock } = fixture();
    const actions = new ActionLedger();
    const execute = (requestId: number, change: DayClockAction, at: number) => {
      const admission = actions.begin({ requestId, worldEpoch: 'world' });
      if (admission.kind === 'result') return admission.result;
      if (admission.kind !== 'new') throw new Error('Unexpected action admission');
      const result = { requestId, ...clock.command(change, at) };
      actions.remember(result);
      return result;
    };
    const set = execute(1, { kind: 'set', hour: 12 }, now);
    execute(2, { kind: 'stop' }, now + 1000);
    const frozen = { ...state };
    expect(execute(1, { kind: 'reset' }, now + 2000)).toEqual(set);
    expect(state).toEqual(frozen);
    expect(execute(3, { kind: 'start' }, now + 2000).ok).toBe(true);
  });

  it('keeps room clocks independent and restores the default in a new room', () => {
    const first = fixture();
    first.clock.command({ kind: 'stop' }, now);
    const second = fixture();
    expect(second.state).toEqual({ dayOffsetMs: 0, dayFrozenHour: -1 });
    expect(second.clock.command({ kind: 'set', hour: 6 }, now).ok).toBe(true);
    expect(first.state.dayFrozenHour).toBeGreaterThanOrEqual(0);
    expect(second.state.dayFrozenHour).toBe(-1);
  });
});
