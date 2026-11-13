import type { ActionResult } from '@su/contracts';

/** One transient gameplay request. Replies and timeouts can settle it only once. */
export class PendingAction {
  private requestId?: number;
  private timeout?: ReturnType<typeof setTimeout>;
  private availableAt = 0;

  get pending(): boolean {
    return this.requestId !== undefined;
  }

  remainingMs(now = performance.now()): number {
    return Math.max(0, this.availableAt - now);
  }

  begin(requestId: number, timeoutMs: number, onTimeout: () => void): void {
    this.cancel();
    this.requestId = requestId;
    this.timeout = setTimeout(() => {
      this.cancel();
      onTimeout();
    }, timeoutMs);
  }

  /** A stale or duplicate reply never changes the active request or its cooldown. */
  settle(result: ActionResult, cooldownMs = 0, now = performance.now()): boolean {
    if (result.requestId !== this.requestId) return false;
    this.cancel();
    if (cooldownMs > 0 && (result.ok || result.code === 'RATE_LIMITED')) {
      const delay = Number.isFinite(result.retryAfterMs)
        ? Math.min(cooldownMs, Math.max(0, result.retryAfterMs!))
        : cooldownMs;
      this.availableAt = now + delay;
    }
    return true;
  }

  /** Reconnect cancels an in-flight request but keeps its accepted cooldown. */
  cancel(): void {
    clearTimeout(this.timeout);
    this.timeout = undefined;
    this.requestId = undefined;
  }

  reset(): void {
    this.cancel();
    this.availableAt = 0;
  }
}
