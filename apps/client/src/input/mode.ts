import { isMovementKey, isTextInput } from './keyboard';

export type InputMode = 'desktop' | 'touch' | 'gamepad';

/** Only deliberate game input changes mode; the switching press is consumed. */
export class GameInputMode {
  private readonly controller = new AbortController();
  private readonly onChange: (mode: InputMode) => void;
  value: InputMode =
    matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0 ? 'touch' : 'desktop';

  constructor(canvas: HTMLCanvasElement, stick: HTMLElement, onChange: (mode: InputMode) => void) {
    this.onChange = onChange;
    const options = { capture: true, signal: this.controller.signal };
    const switchTo = (mode: InputMode, event: Event) => {
      if (mode === this.value) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.select(mode);
    };
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (
          event.target !== canvas &&
          !(event.target instanceof Node && stick.contains(event.target))
        )
          return;
        if (event.pointerType === 'touch') switchTo('touch', event);
        else if (event.pointerType === 'mouse' && event.target === canvas)
          switchTo('desktop', event);
      },
      options,
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (
          !event.repeat &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !isTextInput(event.target) &&
          isMovementKey(event.code)
        )
          switchTo('desktop', event);
      },
      options,
    );
  }

  select(mode: InputMode): void {
    if (mode === this.value) return;
    this.value = mode;
    this.onChange(mode);
  }

  dispose(): void {
    this.controller.abort();
  }
}
