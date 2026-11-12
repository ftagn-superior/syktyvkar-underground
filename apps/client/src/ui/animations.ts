import { ANIMATIONS, type AnimationId } from '@su/contracts';
import type { GameSession } from '../network/session';
type Status = ReturnType<GameSession['animationStatus']>;

export class AnimationMenu {
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
    for (const animation of ANIMATIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'animation-choice';
      button.dataset.animationId = animation.id;
      const title = document.createElement('strong');
      title.textContent = animation.label;
      const detail = document.createElement('span');
      detail.textContent = `${animation.category} · ${animation.durationMs / 1000} с`;
      const hint = document.createElement('span');
      hint.className = 'animation-hint';
      button.append(title, detail, hint);
      button.addEventListener('click', () => choose(animation.id), options);
      panel.querySelector('.animation-choices')!.append(button);
      this.choices.push({ button, hint, fullBody: animation.mode === 'fullBody' });
    }
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
    this.toggle.hidden = !state.available;
    if (!state.available) this.close(false);
    if (state.accepted !== this.accepted) {
      this.accepted = state.accepted;
      this.close();
    }
    this.toggle.setAttribute('aria-busy', String(state.pending));
    const message =
      state.message ||
      (state.pending
        ? 'Ожидаем подтверждение сервера…'
        : state.paused
          ? 'Мир приостановлен.'
          : state.busy
            ? 'Дождитесь окончания текущей анимации.'
            : !state.grounded
              ? 'Дождитесь опоры'
              : 'Выберите анимацию · движение остаётся доступным');
    if (this.status.textContent !== message) this.status.textContent = message;
    for (const { button, hint, fullBody } of this.choices) {
      const reason = !state.grounded
        ? 'Дождитесь опоры'
        : fullBody && state.moving
          ? 'Остановитесь, чтобы танцевать'
          : '';
      if (hint.textContent !== reason) hint.textContent = reason;
      button.disabled = !state.available || state.pending || state.busy || state.paused || !!reason;
    }
  }
  dispose(): void {
    this.controller.abort();
  }
}
