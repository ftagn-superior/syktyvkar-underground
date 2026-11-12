import { REACTIONS } from '@su/contracts';

export interface ReactionMenuStatus {
  pending: boolean;
  remainingMs: number;
  available: boolean;
}

/** A catalog-driven picker; gameplay movement remains enabled while it is open. */
export class ReactionMenu {
  private readonly choices: HTMLButtonElement[] = [];
  private readonly controller = new AbortController();
  private sent = false;
  private wasPending = false;
  constructor(
    private readonly toggle: HTMLButtonElement,
    private readonly panel: HTMLElement,
    private readonly status: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    choose: (id: string) => void,
    private readonly onOpen?: () => void,
  ) {
    const options = { signal: this.controller.signal };
    const grid = panel.querySelector('.reaction-choices')!;
    for (const reaction of REACTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'reaction-choice';
      button.dataset.reactionId = reaction.id;
      const image = document.createElement('img');
      image.src = `/reactions/${reaction.asset}`;
      image.alt = '';
      image.width = image.height = 44;
      const label = document.createElement('span');
      label.textContent = reaction.label;
      button.append(image, label);
      button.addEventListener(
        'click',
        () => {
          choose(reaction.id);
          this.sent = true;
        },
        options,
      );
      grid.append(button);
      this.choices.push(button);
    }
    toggle.addEventListener('click', () => this.toggleOpen(), options);
    panel
      .querySelector('button[data-close]')!
      .addEventListener('click', () => this.close(), options);
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
    this.onOpen?.();
    this.panel.hidden = false;
    this.toggle.setAttribute('aria-expanded', 'true');
    (
      this.choices.find((button) => !button.disabled) ??
      this.panel.querySelector<HTMLButtonElement>('button[data-close]')
    )?.focus({ preventScroll: true });
  }
  close(restoreFocus = true): void {
    const wasOpen = !this.panel.hidden;
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus) this.canvas.focus({ preventScroll: true });
  }
  update(state: ReactionMenuStatus): void {
    this.toggle.hidden = !state.available;
    if (!state.available) this.close(false);
    // Confirmation is reflected by the server cooldown. A rejected request leaves the picker open.
    if (this.sent && this.wasPending && !state.pending) {
      if (state.remainingMs > 0) this.close();
      this.sent = false;
    }
    this.wasPending = state.pending;
    this.toggle.setAttribute('aria-busy', String(state.pending));
    const message = state.pending
      ? 'Отправляем…'
      : state.remainingMs > 0
        ? `Следующая реакция через ${Math.ceil(state.remainingMs / 1000)} с`
        : 'Выберите реакцию · в мире на 3 секунды';
    if (this.status.textContent !== message) this.status.textContent = message;
    for (const button of this.choices)
      button.disabled = !state.available || state.pending || state.remainingMs > 0;
  }
  dispose(): void {
    this.controller.abort();
  }
}
