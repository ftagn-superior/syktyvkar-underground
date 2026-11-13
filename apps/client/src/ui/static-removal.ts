import type { StaticRemovalEffect } from '@su/contracts';
import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';
import { ICONS } from './icons';

/** A disposable selection; the sent operation remains owned by GameSession. */
export class StaticRemoval {
  private readonly panel = document.createElement('section');
  private readonly title = document.createElement('b');
  private readonly status = document.createElement('p');
  private readonly confirm = document.createElement('button');
  private readonly cancel = document.createElement('button');
  private readonly listeners = new AbortController();
  private effect?: StaticRemovalEffect;
  private protectedIds = new Set<string>();
  private hovered?: string;
  private selected?: string;
  private focused = !document.hidden;
  private freshPointer = false;
  private freshKey = false;
  private hoverAt = 0;

  constructor(
    private readonly session: GameSession,
    private readonly canvas: HTMLCanvasElement,
    private readonly view: () => WorldView | undefined,
    private readonly mode: (active: boolean) => void,
    private readonly available: () => boolean,
  ) {
    this.panel.id = 'static-removal';
    this.panel.className = 'place-pill ui-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Удаление объекта');
    this.title.textContent = 'Удаление объекта';
    this.status.className = 'place-status';
    this.status.setAttribute('role', 'status');
    const copy = document.createElement('span');
    copy.className = 'place-copy';
    copy.append(this.title, this.status);
    this.confirm.id = 'static-removal-confirm';
    this.confirm.type = this.cancel.type = 'button';
    this.confirm.className = 'ui-btn ui-pri';
    this.confirm.textContent = 'Удалить';
    this.confirm.disabled = true;
    this.cancel.className = 'ui-btn ui-icon-btn';
    this.cancel.setAttribute('aria-label', 'Отменить удаление (Esc)');
    this.cancel.innerHTML = ICONS.close;
    this.panel.append(copy, this.confirm, this.cancel);
    (document.getElementById('hud-top') ?? document.body).append(this.panel);
    const options = { signal: this.listeners.signal };
    window.addEventListener(
      'pointerdown',
      (event) => {
        this.freshPointer = this.active && this.focused && event.button === 0;
      },
      options,
    );
    canvas.addEventListener(
      'click',
      (event) => {
        if (event.button === 0 && event.detail <= 1 && this.freshPointer && this.canSelect()) {
          const object = this.view()?.pickStaticObject(this.protectedIds);
          this.selected = object?.entityId;
          this.hovered = object?.entityId;
          this.render();
        }
        this.freshPointer = false;
      },
      options,
    );
    this.confirm.addEventListener(
      'keydown',
      (event) => {
        if (!['Enter', 'NumpadEnter', 'Space'].includes(event.code)) return;
        if (!event.repeat && this.focused) this.freshKey = true;
        else event.preventDefault();
      },
      options,
    );
    this.confirm.addEventListener(
      'keyup',
      (event) => {
        if (event.code === 'Space' && !this.freshKey) event.preventDefault();
        if (event.code !== 'Space') this.freshKey = false;
      },
      options,
    );
    this.confirm.addEventListener(
      'click',
      (event) => {
        const intentional = event.detail === 0 ? this.freshKey : this.freshPointer;
        this.freshPointer = this.freshKey = false;
        if (intentional) this.remove();
      },
      options,
    );
    this.cancel.addEventListener(
      'click',
      () => {
        if (!this.session.staticRemovalPending) this.close();
      },
      options,
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (
          this.active &&
          event.code === 'Escape' &&
          !event.repeat &&
          !this.session.staticRemovalPending
        ) {
          event.preventDefault();
          this.close();
        }
      },
      options,
    );
    const blur = () => {
      this.focused = false;
      this.freshPointer = this.freshKey = false;
      this.hovered = this.selected = undefined;
      this.view()?.highlightStaticObject();
      if (this.active) this.render();
    };
    window.addEventListener('blur', blur, options);
    window.addEventListener(
      'focus',
      () => {
        this.focused = true;
      },
      options,
    );
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) blur();
        else this.focused = document.hasFocus();
      },
      options,
    );
  }
  get active() {
    return !!this.effect;
  }
  diagnostics() {
    return {
      active: this.active,
      hovered: this.hovered,
      selected: this.selected,
      pending: this.session.staticRemovalPending,
      focused: this.focused,
    };
  }
  open(effect: StaticRemovalEffect) {
    if (
      !this.available() ||
      this.session.state !== 'playing' ||
      this.session.staticRemovalPending ||
      this.session.staticPlacementPending
    )
      return;
    if (this.active) return;
    this.effect = effect;
    this.protectedIds = new Set(effect.protectedEntityIds);
    this.selected = this.hovered = undefined;
    this.hoverAt = 0;
    this.freshPointer = this.freshKey = false;
    this.focused = !document.hidden;
    this.panel.hidden = false;
    this.mode(true);
    this.render();
    this.canvas.focus({ preventScroll: true });
  }
  close() {
    const wasActive = this.active;
    this.effect = undefined;
    this.selected = this.hovered = undefined;
    this.freshPointer = this.freshKey = false;
    this.panel.hidden = true;
    this.confirm.disabled = true;
    this.view()?.highlightStaticObject();
    if (wasActive) this.mode(false);
  }
  private canSelect() {
    return (
      this.active &&
      this.available() &&
      this.focused &&
      !document.hidden &&
      this.session.state === 'playing' &&
      !this.session.worldPaused &&
      !this.session.staticRemovalPending
    );
  }
  private remove() {
    if (!this.canSelect() || !this.selected || !this.effect || this.confirm.disabled) return;
    if (!this.view()?.getStaticObject(this.selected)) {
      this.selected = this.hovered = undefined;
      this.render();
      return;
    }
    if (this.session.removeStatic(this.selected, this.effect.publication)) {
      this.close();
      this.canvas.focus({ preventScroll: true });
    }
  }
  private render() {
    const pending = this.session.staticRemovalPending;
    this.confirm.disabled = pending || !this.selected || !this.canSelect();
    this.cancel.disabled = pending;
    const object = this.view()?.getStaticObject(this.selected ?? this.hovered ?? '');
    // Use textContent: model names and IDs are content, never markup.
    const title = object
      ? (this.effect?.modelNames?.[object.assetId] ?? 'Статичный объект')
      : 'Удаление объекта';
    if (this.title.textContent !== title) this.title.textContent = title;
    const status = pending
      ? 'Сохраняем удаление…'
      : this.selected
        ? 'Удалится объект целиком. Восстановление пока недоступно.'
        : 'Щёлкните по объекту, затем нажмите «Удалить» · Esc — отмена';
    if (this.status.textContent !== status) this.status.textContent = status;
    this.view()?.highlightStaticObject(this.selected ?? this.hovered);
  }
  frame() {
    if (!this.effect) return;
    if (!this.available() || !['playing', 'waiting', 'preparing'].includes(this.session.state)) {
      this.close();
      return;
    }
    if (
      !this.session.staticRemovalPending &&
      this.session.state === 'playing' &&
      this.effect.publication.layoutRevision !== this.session.info.layoutRevision
    ) {
      // A different publication always requires a fresh deliberate selection.
      this.close();
      return;
    }
    if (this.canSelect()) {
      if (this.selected && !this.view()?.getStaticObject(this.selected)) this.selected = undefined;
      const now = performance.now();
      if (!this.selected && now >= this.hoverAt) {
        this.hoverAt = now + 50;
        this.hovered = this.view()?.pickStaticObject(this.protectedIds)?.entityId;
      }
    } else this.hovered = undefined;
    this.render();
  }
  dispose() {
    this.close();
    this.listeners.abort();
    this.panel.remove();
  }
}
