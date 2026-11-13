import { describe, expect, it } from 'vitest';
import type { PrepareArea } from '@su/contracts';
import { ActionLedger, rememberResult } from './action-ledger.js';

const request = (requestId: number) => ({ requestId, worldEpoch: 'world' });

describe('shared action sequence', () => {
  it('rejects malformed requests without consuming the next valid request', () => {
    const actions = new ActionLedger();
    for (const value of [
      null,
      {},
      1,
      { requestId: '1' },
      request(0),
      request(-1),
      request(1.5),
      request(Infinity),
    ])
      expect(actions.begin(value)).toEqual({ kind: 'invalid' });
    expect(actions.begin(request(1))).toEqual({ kind: 'new', ...request(1) });
  });

  it('replays completed acknowledgements without replaying the gameplay action', () => {
    const actions = new ActionLedger();
    expect(actions.begin(request(1)).kind).toBe('new');
    const result = { requestId: 1, ok: true, retryAfterMs: 3000 };
    actions.remember(result);
    expect(actions.begin({ ...request(1), reactionId: 'different', worldEpoch: 'old' })).toEqual({
      kind: 'result',
      result,
    });
    expect(actions.begin(request(2)).kind).toBe('new');
  });

  it('never re-executes old requests after bounded acknowledgements are evicted', () => {
    const actions = new ActionLedger();
    for (let requestId = 1; requestId <= 34; requestId++) {
      expect(actions.begin(request(requestId)).kind).toBe('new');
      actions.remember({ requestId, ok: true });
    }
    expect(actions.begin(request(2))).toEqual({
      kind: 'result',
      result: { requestId: 2, ok: false, code: 'ALREADY_PROCESSED' },
    });
    expect(actions.begin(request(3))).toEqual({
      kind: 'result',
      result: { requestId: 3, ok: true },
    });
  });

  it('resends an outstanding respawn plan even after later actions advanced the sequence', () => {
    const actions = new ActionLedger();
    const plan: PrepareArea = {
      prepareId: 'prepare',
      requestId: 1,
      worldEpoch: 'world',
      mapVersion: 'map',
      layoutRevision: 1,
      reason: 'respawn',
      position: { x: 0, y: 0, z: 0 },
      cellIds: [],
      expiresAt: 1000,
    };
    actions.begin(request(1));
    actions.begin(request(2));
    expect(actions.begin(request(1), plan)).toEqual({ kind: 'prepare', plan });
    expect(actions.begin(request(1))).toEqual({
      kind: 'result',
      result: { requestId: 1, ok: false, code: 'ALREADY_PROCESSED' },
    });
  });

  it('ignores duplicates during an asynchronous command and returns its eventual result', () => {
    const actions = new ActionLedger();
    actions.begin(request(1));
    actions.startPending(1);
    actions.begin(request(2));
    expect(actions.begin(request(1))).toEqual({ kind: 'pending' });
    const result = { requestId: 1, ok: true, message: 'Получен предмет' };
    actions.remember(result);
    expect(actions.begin(request(1))).toEqual({ kind: 'pending' });
    actions.finishPending(1);
    expect(actions.begin(request(1))).toEqual({ kind: 'result', result });
  });

  it('keeps rejected requests consumed and separate connections independent', () => {
    const actions = new ActionLedger();
    actions.begin(request(5));
    const result = { requestId: 5, ok: false, code: 'STALE_WORLD' as const };
    actions.remember(result);
    expect(actions.begin(request(5))).toEqual({ kind: 'result', result });
    expect(actions.begin(request(4))).toEqual({
      kind: 'result',
      result: { requestId: 4, ok: false, code: 'ALREADY_PROCESSED' },
    });
    expect(new ActionLedger().begin(request(1)).kind).toBe('new');
  });
});

it('bounds preparation acknowledgements with the same retention policy', () => {
  const history = new Map<string, number>();
  for (let i = 0; i < 33; i++) rememberResult(history, `plan-${i}`, i);
  expect(history.size).toBe(32);
  expect(history.has('plan-0')).toBe(false);
  expect(history.get('plan-1')).toBe(1);
  rememberResult(history, 'plan-1', 100);
  expect(history.size).toBe(32);
  expect(history.get('plan-1')).toBe(100);
});
