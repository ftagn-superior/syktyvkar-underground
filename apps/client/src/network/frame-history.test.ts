import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameSession } from './session';

afterEach(() => vi.unstubAllGlobals());
describe('raw visible render-frame observation', () => {
  it('retains preparation and input-discard intervals independently of the HUD warmup reset', () => {
    vi.stubGlobal('document', { hidden: false });
    const session = new GameSession(() => {}, () => {});
    const neutral = { moveX: 0, moveZ: 0, sprint: false };
    session.frame(20, 0.02, neutral);
    session.state = 'waiting';
    session.frame(70, 0.05, neutral);
    session.resetFrameMeasurements();
    session.state = 'playing';
    session.frame(90, 0.02, neutral);
    expect(session.frameHistory()).toEqual({ firstSequence: 1, samples: [20, 50, 20] });
  });

  it('bounds history, exposes evicted sequence numbers and returns independent samples', () => {
    vi.stubGlobal('document', { hidden: false });
    const session = new GameSession(() => {}, () => {});
    for (let i = 1; i <= 3602; i++)
      session.frame(i, i / 1000, { moveX: 0, moveZ: 0, sprint: false });
    const history = session.frameHistory();
    expect(history.firstSequence).toBe(3);
    expect(history.samples).toHaveLength(3600);
    expect(history.samples[0]).toBe(3);
    expect(history.samples.at(-1)).toBe(3602);
    history.samples[0] = -1;
    expect(session.frameHistory().samples[0]).toBe(3);
  });
});
