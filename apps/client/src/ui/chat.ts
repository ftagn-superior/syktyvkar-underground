import { CHAT_MAX_LENGTH, normalizeChatText } from '@su/contracts';

export interface ChatConsoleStatus {
  available: boolean;
  pending: boolean;
  remainingMs: number;
}

/** A transient composer: closing or sending discards the draft, with no history. */
export class ChatConsole {
  private readonly controller = new AbortController();
  private state: ChatConsoleStatus = { available: false, pending: false, remainingMs: 0 };
  private composing = false;
  constructor(
    private readonly toggle: HTMLButtonElement,
    private readonly form: HTMLFormElement,
    private readonly input: HTMLInputElement,
    private readonly status: HTMLElement,
    private readonly counter: HTMLElement,
    private readonly submit: HTMLButtonElement,
    private readonly canvas: HTMLCanvasElement,
    send: (text: string) => void,
    private readonly onOpenChange: (open: boolean) => void,
  ) {
    const options = { signal: this.controller.signal };
    this.input.maxLength = CHAT_MAX_LENGTH;
    toggle.addEventListener('click', () => this.open(), options);
    form.querySelector('[data-close]')!.addEventListener('click', () => this.close(), options);
    input.addEventListener('input', () => this.render(), options);
    input.addEventListener('compositionstart', () => (this.composing = true), options);
    input.addEventListener('compositionend', () => (this.composing = false), options);
    form.addEventListener(
      'keydown',
      (event) => {
        event.stopPropagation();
        if (event.isComposing || this.composing) {
          if (event.code === 'Enter' || event.code === 'NumpadEnter') event.preventDefault();
          return;
        }
        if (event.code === 'Escape') {
          event.preventDefault();
          this.close();
        }
      },
      options,
    );
    form.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        if (!this.composing && !this.submit.disabled) send(this.input.value);
      },
      options,
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (!form.hidden && event.code === 'Escape' && !event.isComposing && !this.composing) {
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
          !form.hidden &&
          event.target instanceof Node &&
          !form.contains(event.target) &&
          !toggle.contains(event.target)
        )
          this.close(false);
      },
      options,
    );
  }
  open(): void {
    if (!this.state.available) return;
    if (!this.form.hidden) {
      this.input.focus({ preventScroll: true });
      return;
    }
    this.onOpenChange(true);
    this.form.hidden = false;
    this.toggle.setAttribute('aria-expanded', 'true');
    this.render();
    this.input.focus({ preventScroll: true });
  }
  close(restoreFocus = true): void {
    const wasOpen = !this.form.hidden;
    this.form.hidden = true;
    this.input.value = '';
    this.composing = false;
    this.toggle.setAttribute('aria-expanded', 'false');
    if (wasOpen) {
      this.onOpenChange(false);
      if (restoreFocus) this.canvas.focus({ preventScroll: true });
    }
  }
  complete(ok: boolean): void {
    if (ok) this.close();
    else if (!this.form.hidden) this.input.focus({ preventScroll: true });
  }
  update(state: ChatConsoleStatus): void {
    this.state = state;
    this.toggle.hidden = !state.available;
    if (!state.available) this.close(false);
    this.render();
  }
  private render(): void {
    this.counter.textContent = `${this.input.value.length} / ${CHAT_MAX_LENGTH}`;
    this.input.readOnly = this.state.pending;
    this.form.setAttribute('aria-busy', String(this.state.pending));
    this.submit.disabled =
      !this.state.available ||
      this.state.pending ||
      this.state.remainingMs > 0 ||
      !normalizeChatText(this.input.value);
    const message = this.state.pending
      ? 'Отправляем…'
      : this.state.remainingMs > 0
        ? `Следующее сообщение через ${Math.ceil(this.state.remainingMs / 1000)} с`
        : 'Enter — отправить · Esc — отменить';
    if (this.status.textContent !== message) this.status.textContent = message;
  }
  dispose(): void {
    this.controller.abort();
  }
}
