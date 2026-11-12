import { describe, expect, it } from 'vitest';
import { AnimationRequestState } from './animation-request';
const playback = {
  animationId: 'wave' as const,
  sequence: 4,
  startedAtTick: 20,
  endsAtTick: 200,
  changedAtTick: 20,
};
describe('animation request confirmation', () => {
  it.each(['reply-first', 'snapshot-first'])('locks through replication with %s', (order) => {
    const request = new AnimationRequestState();
    request.begin(1, 'wave', 3, 100);
    if (order === 'reply-first') {
      expect(request.result({ requestId: 1, ok: true })).toBe(true);
      expect(request.pending).toBeDefined();
    }
    request.observe(playback);
    expect(request.pending).toBeUndefined();
    request.result({ requestId: 1, ok: true });
    expect(request.accepted).toBe(1);
  });
  it('rejects without closing, times out once, and clears on loss of connection', () => {
    const request = new AnimationRequestState();
    request.begin(1, 'wave', 3, 100);
    request.result({ requestId: 1, ok: false, code: 'ANIMATION_NOT_ALLOWED' });
    expect(request.accepted).toBe(0);
    expect(request.message).toContain('опоры');
    request.begin(2, 'wave', 3, 100);
    request.observe({ ...playback, sequence: 3 });
    request.expire(5099);
    expect(request.pending).toBeDefined();
    request.expire(5100);
    expect(request.pending).toBeUndefined();
    expect(request.message).toContain('связь');
    request.clear();
    expect(request.message).toBe('');
  });
  it('unlocks a start cancelled before its first replicated snapshot', () => {
    const request = new AnimationRequestState();
    request.begin(1, 'wave', 3, 100);
    request.observe({ ...playback, animationId: null, sequence: 5 });
    expect(request.pending).toBeUndefined();
    expect(request.accepted).toBe(1);
  });
});
