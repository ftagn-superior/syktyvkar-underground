import type { ActionResult, PrepareArea } from '@su/contracts';

const RESULT_HISTORY_SIZE = 32;

/** Keep acknowledgements bounded without allowing evicted requests to run again. */
export function rememberResult<Key, Result>(
  history: Map<Key, Result>,
  key: Key,
  result: Result,
): void {
  history.set(key, result);
  if (history.size > RESULT_HISTORY_SIZE) history.delete(history.keys().next().value!);
}

type ActionAdmission =
  | { kind: 'invalid' }
  | { kind: 'pending' }
  | { kind: 'prepare'; plan: PrepareArea }
  | { kind: 'result'; result: ActionResult }
  | { kind: 'new'; requestId: number; worldEpoch: unknown };

/** One sequence for respawn, reactions, animations, chat and asynchronous commands. */
export class ActionLedger {
  private lastRequest = 0;
  private readonly results = new Map<number, ActionResult>();
  private readonly pending = new Set<number>();

  begin(value: unknown, plan?: PrepareArea): ActionAdmission {
    const data = value as { requestId?: unknown; worldEpoch?: unknown } | null;
    if (
      !data ||
      typeof data.requestId !== 'number' ||
      !Number.isSafeInteger(data.requestId) ||
      data.requestId < 1
    )
      return { kind: 'invalid' };
    const requestId = data.requestId;
    if (plan?.requestId === requestId) return { kind: 'prepare', plan };
    if (this.pending.has(requestId)) return { kind: 'pending' };
    const previous = this.results.get(requestId);
    if (previous) return { kind: 'result', result: previous };
    if (requestId <= this.lastRequest)
      return {
        kind: 'result',
        result: { requestId, ok: false, code: 'ALREADY_PROCESSED' },
      };
    this.lastRequest = requestId;
    return { kind: 'new', requestId, worldEpoch: data.worldEpoch };
  }

  remember(result: ActionResult): void {
    rememberResult(this.results, result.requestId, result);
  }

  startPending(requestId: number): void {
    this.pending.add(requestId);
  }

  finishPending(requestId: number): void {
    this.pending.delete(requestId);
  }
}
