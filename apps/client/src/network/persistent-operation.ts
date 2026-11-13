const RETRY_MS = 3000;

/** Account-scoped, idempotent operation retained until the server gives a final reply. */
export class PersistentOperation<T extends { operationId: string }> {
  private value?: T;
  private accountId?: string;
  private retryAt = 0;

  constructor(
    private readonly storagePrefix: string,
    private readonly parse: (value: unknown) => T | undefined,
  ) {}

  get current(): T | undefined {
    return this.value;
  }

  begin(value: T, accountId: string): void {
    this.value = value;
    this.accountId = accountId;
    this.retryAt = 0;
    try {
      sessionStorage.setItem(this.key(accountId), JSON.stringify(value));
    } catch {
      // The live operation still survives a transport reconnect in memory.
    }
  }

  restore(accountId: string): void {
    if (this.accountId !== accountId) this.reset();
    this.accountId = accountId;
    if (this.value) return;
    try {
      this.value = this.parse(JSON.parse(sessionStorage.getItem(this.key(accountId)) ?? 'null'));
    } catch {
      // Missing, unavailable or malformed optional storage must not block gameplay.
    }
  }

  defer(now = performance.now()): void {
    this.retryAt = now + RETRY_MS;
  }

  sendIfDue(now: number, send: (value: T) => void): void {
    if (!this.value || now < this.retryAt) return;
    send(this.value);
    this.defer(now);
  }

  complete(): void {
    if (this.accountId) {
      try {
        sessionStorage.removeItem(this.key(this.accountId));
      } catch {
        // Replaying the same operation ID after reload remains idempotent.
      }
    }
    this.reset();
  }

  /** Disconnect releases memory; a later session can restore the durable request. */
  reset(): void {
    this.value = undefined;
    this.accountId = undefined;
    this.retryAt = 0;
  }

  private key(accountId: string): string {
    return `${this.storagePrefix}:${accountId}`;
  }
}
