import { ANIMATIONS, WORLD_ACTIVITY_MOVE_DURATION_MS, type AnimationId } from '@su/contracts';
import type { GameSession } from '../network/session';
import { bindCatalogShortcuts } from './catalog-shortcuts';
type Status = ReturnType<GameSession['animationStatus']>;

const poses: Record<AnimationId, string> = {
  wave: 'M12 9v7m0-5-5 3-3-3m8 0 5-3V3m-5 13-4 6m4-6 5 6',
  clap: 'M12 9v7m0-6-5 4 4-6m1 2 5 4-4-6m-1 8-4 6m4-6 4 6',
  dance: 'm12 9-2 7m2-5-6-1-2-4m8 5 5 2 3-4m-10 7-4 4m4-4 6 2 2 4',
};

export class AnimationMenu {
  private available = false;
  private readonly controller = new AbortController();
  private readonly choices: { button: HTMLButtonElement; hint: HTMLElement; fullBody: boolean }[] =
    [];
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
    for (const animation of ANIMATIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'animation-choice';
      button.dataset.animationId = animation.id;
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 26');
      icon.setAttribute('aria-hidden', 'true');
      icon.classList.add('animation-icon');
      const head = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      head.setAttribute('cx', '12');
      head.setAttribute('cy', '5');
      head.setAttribute('r', '2');
      const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      body.setAttribute('d', poses[animation.id]);
      icon.append(head, body);
      const copy = document.createElement('span');
      copy.className = 'animation-copy';
      const title = document.createElement('strong');
      title.textContent = animation.label;
      const detail = document.createElement('span');
      detail.className = 'animation-category';
      detail.textContent = `${animation.mode === 'fullBody' ? 'Танец' : 'Жест'} · до движения`;
      const duration = document.createElement('span');
      duration.className = 'animation-duration';
      duration.textContent = `+ ${WORLD_ACTIVITY_MOVE_DURATION_MS / 1000} с`;
      const hint = document.createElement('span');
      hint.className = 'animation-hint';
      hint.id = `animation-hint-${animation.id}`;
      button.setAttribute('aria-describedby', hint.id);
      copy.append(title, detail, hint);
      button.append(icon, copy, duration);
      button.addEventListener(
        'click',
        () => {
          if (this.available && !button.disabled) choose(animation.id);
        },
        options,
      );
      panel.querySelector('.animation-choices')!.append(button);
      this.choices.push({ button, hint, fullBody: animation.mode === 'fullBody' });
    }
    bindCatalogShortcuts(
      panel,
      this.choices.map(({ button }) => button),
      this.controller.signal,
    );
    toggle.addEventListener('click', () => this.toggleOpen(), options);
    panel.querySelector('[data-close]')!.addEventListener('click', () => this.close(), options);
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
  }
  toggleOpen(): void {
    if (this.toggle.hidden || this.toggle.disabled) return;
    if (!this.panel.hidden) return this.close();
    this.onOpen();
    this.panel.hidden = false;
    this.toggle.setAttribute('aria-expanded', 'true');
    (
      this.choices.find(({ button }) => !button.disabled)?.button ??
      this.panel.querySelector<HTMLButtonElement>('[data-close]')
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
              : 'Выберите жест или танец');
    if (this.status.textContent !== message) this.status.textContent = message;
    for (const { button, hint, fullBody } of this.choices) {
      const reason = !state.grounded
        ? 'Дождитесь опоры'
        : fullBody && state.moving
          ? 'Остановитесь, чтобы танцевать'
          : '';
      const description =
        reason ||
        (fullBody
          ? `После движения — ещё ${WORLD_ACTIVITY_MOVE_DURATION_MS / 1000} с`
          : 'Можно на ходу');
      if (hint.textContent !== description) hint.textContent = description;
      button.disabled = !state.available || state.pending || state.busy || state.paused || !!reason;
    }
  }
  dispose(): void {
    this.controller.abort();
  }
}
