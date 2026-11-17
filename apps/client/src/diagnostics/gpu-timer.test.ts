import { describe, expect, it } from 'vitest';
import { GpuRenderTimer } from './gpu-timer';

/** Minimal WebGL2 timer-query double: results become available only when the test says so. */
function fakeGl({ supported = true } = {}) {
  const state = { available: false, disjoint: false, result: 4_500_000, active: 0, deleted: 0 };
  const ext = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    getExtension: () => (supported ? ext : null),
    createQuery: () => ({}),
    beginQuery: () => state.active++,
    endQuery: () => state.active--,
    deleteQuery: () => state.deleted++,
    getParameter: (name: number) => {
      if (name !== ext.GPU_DISJOINT_EXT) throw new Error('unexpected parameter');
      const value = state.disjoint;
      state.disjoint = false;
      return value;
    },
    getQueryParameter: (_query: unknown, name: number) =>
      name === 1 ? state.available : state.result,
  };
  return { gl: gl as unknown as WebGL2RenderingContext, state };
}

describe('opt-in GPU render timer', () => {
  it('samples rarely, never waits for a result and attributes it to the issuing frame', () => {
    const { gl, state } = fakeGl();
    const timer = new GpuRenderTimer(gl, 3);
    timer.begin(1);
    timer.end();
    expect(state.active).toBe(0);
    expect(timer.poll()).toBeNull(); // Not available yet: no blocking.
    timer.begin(2);
    timer.begin(3);
    timer.begin(4); // Due, but the earlier query is still outstanding.
    expect(timer.busySkips).toBe(1);
    state.available = true;
    expect(timer.poll()).toEqual({ frameId: 1, ms: 4.5 });
    expect(timer.samples).toBe(1);
    expect(state.deleted).toBe(1);
  });

  it('discards disjoint results and drops queries with a lost context', () => {
    const { gl, state } = fakeGl();
    const timer = new GpuRenderTimer(gl, 1);
    timer.begin(1);
    timer.end();
    state.available = true;
    state.disjoint = true;
    expect(timer.poll()).toBeNull();
    expect(timer.disjoint).toBe(1);
    timer.begin(2);
    timer.contextLost();
    expect(timer.status).toBe('context-lost');
    expect(timer.lostQueries).toBe(1);
    timer.begin(3);
    expect(timer.poll()).toBeNull();
    timer.contextRestored();
    expect(timer.status).toBe('collecting');
  });

  it('reports unsupported contexts without inventing samples', () => {
    const timer = new GpuRenderTimer(fakeGl({ supported: false }).gl);
    timer.begin(1);
    timer.end();
    expect(timer.status).toBe('unsupported');
    expect(timer.poll()).toBeNull();
    expect(new GpuRenderTimer(null).status).toBe('unsupported');
  });
});
