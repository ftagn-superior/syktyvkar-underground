import { NEUTRAL_INPUT, type MoveInput } from '@su/contracts';
import { INITIAL_CAMERA_ANGLE, screenMovement } from '../rendering/camera-controller';

const movementKeys = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowLeft',
  'ArrowDown',
  'ArrowRight',
]);
const sprintKeys = new Set(['ShiftLeft', 'ShiftRight']);
export class KeyboardInput {
  private enabled = true;
  private readonly held = new Set<string>();
  private readonly controller = new AbortController();
  constructor(
    onRelease: () => void,
    onRotate?: (direction: -1 | 1) => void,
    onReactions?: () => void,
  ) {
    const options = { signal: this.controller.signal };
    window.addEventListener(
      'keydown',
      (event) => {
        if (!this.enabled || event.repeat) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement ||
          (event.target instanceof HTMLElement && event.target.isContentEditable)
        )
          return;
        if (event.code === 'KeyR') {
          event.preventDefault();
          onReactions?.();
          return;
        }
        if (event.code === 'KeyQ' || event.code === 'KeyE') {
          event.preventDefault();
          onRotate?.(event.code === 'KeyQ' ? -1 : 1);
          return;
        }
        if (!movementKeys.has(event.code) && !sprintKeys.has(event.code)) return;
        event.preventDefault();
        this.held.add(event.code);
      },
      options,
    );
    window.addEventListener(
      'keyup',
      (event) => {
        this.held.delete(event.code);
      },
      options,
    );
    const clear = () => {
      this.held.clear();
      onRelease();
    };
    window.addEventListener('blur', clear, options);
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) clear();
      },
      options,
    );
  }
  read(cameraAngle = INITIAL_CAMERA_ANGLE): MoveInput {
    if (!this.enabled || document.hidden) return { ...NEUTRAL_INPUT };
    const right =
      Number(this.held.has('KeyD') || this.held.has('ArrowRight')) -
      Number(this.held.has('KeyA') || this.held.has('ArrowLeft'));
    const forward =
      Number(this.held.has('KeyW') || this.held.has('ArrowUp')) -
      Number(this.held.has('KeyS') || this.held.has('ArrowDown'));
    return {
      ...screenMovement(right, forward, cameraAngle),
      sprint: this.held.has('ShiftLeft') || this.held.has('ShiftRight'),
    };
  }
  clear(): void {
    this.held.clear();
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.clear();
  }
  dispose(): void {
    this.controller.abort();
    this.held.clear();
  }
}
