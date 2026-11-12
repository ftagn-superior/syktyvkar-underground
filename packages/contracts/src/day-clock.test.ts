import { describe, expect, it } from 'vitest';
import {
  DAY_LENGTH_MS,
  DEFAULT_DAY_CLOCK,
  applyDayClockAction,
  dayClockHour,
  formatGameHour,
  hourAt,
} from './day-clock.js';

const now = 1_800_000_123_456;

describe('world day clock', () => {
  it('follows wall-clock time by default', () => {
    expect(dayClockHour(DEFAULT_DAY_CLOCK, now)).toBe(hourAt(now));
  });

  it('sets the hour and keeps running from it', () => {
    const clock = applyDayClockAction(DEFAULT_DAY_CLOCK, { kind: 'set', hour: 18.5 }, now);
    expect(clock.frozenHour).toBeLessThan(0);
    expect(clock.offsetMs).toBeGreaterThanOrEqual(0);
    expect(clock.offsetMs).toBeLessThan(DAY_LENGTH_MS);
    expect(Number.isInteger(clock.offsetMs)).toBe(true);
    expect(dayClockHour(clock, now)).toBeCloseTo(18.5, 3);
    expect(dayClockHour(clock, now + DAY_LENGTH_MS / 24)).toBeCloseTo(19.5, 3);
  });

  it('stops at the current hour and resumes from it later', () => {
    const set = applyDayClockAction(DEFAULT_DAY_CLOCK, { kind: 'set', hour: 6 }, now);
    const stopped = applyDayClockAction(set, { kind: 'stop' }, now + 60_000);
    expect(dayClockHour(stopped, now + 60_000)).toBeCloseTo(7, 3);
    expect(dayClockHour(stopped, now + 10 * 60_000)).toBeCloseTo(7, 3);
    expect(applyDayClockAction(stopped, { kind: 'stop' }, now + 5 * 60_000)).toBe(stopped);
    const resumed = applyDayClockAction(stopped, { kind: 'start' }, now + 10 * 60_000);
    expect(resumed.frozenHour).toBeLessThan(0);
    expect(dayClockHour(resumed, now + 10 * 60_000)).toBeCloseTo(7, 3);
    expect(dayClockHour(resumed, now + 11 * 60_000)).toBeCloseTo(8, 3);
    expect(applyDayClockAction(resumed, { kind: 'start' }, now)).toBe(resumed);
  });

  it('moves a stopped clock without starting it, and resets to wall-clock time', () => {
    const stopped = applyDayClockAction(DEFAULT_DAY_CLOCK, { kind: 'stop' }, now);
    const moved = applyDayClockAction(stopped, { kind: 'set', hour: 0 }, now);
    expect(moved.frozenHour).toBe(0);
    expect(dayClockHour(moved, now + 123_456)).toBe(0);
    expect(applyDayClockAction(moved, { kind: 'reset' }, now)).toEqual(DEFAULT_DAY_CLOCK);
  });

  it('formats game hours as HH:MM', () => {
    expect(formatGameHour(0)).toBe('00:00');
    expect(formatGameHour(18.5)).toBe('18:30');
    expect(formatGameHour(7 + 5 / 60)).toBe('07:05');
    expect(formatGameHour(23.9999999)).toBe('00:00');
  });
});
