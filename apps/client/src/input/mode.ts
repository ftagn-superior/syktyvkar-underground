import { isMovementKey, isTextInput } from './keyboard';

export type InputMode = 'desktop' | 'touch';

/** Only deliberate game input changes mode; the switching press is consumed. */
export class GameInputMode {
  private readonly controller = new AbortController();
  value: InputMode =
    matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0 ? 'touch' : 'desktop';

  constructor(canvas: HTMLCanvasElement, stick: HTMLElement, onChange: (mode: InputMode) => void) {
    const options = { capture: true, signal: this.controller.signal };
    const switchTo = (mode: InputMode, event: Event) => {
      if (mode === this.value) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.value = mode;
      onChange(mode);
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

  dispose(): void {
    this.controller.abort();
  }
}
