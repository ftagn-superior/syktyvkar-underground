/** Native compatibility clicks are absent for secondary fingers. Activate once on a valid tap. */
export function bindTouchButtons(buttons: HTMLButtonElement[]): () => void {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  for (const button of buttons) {
    let press: { id: number; x: number; y: number } | undefined;
    let touchSequence = false;
    button.addEventListener(
      'pointerdown',
      (event) => {
        touchSequence = event.pointerType === 'touch';
        if (event.pointerType !== 'touch' || button.disabled || press) return;
        press = { id: event.pointerId, x: event.clientX, y: event.clientY };
        button.setPointerCapture(event.pointerId);
      },
      options,
    );
    button.addEventListener(
      'pointerup',
      (event) => {
        if (event.pointerId !== press?.id) return;
        const start = press;
        press = undefined;
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        if (
          !button.disabled &&
          hit &&
          button.contains(hit) &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) < 12
        ) {
          event.preventDefault();
          button.click();
        }
      },
      options,
    );
    for (const type of ['pointercancel', 'lostpointercapture'] as const)
      button.addEventListener(
        type,
        (event) => {
          if (event.pointerId === press?.id) press = undefined;
        },
        options,
      );
    button.addEventListener(
      'click',
      (event) => {
        if (
          (event instanceof PointerEvent && event.pointerType === 'touch') ||
          (touchSequence && event.detail > 0)
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { ...options, capture: true },
    );
  }
  return () => controller.abort();
}
