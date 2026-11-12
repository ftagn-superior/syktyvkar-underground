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
const placementRotations: Readonly<Record<string, { axis: 'x' | 'y' | 'z'; direction: -1 | 1 }>> = {
  KeyW: { axis: 'x', direction: -1 },
  KeyS: { axis: 'x', direction: 1 },
  KeyA: { axis: 'y', direction: -1 },
  KeyD: { axis: 'y', direction: 1 },
  KeyQ: { axis: 'z', direction: -1 },
  KeyE: { axis: 'z', direction: 1 },
};
export class KeyboardInput {
  private enabled = true;
  private placementMode = false;
  private readonly held = new Set<string>();
  private readonly controller = new AbortController();
  constructor(
    onRelease: () => void,
    private readonly onRotate?: (direction: -1 | 0 | 1) => void,
    onReactions?: () => void,
    onChat?: (initialText: string) => void,
    onAnimations?: () => void,
    onPlacementRotate?: (axis: 'x' | 'y' | 'z', direction: -1 | 1) => void,
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
        if (this.placementMode) {
          const rotation = placementRotations[event.code];
          if (rotation) {
            event.preventDefault();
            onPlacementRotate?.(rotation.axis, rotation.direction);
            return;
          }
          if (movementKeys.has(event.code) || sprintKeys.has(event.code)) {
            event.preventDefault();
            return;
          }
        }
        if (event.code === 'KeyR') {
          event.preventDefault();
          onReactions?.();
          return;
        }
        if (event.code === 'KeyT' || event.key === '/') {
          event.preventDefault();
          onChat?.(event.key === '/' ? '/' : '');
          return;
        }
        if (event.code === 'KeyF') {
          event.preventDefault();
          onAnimations?.();
          return;
        }
        if (event.code === 'KeyQ' || event.code === 'KeyE') {
          event.preventDefault();
          this.held.add(event.code);
          this.publishRotation();
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
        if (event.code === 'KeyQ' || event.code === 'KeyE') this.publishRotation();
      },
      options,
    );
    const clear = () => {
      this.clear();
      onRelease();
    };
    window.addEventListener('blur', clear, options);
    window.addEventListener(
      'focusin',
      (event) => {
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement ||
          (event.target instanceof HTMLElement && event.target.isContentEditable)
        )
          clear();
      },
      options,
    );
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) clear();
      },
      options,
    );
  }
  get cameraEnabled(): boolean {
    return this.enabled && !this.placementMode && !document.hidden;
  }
  private publishRotation(): void {
    const direction = Number(this.held.has('KeyE')) - Number(this.held.has('KeyQ'));
    this.onRotate?.(direction as -1 | 0 | 1);
  }
  read(cameraAngle = INITIAL_CAMERA_ANGLE): MoveInput {
    if (!this.enabled || this.placementMode || document.hidden) return { ...NEUTRAL_INPUT };
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
    this.publishRotation();
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.clear();
  }
  setPlacementMode(active: boolean): void {
    this.placementMode = active;
    this.clear();
  }
  dispose(): void {
    this.controller.abort();
    this.clear();
  }
}
