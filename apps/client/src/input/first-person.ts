import { isTextInput } from './keyboard';

type FirstPersonOptions = {
  eligible: () => boolean;
  prepare: () => void;
  reset: () => void;
  modeChanged: (firstPerson: boolean) => void;
  stateChanged: () => void;
  look: (x: number, y: number) => void;
  notice: (message: string) => void;
};

/** Browser confirmation owns capture. A cancelled request can never select a camera. */
export class FirstPersonInput {
  private readonly controller = new AbortController();
  private readonly captureController = new AbortController();
  private requestId = 0;
  private pending?: number;
  private inFlight = false;
  private captured = false;
  private disposed = false;
  selected = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: FirstPersonOptions,
  ) {
    const events = { signal: this.controller.signal };
    document.addEventListener(
      'pointerlockchange',
      () => {
        this.inFlight = false;
        if (this.disposed) {
          if (document.pointerLockElement === canvas) document.exitPointerLock();
          this.captureController.abort();
          return;
        }
        if (document.pointerLockElement === canvas) {
          if (this.pending === undefined || !options.eligible()) {
            document.exitPointerLock();
            return;
          }
          this.pending = undefined;
          this.captured = true;
          this.selected = true;
          options.modeChanged(true);
        } else {
          this.pending = undefined;
          this.captured = false;
        }
        options.reset();
        options.stateChanged();
      },
      { signal: this.captureController.signal },
    );
    document.addEventListener('pointerlockerror', () => this.reject(this.pending), {
      signal: this.captureController.signal,
    });
    document.addEventListener(
      'mousemove',
      (event) => {
        if (this.locked && options.eligible()) options.look(event.movementX, event.movementY);
      },
      events,
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (
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
        } else if (event.code === 'Escape') this.suspend();
      },
      events,
    );
    // Capture consumes both the entry click and a resume click before any gameplay handler.
    canvas.addEventListener(
      'click',
      (event) => {
        if (!this.selected && !this.requesting) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!this.locked) this.request();
      },
      { ...events, capture: true },
    );
    window.addEventListener('blur', () => this.suspend(), events);
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) this.suspend();
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
  request(): void {
    if (
      this.disposed ||
      this.inFlight ||
      this.requesting ||
      this.locked ||
      document.pointerLockElement === this.canvas ||
      !this.options.eligible()
    )
      return;
    if (!this.canvas.requestPointerLock) {
      this.options.notice('Захват мыши недоступен. Используйте обзор.');
      return;
    }
    this.options.prepare();
    this.options.reset();
    const id = ++this.requestId;
    this.pending = id;
    this.inFlight = true;
    this.options.stateChanged();
    try {
      const result = this.canvas.requestPointerLock();
      // Legacy implementations return void; pointerlockchange remains authoritative.
      result?.catch(() => this.reject(id));
    } catch {
      this.reject(id);
    }
  }
  private reject(id: number | undefined): void {
    if (id !== undefined && id !== this.requestId) return;
    this.inFlight = false;
    if (this.disposed) {
      this.captureController.abort();
      return;
    }
    if (id === undefined || this.pending !== id) return;
    this.pending = undefined;
    this.options.reset();
    this.options.stateChanged();
    this.options.notice(
      'Не удалось захватить мышь. Разрешите захват и повторите попытку; обзор доступен.',
    );
  }
  suspend(): void {
    const active = this.requesting || document.pointerLockElement === this.canvas;
    this.pending = undefined;
    this.captured = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (active) {
      this.options.reset();
      this.options.stateChanged();
    }
  }
  overview(): void {
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
    // A cancelled browser request can still acquire capture after disposal.
    if (!this.inFlight) this.captureController.abort();
  }
}
