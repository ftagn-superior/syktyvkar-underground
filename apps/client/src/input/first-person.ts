import { isTextInput } from './keyboard';

type FirstPersonOptions = {
  eligible: () => boolean;
  captureAllowed: () => boolean;
  intentChanged: () => void;
  prepare: () => void;
  reset: () => void;
  modeChanged: (firstPerson: boolean) => void;
  stateChanged: () => void;
  look: (x: number, y: number) => void;
  notice: (message: string) => void;
};

type CaptureRequest = { resume: boolean; valid: () => boolean };

/** One native request at a time. Only browser confirmation can grant control. */
export class FirstPersonInput {
  private readonly controller = new AbortController();
  private readonly captureController = new AbortController();
  private pending?: CaptureRequest;
  private inFlight?: CaptureRequest;
  private releasing = false;
  private captured = false;
  private disposed = false;
  selected = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: FirstPersonOptions,
  ) {
    const events = { signal: this.controller.signal };
    document.addEventListener('pointerlockchange', () => this.captureChanged(), {
      signal: this.captureController.signal,
    });
    document.addEventListener('pointerlockerror', () => this.reject(this.inFlight), {
      signal: this.captureController.signal,
    });
    document.addEventListener(
      'mousemove',
      (event) => {
        if (this.locked && options.eligible() && options.captureAllowed())
          options.look(event.movementX, event.movementY);
      },
      events,
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (
          event.defaultPrevented ||
          event.repeat ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          isTextInput(event.target)
        )
          return;
        if (event.code === 'KeyV') {
          event.preventDefault();
          this.toggle();
        } else if (event.code === 'Escape') this.interrupt();
      },
      events,
    );
    // Chat closes on pointerdown; this click alone owns explicit world continuation.
    canvas.addEventListener(
      'click',
      (event) => {
        if (!this.selected && !this.requesting) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!this.locked && !this.requesting) this.request();
      },
      { ...events, capture: true },
    );
    window.addEventListener('blur', () => this.interrupt(), events);
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) this.interrupt();
      },
      events,
    );
  }
  get requesting(): boolean {
    return this.pending !== undefined;
  }
  get locked(): boolean {
    return this.selected && this.captured && document.pointerLockElement === this.canvas;
  }
  toggle(): void {
    if (this.disposed) return;
    if (this.selected || this.requesting) this.overview();
    else this.request();
  }
  /** Explicit entry/continuation may close panels. Chat restoration must not. */
  request(): void {
    if (this.disposed || this.requesting || this.locked || !this.options.eligible()) return;
    this.options.intentChanged();
    this.options.prepare();
    this.queue({ resume: false, valid: () => true });
  }
  resume(valid: () => boolean): void {
    if (this.disposed || !this.selected || this.requesting || this.locked) return;
    this.queue({ resume: true, valid });
  }
  private allowed(request: CaptureRequest): boolean {
    return (
      !this.disposed &&
      (!request.resume || this.selected) &&
      request.valid() &&
      this.options.eligible() &&
      this.options.captureAllowed()
    );
  }
  private queue(request: CaptureRequest): void {
    if (!this.allowed(request)) return;
    this.pending = request;
    this.options.reset();
    this.options.stateChanged();
    this.pump();
  }
  /** Continue once after native release, never by polling or overlapping requests. */
  private pump(): void {
    const request = this.pending;
    if (!request) return;
    if (!this.allowed(request)) {
      this.pending = undefined;
      this.options.stateChanged();
      return;
    }
    if (this.inFlight || this.releasing || document.pointerLockElement) return;
    if (!this.canvas.requestPointerLock) {
      this.pending = undefined;
      this.options.stateChanged();
      this.options.notice('Захват мыши недоступен. Используйте обзор.');
      return;
    }
    this.inFlight = request;
    try {
      // Legacy implementations return void; pointerlockchange remains authoritative.
      this.canvas.requestPointerLock()?.catch(() => this.reject(request));
    } catch {
      this.reject(request);
    }
  }
  private captureChanged(): void {
    // A duplicate/late unlock notification cannot settle a newer pending native request.
    // Its success must report our canvas; failure is delivered by error/rejection.
    if (
      document.pointerLockElement !== this.canvas &&
      !this.releasing &&
      !this.captured
    )
      return;
    const request = this.inFlight;
    this.inFlight = undefined;
    if (document.pointerLockElement === this.canvas) {
      // Duplicate confirmation of a still-owned capture is harmless.
      if (
        this.captured &&
        !this.releasing &&
        this.options.eligible() &&
        this.options.captureAllowed()
      )
        return;
      if (request && this.pending === request && this.allowed(request)) {
        this.pending = undefined;
        this.captured = true;
        this.selected = true;
        this.options.modeChanged(true);
      } else {
        // A cancelled native request must finish releasing before the next request.
        if (this.pending === request) this.pending = undefined;
        this.release();
        return;
      }
    } else {
      const lostControl = this.captured;
      this.releasing = false;
      this.captured = false;
      if (request && this.pending === request) this.pending = undefined;
      if (lostControl) this.options.intentChanged();
    }
    if (this.disposed) {
      this.captureController.abort();
      return;
    }
    this.options.reset();
    this.options.stateChanged();
    this.pump();
  }
  private reject(request: CaptureRequest | undefined): void {
    if (!request || this.inFlight !== request) return;
    this.inFlight = undefined;
    const current = this.pending === request;
    if (current) this.pending = undefined;
    if (this.disposed) {
      if (!this.releasing) this.captureController.abort();
      return;
    }
    this.options.reset();
    this.options.stateChanged();
    if (current && request.valid())
      this.options.notice(
        'Не удалось захватить мышь. Разрешите захват и повторите попытку; обзор доступен.',
      );
    this.pump();
  }
  private release(): void {
    this.captured = false;
    if (document.pointerLockElement === this.canvas && !this.releasing) {
      this.releasing = true;
      document.exitPointerLock();
    }
  }
  private interrupt(): void {
    this.options.intentChanged();
    this.suspend();
  }
  /** Expected chat/frame suspension does not itself supersede the chat context. */
  suspend(): void {
    const active = this.requesting || this.captured || document.pointerLockElement === this.canvas;
    this.pending = undefined;
    this.release();
    if (active && !this.disposed) {
      this.options.reset();
      this.options.stateChanged();
    }
  }
  overview(): void {
    if (this.disposed) return;
    this.options.intentChanged();
    if (!this.selected && !this.requesting) return;
    this.suspend();
    this.selected = false;
    this.options.reset();
    this.options.modeChanged(false);
    this.options.stateChanged();
  }
  dispose(): void {
    this.overview();
    this.disposed = true;
    this.controller.abort();
    if (!this.inFlight && !this.releasing) this.captureController.abort();
  }
}
