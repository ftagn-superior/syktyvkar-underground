import { describe, expect, it, vi } from 'vitest';
import { GpuRenderTimer } from './gpu-timer';

/** Minimal WebGL2 timer-query double: results become available only when the test says so. */
function fakeGl({ supported = true } = {}) {
  const state = {
    available: false,
    disjoint: false,
    result: 4_500_000,
    active: 0,
    deleted: 0,
    current: null as WebGLQuery | null,
    lost: false,
    resultReads: 0,
  };
  const ext = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    CURRENT_QUERY: 3,
    getExtension: () => (supported ? ext : null),
    isContextLost: () => state.lost,
    getQuery: () => state.current,
    createQuery: () => ({}),
    beginQuery: (_target: number, query: WebGLQuery) => {
      state.active++;
      state.current = query;
    },
    endQuery: () => {
      state.active--;
      state.current = null;
    },
    deleteQuery: () => state.deleted++,
    getParameter: (name: number) => {
      if (name !== ext.GPU_DISJOINT_EXT) throw new Error('unexpected parameter');
      const value = state.disjoint;
      state.disjoint = false;
      return value;
    },
    getQueryParameter: (_query: unknown, name: number) => {
      if (name === 1) return state.available;
      state.resultReads++;
      return state.result;
    },
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

  it('does not start or end another profiler query or clear its disjoint state', () => {
    const { gl, state } = fakeGl();
    const foreign = {} as WebGLQuery;
    state.current = foreign;
    state.disjoint = true;
    const timer = new GpuRenderTimer(gl, 1);
    timer.begin(1);
    timer.end();
    expect(state.current).toBe(foreign);
    expect(state.disjoint).toBe(true);
    expect(timer.busySkips).toBe(1);
    state.current = null;
    timer.begin(2);
    state.current = foreign;
    timer.end();
    expect(state.current).toBe(foreign);
    expect(timer.conflicts).toBe(1);
  });

  it('discards disjoint before availability without ever reading an invalid result', () => {
    const { gl, state } = fakeGl();
    const timer = new GpuRenderTimer(gl, 1);
    timer.begin(1);
    timer.end();
    state.disjoint = true;
    expect(timer.poll()).toBeNull();
    expect(timer.disjoint).toBe(1);
    expect(state.deleted).toBe(1);
    expect(state.resultReads).toBe(0);
    state.available = true;
    expect(timer.poll()).toBeNull();
  });

  it('bounds pending age, validates results and yields to engine instrumentation', () => {
    const { gl, state } = fakeGl();
    let now = 0,
      allowed = true;
    const timer = new GpuRenderTimer(
      gl,
      1,
      () => now,
      () => allowed,
    );
    timer.begin(1);
    timer.end();
    now = 5001;
    expect(timer.poll()).toBeNull();
    expect(timer.expired).toBe(1);
    expect(state.resultReads).toBe(0);
    allowed = false;
    timer.begin(2);
    expect(state.active).toBe(0);
    allowed = true;
    state.available = true;
    for (const result of [NaN, Infinity, -1]) {
      state.result = result;
      timer.begin(3);
      timer.end();
      expect(timer.poll()).toBeNull();
    }
    expect(timer.invalidResults).toBe(3);
    expect(timer.samples).toBe(0);
  });

  it('fails closed on diagnostic API exceptions and remains disposable', () => {
    const { gl, state } = fakeGl();
    const timer = new GpuRenderTimer(gl, 1);
    timer.begin(1);
    timer.end();
    vi.spyOn(gl, 'getQueryParameter').mockImplementation(() => {
      throw new Error('sensor failure');
    });
    expect(() => timer.poll()).not.toThrow();
    expect(timer.status).toBe('error');
    expect(timer.errors).toBe(1);
    expect(state.deleted).toBe(1);
    expect(() => {
      timer.begin(2);
      timer.end();
      timer.dispose();
    }).not.toThrow();
    expect(timer.status).toBe('disposed');
    timer.contextRestored();
    expect(timer.status).toBe('disposed');
    vi.spyOn(gl, 'getExtension').mockImplementation(() => {
      throw new Error('no extension');
    });
    expect(new GpuRenderTimer(gl).status).toBe('error');
  });
});
