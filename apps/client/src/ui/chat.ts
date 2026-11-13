import { CHAT_MAX_LENGTH, normalizeChatText } from '@su/contracts';

export interface ChatConsoleStatus {
  available: boolean;
  keepOpen?: boolean;
  pending: boolean;
  remainingMs: number;
}
/** Счётчик символов появляется только у предела длины. */
const COUNTER_FROM = CHAT_MAX_LENGTH - 40;

/**
 * Поле ввода чата. Свёрнуто в кнопку по умолчанию; `T` или кнопка раскрывают его, и оно остаётся
 * раскрытым после отправки, пока игрок не свернёт его: `Esc`, щелчок по миру или кнопка чата.
 * Несохранённый текст при сворачивании не теряется. Истории нет.
 */
export class ChatConsole {
  private readonly controller = new AbortController();
  private state: ChatConsoleStatus = { available: false, pending: false, remainingMs: 0 };
  private composing = false;
  constructor(
    private readonly toggle: HTMLButtonElement,
    private readonly form: HTMLFormElement,
    private readonly row: HTMLElement,
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
    toggle.addEventListener('click', () => (this.isOpen ? this.close() : this.open()), options);
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
        if (this.isOpen && event.code === 'Escape' && !event.isComposing && !this.composing) {
          event.preventDefault();
          this.close();
        }
      },
      options,
    );
    // Only a click on the world collapses the field; other HUD controls leave it as it is.
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (this.isOpen && event.target === this.canvas) this.close(false);
      },
      options,
    );
  }
  get isOpen(): boolean {
    return !this.form.hidden;
  }
  open(initialText = ''): void {
    if (!this.state.available) return;
    if (this.isOpen) {
      if (initialText && !this.input.value) this.input.value = initialText;
      this.focusInput();
      return;
    }
    this.onOpenChange(true);
    this.form.hidden = false;
    this.row.dataset.open = 'true';
    this.toggle.setAttribute('aria-expanded', 'true');
    this.toggle.setAttribute('aria-label', 'Свернуть чат');
    // `/` starts a command; otherwise the unsent draft is kept.
    if (initialText) this.input.value = initialText;
    this.render();
    this.focusInput();
  }
  close(restoreFocus = true): void {
    const wasOpen = this.isOpen;
    this.form.hidden = true;
    this.row.dataset.open = 'false';
    this.composing = false;
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.setAttribute('aria-label', 'Чат');
    this.render();
    if (wasOpen) {
      this.onOpenChange(false);
      if (restoreFocus) this.canvas.focus({ preventScroll: true });
    }
  }
  /** Server answer for the last message: a delivered message clears the field, which stays open. */
  complete(ok: boolean): void {
    if (ok) this.input.value = '';
    this.render();
    const active = document.activeElement;
    if (this.isOpen && (active === this.input || active === document.body)) this.focusInput();
  }
  update(state: ChatConsoleStatus): void {
    this.state = state;
    this.toggle.hidden = !state.available;
    if (!state.available && !state.keepOpen) this.close(false);
    this.render();
  }
  private focusInput(): void {
    this.input.focus({ preventScroll: true });
    const end = this.input.value.length;
    this.input.setSelectionRange(end, end);
  }
  private render(): void {
    const length = this.input.value.length;
    this.counter.textContent = `${length} / ${CHAT_MAX_LENGTH}`;
    this.counter.dataset.near = String(length >= COUNTER_FROM);
    this.input.readOnly = this.state.pending;
    this.form.setAttribute('aria-busy', String(this.state.pending));
    const command = this.input.value.trimStart().startsWith('/');
    this.submit.disabled =
      !this.state.available ||
      this.state.pending ||
      (this.state.remainingMs > 0 && !command) ||
      !normalizeChatText(this.input.value);
    // Only states worth reading are shown; the placeholder already says «Enter — отправить».
    const message = !this.isOpen
      ? ''
      : this.state.pending
        ? 'Отправляем…'
        : this.state.remainingMs > 0 && !command
          ? `Следующее сообщение через ${Math.ceil(this.state.remainingMs / 1000)} с`
          : command
            ? 'Enter — выполнить команду · Esc — свернуть'
            : '';
    if (this.status.textContent !== message) this.status.textContent = message;
  }
  dispose(): void {
    this.controller.abort();
  }
}
