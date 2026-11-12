import { NEUTRAL_INPUT, type MoveInput } from '@su/contracts';
import { screenMovement } from '../rendering/camera-controller';

const RADIANS_PER_PIXEL = 0.005;
const DEAD_ZONE = 0.12;

/** Radial dead zone followed by continuous walking speed, capped on diagonals too. */
export function stickAxes(x: number, y: number, radius: number) {
  const length = Math.hypot(x, y);
  if (radius <= 0 || length <= radius * DEAD_ZONE) return { right: 0, forward: 0 };
  const speed = (Math.min(1, length / radius) - DEAD_ZONE) / (1 - DEAD_ZONE);
  return { right: (x / length) * speed, forward: (-y / length) * speed };
}

/** Each gesture retains its own pointer, including outside its original hit area. */
export class TouchInput {
  private readonly controller = new AbortController();
  private enabled = false;
  private movementId?: number;
  private cameraId?: number;
  private lastX = 0;
  private axes = { right: 0, forward: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stick: HTMLElement,
    private readonly thumb: HTMLElement,
    private readonly canControl: () => boolean,
    onRotate: (radians: number) => void,
    private readonly onRelease: () => void,
    private readonly onCancel: () => void,
  ) {
    const options = { signal: this.controller.signal };
    const available = () => this.enabled && this.canControl();
    stick.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType !== 'touch' || this.movementId !== undefined || !available()) return;
        event.preventDefault();
        this.movementId = event.pointerId;
        stick.setPointerCapture(event.pointerId);
        this.moveStick(event);
      },
      options,
    );
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        const rect = canvas.getBoundingClientRect();
        if (
          event.pointerType !== 'touch' ||
          this.cameraId !== undefined ||
          !available() ||
          event.clientX < rect.left + rect.width / 2
        )
          return;
        event.preventDefault();
        this.cameraId = event.pointerId;
        this.lastX = event.clientX;
        canvas.setPointerCapture(event.pointerId);
      },
      options,
    );
    for (const target of [stick, canvas]) {
      target.addEventListener(
        'pointermove',
        (event) => {
          if (event.pointerId !== this.movementId && event.pointerId !== this.cameraId) return;
          if (!available()) return this.onCancel();
          event.preventDefault();
          if (event.pointerId === this.movementId) this.moveStick(event);
          else {
            onRotate(-(event.clientX - this.lastX) * RADIANS_PER_PIXEL);
            this.lastX = event.clientX;
          }
        },
        options,
      );
      target.addEventListener(
        'pointerup',
        (event) => {
          if (event.pointerId === this.movementId) {
            this.finishMovement();
            this.onRelease();
          } else if (event.pointerId === this.cameraId) this.finishCamera();
        },
        options,
      );
      for (const type of ['pointercancel', 'lostpointercapture'] as const)
        target.addEventListener(
          type,
          (event) => {
            if (event.pointerId === this.movementId || event.pointerId === this.cameraId)
              this.onCancel();
          },
          options,
        );
    }
  }

  private moveStick(event: PointerEvent): void {
    const rect = this.stick.getBoundingClientRect();
    const radius = Math.max(1, (rect.width - this.thumb.offsetWidth) / 2);
    const x = event.clientX - (rect.left + rect.width / 2);
    const y = event.clientY - (rect.top + rect.height / 2);
    this.axes = stickAxes(x, y, radius);
    const scale = Math.min(1, radius / (Math.hypot(x, y) || 1));
    this.thumb.style.transform = `translate(${x * scale}px, ${y * scale}px)`;
  }
  private release(target: HTMLElement, id?: number): void {
    if (id !== undefined && target.hasPointerCapture(id)) target.releasePointerCapture(id);
  }
  private finishMovement(): void {
    const id = this.movementId;
    this.movementId = undefined;
    this.axes = { right: 0, forward: 0 };
    this.thumb.style.transform = '';
    this.release(this.stick, id);
  }
  private finishCamera(): void {
    const id = this.cameraId;
    this.cameraId = undefined;
    this.release(this.canvas, id);
  }
  read(cameraAngle: number): MoveInput {
    if (!this.enabled || !this.canControl()) return { ...NEUTRAL_INPUT };
    return { ...screenMovement(this.axes.right, this.axes.forward, cameraAngle), sprint: false };
  }
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.stick.setAttribute('aria-disabled', String(!enabled));
    if (!enabled) this.onCancel();
  }
  reset(): void {
    this.finishMovement();
    this.finishCamera();
  }
  dispose(): void {
    this.reset();
    this.controller.abort();
  }
}
