import { NEUTRAL_INPUT, type MoveInput } from '@su/contracts';
import { screenMovement } from '../rendering/camera-controller';

export const GAMEPAD_DEAD_ZONE = 0.18;
const NEUTRAL_MILLISECONDS = 100;
const REPEAT_DELAY = 350;
const REPEAT_INTERVAL = 120;
const COMMAND_INDICES = [0, 1, 3, 12, 13, 14, 15] as const;

export type GamepadButtons = Readonly<{
  a: boolean;
  b: boolean;
  y: boolean;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}>;
const NO_BUTTONS: GamepadButtons = Object.freeze({
  a: false,
  b: false,
  y: false,
  up: false,
  down: false,
  left: false,
  right: false,
});
type Direction = 'up' | 'down' | 'left' | 'right';
export type GamepadIssue = 'unavailable' | 'api-error' | 'unsupported' | 'invalid-data' | null;
export type GamepadInterruption = 'blur' | 'hidden' | 'resize' | 'pagehide';
export interface GamepadSnapshot {
  apiAvailable: boolean;
  supportedCount: number;
  activeIndex: number | null;
  activeId: string | null;
  ready: boolean;
  neutral: boolean;
  pageActive: boolean;
  issue: GamepadIssue;
}
export interface GamepadInputOptions {
  canSelect: () => boolean;
  onSelected: (index: number) => void;
  onDisconnected: () => void;
  onInterrupted: (reason: GamepadInterruption) => void;
  /** Once per poll, including an empty command while neutral or otherwise blocked. */
  onPoll: (buttons: GamepadButtons) => void;
  onStatus?: () => void;
}

/** Continuous radial remapping, preserving direction and capping diagonal speed. */
export function gamepadStick(x: number, y: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
  const radius = Math.hypot(x, y);
  if (radius <= GAMEPAD_DEAD_ZONE) return { x: 0, y: 0 };
  const speed = (Math.min(radius, 1) - GAMEPAD_DEAD_ZONE) / (1 - GAMEPAD_DEAD_ZONE);
  return { x: (x / radius) * speed, y: (y / radius) * speed };
}

export function isSupportedGamepad(pad: Gamepad): boolean {
  return pad.mapping === 'standard' && pad.axes.length >= 4 && pad.buttons.length >= 16;
}
function validData(pad: Gamepad): boolean {
  return (
    Array.from(pad.axes).slice(0, 4).every(Number.isFinite) &&
    Array.from(pad.buttons)
      .slice(0, 16)
      .every((button) =>
        Boolean(button && typeof button.pressed === 'boolean' && Number.isFinite(button.value)),
      )
  );
}
function directionOf(pad: Gamepad): Direction | null {
  const vertical = Number(pad.buttons[13].pressed) - Number(pad.buttons[12].pressed);
  const horizontal = Number(pad.buttons[15].pressed) - Number(pad.buttons[14].pressed);
  if (vertical !== 0 && horizontal !== 0) return null;
  if (vertical !== 0) return vertical > 0 ? 'down' : 'up';
  if (horizontal !== 0) return horizontal > 0 ? 'right' : 'left';
  return null;
}

/**
 * Owns one independent browser poll and publishes a snapshot. Reading movement never polls,
 * consumes buttons, advances physics or performs UI actions.
 */
export class GamepadInput {
  private readonly controller = new AbortController();
  private frameId: number | null = null;
  private disposed = false;
  private focused = document.hasFocus();
  private apiAvailable = typeof navigator.getGamepads === 'function';
  private supportedCount = 0;
  private issue: GamepadIssue = this.apiAvailable ? null : 'unavailable';
  private activeIndex: number | null = null;
  private activeId: string | null = null;
  private readonly previousA = new Map<number, boolean>();
  private readonly selectionRequiresRelease = new Set<number>();
  private previousButtons = new Set<number>();
  private direction: Direction | null = null;
  private repeatAt = 0;
  private neutralSince: number | null = null;
  private isNeutral = false;
  private isReady = false;
  private left = { x: 0, y: 0 };
  private rightX = 0;
  private sprint = false;
  private lastStatus = '';

  constructor(private readonly options: GamepadInputOptions) {
    const listenerOptions = { signal: this.controller.signal };
    window.addEventListener(
      'blur',
      () => {
        this.focused = false;
        this.interrupt('blur');
      },
      listenerOptions,
    );
    window.addEventListener(
      'focus',
      () => {
        this.focused = true;
        this.reset();
      },
      listenerOptions,
    );
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) this.interrupt('hidden');
        else this.reset();
      },
      listenerOptions,
    );
    window.addEventListener('resize', () => this.interrupt('resize'), listenerOptions);
    window.addEventListener(
      'pagehide',
      () => {
        this.interrupt('pagehide');
        this.dispose();
      },
      listenerOptions,
    );
    window.addEventListener(
      'gamepaddisconnected',
      (event) => {
        if (event.gamepad.index === this.activeIndex) this.disconnect();
        this.previousA.delete(event.gamepad.index);
      },
      listenerOptions,
    );
  }

  private get pageActive(): boolean {
    return this.focused && !document.hidden && document.hasFocus();
  }
  start(): void {
    if (this.disposed || this.frameId !== null) return;
    const tick = (now: number) => {
      if (this.disposed) return;
      this.poll(now);
      if (!this.disposed) this.frameId = requestAnimationFrame(tick);
    };
    this.frameId = requestAnimationFrame(tick);
  }

  /** Public for deterministic boundary tests; production uses start() once. */
  poll(now = performance.now()): void {
    if (this.disposed) return;
    let buttons = NO_BUTTONS;
    this.apiAvailable = typeof navigator.getGamepads === 'function';
    let pads: Gamepad[] = [];
    let issue: GamepadIssue = this.apiAvailable ? null : 'unavailable';
    if (this.apiAvailable) {
      try {
        pads = Array.from(navigator.getGamepads()).filter((pad): pad is Gamepad =>
          Boolean(pad && pad.connected),
        );
      } catch {
        issue = 'api-error';
      }
    }
    const supported = pads.filter(isSupportedGamepad);
    const valid = supported.filter(validData).sort((a, b) => a.index - b.index);
    this.supportedCount = valid.length;
    this.issue =
      issue ??
      (supported.length > valid.length
        ? 'invalid-data'
        : pads.length > 0 && supported.length === 0
          ? 'unsupported'
          : null);
    for (const pad of valid) {
      if (!pad.buttons[0].pressed) this.selectionRequiresRelease.delete(pad.index);
    }
    const newA = new Set(
      valid
        .filter(
          (pad) =>
            pad.buttons[0].pressed &&
            !this.previousA.get(pad.index) &&
            !this.selectionRequiresRelease.has(pad.index),
        )
        .map((pad) => pad.index),
    );
    this.previousA.clear();
    for (const pad of pads) this.previousA.set(pad.index, Boolean(pad.buttons[0]?.pressed));

    let pad = valid.find(
      (candidate) => candidate.index === this.activeIndex && candidate.id === this.activeId,
    );
    if (this.activeIndex !== null && !pad) this.disconnect();
    let selected = false;
    if (this.activeIndex === null && this.pageActive && this.options.canSelect()) {
      pad = valid.find(
        (candidate) =>
          newA.has(candidate.index) && !this.selectionRequiresRelease.has(candidate.index),
      );
      if (pad) {
        this.activeIndex = pad.index;
        this.activeId = pad.id;
        this.reset();
        selected = true;
        this.options.onSelected(pad.index);
      }
    }
    // Once selected, unrelated controllers must not alter this device's status or commands.
    if (pad && this.activeIndex === pad.index) this.issue = null;
    if (pad && this.activeIndex === pad.index && !selected && this.pageActive) {
      const left = gamepadStick(pad.axes[0], pad.axes[1]);
      const right = gamepadStick(pad.axes[2], pad.axes[3]);
      this.isNeutral =
        left.x === 0 &&
        left.y === 0 &&
        right.x === 0 &&
        right.y === 0 &&
        pad.buttons[7].value <= 0.1 &&
        COMMAND_INDICES.every((index) => !pad!.buttons[index].pressed);
      if (!this.isReady) {
        if (!this.isNeutral) this.neutralSince = null;
        else {
          this.neutralSince ??= now;
          this.isReady = now - this.neutralSince >= NEUTRAL_MILLISECONDS;
        }
        this.rememberButtons(pad);
      } else {
        this.left = left;
        this.rightX = right.x;
        if (pad.buttons[7].value >= 0.55) this.sprint = true;
        else if (pad.buttons[7].value <= 0.45) this.sprint = false;
        const next = { ...NO_BUTTONS };
        next.a = pad.buttons[0].pressed && !this.previousButtons.has(0);
        next.b = pad.buttons[1].pressed && !this.previousButtons.has(1);
        next.y = pad.buttons[3].pressed && !this.previousButtons.has(3);
        const direction = directionOf(pad);
        if (direction !== this.direction) {
          this.direction = direction;
          this.repeatAt = now + REPEAT_DELAY;
          if (direction) next[direction] = true;
        } else if (direction && now >= this.repeatAt) {
          next[direction] = true;
          this.repeatAt = now + REPEAT_INTERVAL;
        }
        this.rememberButtons(pad);
        buttons = next;
      }
    } else if (!this.pageActive) this.reset();
    this.options.onPoll(buttons);
    this.publishStatus();
  }

  private rememberButtons(pad: Gamepad): void {
    this.previousButtons = new Set(COMMAND_INDICES.filter((index) => pad.buttons[index].pressed));
  }
  private publishStatus(): void {
    const status = JSON.stringify(this.snapshot());
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.options.onStatus?.();
  }
  private interrupt(reason: GamepadInterruption): void {
    this.reset();
    this.options.onInterrupted(reason);
    this.publishStatus();
  }
  private disconnect(): void {
    if (this.activeIndex !== null) this.selectionRequiresRelease.add(this.activeIndex);
    this.release();
    this.options.onDisconnected();
  }
  reset(): void {
    this.left = { x: 0, y: 0 };
    this.rightX = 0;
    this.sprint = false;
    this.isReady = false;
    this.isNeutral = false;
    this.neutralSince = null;
    this.previousButtons.clear();
    this.direction = null;
    this.repeatAt = 0;
  }
  release(): void {
    this.reset();
    this.activeIndex = null;
    this.activeId = null;
  }
  read(cameraAngle: number): MoveInput {
    if (this.disposed || !this.isReady || this.activeIndex === null || !this.pageActive)
      return { ...NEUTRAL_INPUT };
    return { ...screenMovement(this.left.x, -this.left.y, cameraAngle), sprint: this.sprint };
  }
  get cameraX(): number {
    return this.isReady && this.activeIndex !== null && this.pageActive ? this.rightX : 0;
  }
  snapshot(): GamepadSnapshot {
    return {
      apiAvailable: this.apiAvailable,
      supportedCount: this.supportedCount,
      activeIndex: this.activeIndex,
      activeId: this.activeId,
      ready: this.isReady,
      neutral: this.isNeutral,
      pageActive: !this.disposed && this.pageActive,
      issue: this.issue,
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.release();
    this.previousA.clear();
    this.selectionRequiresRelease.clear();
    this.controller.abort();
  }
}
