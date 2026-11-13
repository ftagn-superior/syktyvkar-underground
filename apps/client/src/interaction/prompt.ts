import type { Interactable, Vec3 } from './interactable';
import { selectInteractable } from './interactable';

const SCAN_MS = 100;
/** Keep the prompt briefly after leaving range so the range edge does not flicker. */
const HOLD_MS = 150;

export interface InteractionHost {
  /** Own position in world units, or undefined before the player exists. */
  player(): Vec3 | undefined;
  candidates(): Iterable<Interactable>;
  /** Writes canvas CSS pixels; `visible` is false behind the camera or off-screen. */
  project(anchor: Vec3, out: { x: number; y: number; visible: boolean }): void;
  /** False while a panel/placement owns the input or the player cannot act. */
  enabled(): boolean;
  /** False when only a tap or click may activate the prompt (touch mode). Defaults to true. */
  keys?(): boolean;
}

/**
 * Contextual prompts: the nearest interactable in range shows a key cap + action; its key (or a
 * click) activates it. DOM position updates use transform only, and scanning is throttled.
 */
export class InteractionSystem {
  private readonly layer = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly keyCap = document.createElement('span');
  private readonly action = document.createElement('span');
  private readonly object = document.createElement('span');
  private readonly controller = new AbortController();
  private readonly screen = { x: 0, y: 0, visible: false };
  private current?: Interactable;
  private lostAt = 0;
  private lastScan = -Infinity;
  private transform = '';

  constructor(private readonly host: InteractionHost) {
    this.layer.className = 'su-prompts';
    this.button.type = 'button';
    this.button.className = 'su-ctx ui-panel';
    this.button.hidden = true;
    this.keyCap.className = 'su-key';
    const text = document.createElement('span');
    text.className = 'su-ctx-text';
    this.action.className = 'su-ctx-act';
    this.object.className = 'su-ctx-obj';
    text.append(this.action, this.object);
    this.button.append(this.keyCap, text);
    this.layer.append(this.button);
    document.body.append(this.layer);
    const options = { signal: this.controller.signal };
    this.button.addEventListener('click', () => this.activate(), options);
    window.addEventListener(
      'keydown',
      (event) => {
        const target = this.current;
        if (!target || event.code !== target.key || event.repeat) return;
        if (this.host.keys && !this.host.keys()) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          event.target instanceof HTMLElement &&
          (event.target.matches('input,textarea,select') || event.target.isContentEditable)
        )
          return;
        event.preventDefault();
        this.keyCap.classList.add('pressed');
        this.activate();
      },
      options,
    );
    window.addEventListener(
      'keyup',
      (event) => event.code === this.current?.key && this.keyCap.classList.remove('pressed'),
      options,
    );
  }
  /** Call once per rendered frame. */
  tick(now: number): void {
    const player = this.host.player();
    if (!player || !this.host.enabled()) return this.show(undefined);
    if (now - this.lastScan >= SCAN_MS) {
      this.lastScan = now;
      const next = selectInteractable(this.host.candidates(), player);
      if (next) {
        this.lostAt = 0;
        this.show(next);
      } else if (this.current) {
        this.lostAt ||= now;
        if (now - this.lostAt >= HOLD_MS) this.show(undefined);
      }
    }
    if (!this.current) return;
    this.host.project(this.current.getAnchor(), this.screen);
    this.button.style.visibility = this.screen.visible ? '' : 'hidden';
    const transform = `translate(${this.screen.x.toFixed(1)}px, ${this.screen.y.toFixed(1)}px) translate(-50%, calc(-100% - 10px))`;
    if (transform !== this.transform) {
      this.transform = transform;
      this.layer.style.transform = transform;
    }
  }
  private show(next: Interactable | undefined): void {
    if (next === this.current) return;
    this.current?.setHighlighted(false);
    this.current = next;
    this.button.hidden = !next;
    this.button.dataset.interactionId = next?.id ?? '';
    if (!next) return;
    next.setHighlighted(true);
    this.keyCap.textContent = next.keyLabel;
    this.action.textContent = next.action;
    this.object.textContent = next.objectName;
    this.button.setAttribute('aria-label', `${next.action} · ${next.keyLabel}`);
    this.button.setAttribute('aria-description', next.objectName);
    this.button.setAttribute('aria-keyshortcuts', next.key.replace('Key', ''));
    // Re-trigger the pop-in animation for every new target.
    this.button.style.animation = 'none';
    void this.button.offsetWidth;
    this.button.style.animation = '';
  }
  private activate(): void {
    const target = this.current;
    const player = this.host.player();
    if (target && player && this.host.enabled()) target.onActivate(player);
  }
  dispose(): void {
    this.controller.abort();
    this.show(undefined);
    this.layer.remove();
  }
}
