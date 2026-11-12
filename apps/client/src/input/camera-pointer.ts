const RADIANS_PER_PIXEL = 0.005;

/** Right-button orbit leaves primary clicks available for placing items. */
export class CameraPointerInput {
  private readonly controller = new AbortController();
  private pointerId?: number;
  private lastX = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly canRotate: () => boolean,
    onRotate: (radians: number) => void,
    private readonly onCancel: () => void,
  ) {
    const options = { signal: this.controller.signal };
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType !== 'mouse' || event.button !== 2 || !this.canRotate()) return;
        event.preventDefault();
        canvas.focus({ preventScroll: true });
        this.pointerId = event.pointerId;
        this.lastX = event.clientX;
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add('camera-rotating');
      },
      options,
    );
    canvas.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerId !== this.pointerId) return;
        if (!this.canRotate()) {
          this.cancel();
          return;
        }
        if (!(event.buttons & 2)) {
          this.finish();
          return;
        }
        onRotate(-(event.clientX - this.lastX) * RADIANS_PER_PIXEL);
        this.lastX = event.clientX;
      },
      options,
    );
    canvas.addEventListener(
      'pointerup',
      (event) => {
        if (event.pointerId === this.pointerId) this.finish();
      },
      options,
    );
    for (const type of ['pointercancel', 'lostpointercapture'] as const)
      canvas.addEventListener(
        type,
        (event) => {
          if (event.pointerId === this.pointerId) this.cancel();
        },
        options,
      );
    canvas.addEventListener(
      'contextmenu',
      (event) => {
        if (this.canRotate()) event.preventDefault();
      },
      options,
    );
  }
  private finish(): void {
    const id = this.pointerId;
    this.pointerId = undefined;
    this.canvas.classList.remove('camera-rotating');
    if (id !== undefined && this.canvas.hasPointerCapture(id))
      this.canvas.releasePointerCapture(id);
  }
  cancel(): void {
    if (this.pointerId === undefined) return;
    this.finish();
    this.onCancel();
  }
  dispose(): void {
    this.cancel();
    this.controller.abort();
  }
}
