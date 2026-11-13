import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingAction } from './pending-action';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('transient action lifecycle', () => {
  it('ignores stale and duplicate replies without unlocking a newer request', () => {
    const action = new PendingAction();
    const timeout = vi.fn();
    action.begin(1, 5000, timeout);
    action.begin(2, 5000, timeout);
    expect(action.settle({ requestId: 1, ok: true }, 3000, 100)).toBe(false);
    expect(action.pending).toBe(true);
    expect(action.settle({ requestId: 2, ok: true, retryAfterMs: 1200 }, 3000, 100)).toBe(true);
    expect(action.remainingMs(600)).toBe(700);
    expect(action.settle({ requestId: 2, ok: true }, 3000, 600)).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(timeout).not.toHaveBeenCalled();
  });

  it('times out once and cancels timers on reconnect, retaining an accepted cooldown', () => {
    const action = new PendingAction();
    const timeout = vi.fn();
    action.begin(1, 5000, timeout);
    vi.advanceTimersByTime(5000);
    expect(action.pending).toBe(false);
    expect(timeout).toHaveBeenCalledTimes(1);
    action.begin(2, 5000, timeout);
    action.settle({ requestId: 2, ok: false, code: 'RATE_LIMITED' }, 3000, 100);
    action.begin(3, 5000, timeout);
    action.cancel();
    vi.advanceTimersByTime(5000);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(action.remainingMs(1100)).toBe(2000);
    action.reset();
    expect(action.remainingMs(1100)).toBe(0);
  });

  it.each([
    [-100, 0],
    [10_000, 3000],
    [NaN, 3000],
    [undefined, 3000],
  ])('bounds server cooldown %s to %s milliseconds', (retryAfterMs, expected) => {
    const action = new PendingAction();
    action.begin(1, 5000, vi.fn());
    action.settle({ requestId: 1, ok: true, retryAfterMs }, 3000, 100);
    expect(action.remainingMs(100)).toBe(expected);
  });
});
