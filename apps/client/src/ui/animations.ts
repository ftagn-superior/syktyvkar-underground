import { ANIMATIONS, type AnimationId } from '@su/contracts';
import type { GameSession } from '../network/session';
import { CatalogFilter, CatalogShortcuts } from './catalog-shortcuts';
type Status = ReturnType<GameSession['animationStatus']>;

/** Окно анимаций над строкой чата: фильтр по категориям и прокручиваемый список названий. */
export class AnimationMenu {
  private available = false;
  private readonly controller = new AbortController();
  private readonly choices: {
    button: HTMLButtonElement;
    hint: HTMLElement;
    fullBody: boolean;
    category: string;
  }[] = [];
  private readonly scroll: HTMLElement;
  private readonly shown: HTMLElement;
  private readonly filter: CatalogFilter;
  private readonly shortcuts: CatalogShortcuts;
  private accepted = 0;
  constructor(
    private readonly toggle: HTMLButtonElement,
    private readonly panel: HTMLElement,
    private readonly status: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    choose: (id: AnimationId) => void,
    private readonly onOpen: () => void,
  ) {
    const options = { signal: this.controller.signal };
    panel.querySelector('[data-catalog-count]')!.textContent = String(ANIMATIONS.length);
    this.shown = panel.querySelector('[data-catalog-shown]')!;
    this.scroll = panel.querySelector('.catalog-scroll')!;
    const list = panel.querySelector('.animation-choices')!;
    for (const animation of ANIMATIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ui-btn animation-choice';
      button.dataset.animationId = animation.id;
      const title = document.createElement('span');
      title.textContent = animation.label;
      const hint = document.createElement('span');
      hint.className = 'animation-hint';
      hint.id = `animation-hint-${animation.id}`;
      button.setAttribute('aria-describedby', hint.id);
      button.append(title, hint);
      button.addEventListener(
        'click',
        () => {
          if (this.available && !button.disabled) choose(animation.id);
        },
        options,
      );
      list.append(button);
      this.choices.push({
        button,
        hint,
        fullBody: animation.mode === 'fullBody',
        category: animation.category,
      });
    }
    this.shortcuts = new CatalogShortcuts(() => !panel.hidden, this.controller.signal);
    this.filter = new CatalogFilter(
      panel.querySelector('.filters')!,
      ANIMATIONS.map((animation) => animation.category),
      () => this.renderList(),
      this.controller.signal,
    );
    toggle.addEventListener('click', () => this.toggleOpen(), options);
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.code === 'Escape' && !panel.hidden) {
          event.preventDefault();
          this.close();
        }
      },
      options,
    );
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (
          !panel.hidden &&
          event.target instanceof Node &&
          !panel.contains(event.target) &&
          !toggle.contains(event.target)
        )
          this.close(false);
      },
      options,
    );
    this.renderList();
  }
  private renderList(): void {
    const visible: HTMLButtonElement[] = [];
    for (const { button, category } of this.choices) {
      button.hidden = !this.filter.matches(category);
      if (!button.hidden) visible.push(button);
    }
    this.shown.textContent = String(visible.length);
    this.shortcuts.bind(visible);
    this.scroll.scrollTop = 0;
  }
  toggleOpen(): void {
    if (this.toggle.hidden || this.toggle.disabled) return;
    if (!this.panel.hidden) return this.close();
    this.onOpen();
    this.renderList();
    this.panel.hidden = false;
    // A hidden element cannot scroll: reset once the list is laid out.
    this.scroll.scrollTop = 0;
    this.toggle.setAttribute('aria-expanded', 'true');
    (
      this.choices.find(({ button }) => !button.hidden && !button.disabled)?.button ??
      this.panel.querySelector<HTMLButtonElement>('.filters button')
    )?.focus({ preventScroll: true });
  }
  close(restoreFocus = true): void {
    const open = !this.panel.hidden;
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
    if (open && restoreFocus) this.canvas.focus({ preventScroll: true });
  }
  update(state: Status): void {
    this.available = state.available;
    this.toggle.hidden = !state.available;
    if (!state.available) this.close(false);
    if (state.accepted !== this.accepted) {
      this.accepted = state.accepted;
      this.close();
    }
    this.toggle.setAttribute('aria-busy', String(state.pending));
    this.panel.setAttribute('aria-busy', String(state.pending));
    this.status.dataset.state =
      state.pending || state.paused || state.busy || !state.grounded || state.message
        ? 'waiting'
        : 'ready';
    const message =
      state.message ||
      (state.pending
        ? 'Ожидаем подтверждение сервера…'
        : state.paused
          ? 'Мир приостановлен.'
          : state.busy
            ? 'Дождитесь, прежде чем выбрать другую анимацию.'
            : !state.grounded
              ? 'Дождитесь опоры'
              : 'Выберите анимацию');
    if (this.status.textContent !== message) this.status.textContent = message;
    for (const { button, hint, fullBody } of this.choices) {
      const reason = !state.grounded
        ? 'Дождитесь опоры'
        : fullBody && state.moving
          ? 'Остановитесь, чтобы начать'
          : '';
      if (hint.textContent !== reason) hint.textContent = reason;
      button.disabled = !state.available || state.pending || state.busy || state.paused || !!reason;
    }
  }
  dispose(): void {
    this.controller.abort();
  }
}
