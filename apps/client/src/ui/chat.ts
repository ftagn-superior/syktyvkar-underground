import { CHAT_COOLDOWN_MS, CHAT_MAX_LENGTH, normalizeChatText } from '@su/contracts';
import { chatSendHint, closesAfterSend, type ChatSettings } from './chat-settings';

export interface ChatConsoleStatus {
  available: boolean;
  keepOpen?: boolean;
  pending: boolean;
  remainingMs: number;
}

export type ChatCloseReason =
  | 'send'
  | 'escape'
  | 'button'
  | 'world'
  | 'replace'
  | 'unavailable'
  | 'dispose';

type ChatLifecycle = {
  beforeOpen: () => void;
  closed: (reason: ChatCloseReason) => void;
  canFocus: () => boolean;
};
/** Счётчик символов появляется только у предела длины. */
const COUNTER_FROM = CHAT_MAX_LENGTH - 40;

/**
 * Поле ввода чата. Свёрнуто в кнопку по умолчанию; `T` или кнопка раскрывают его. Сворачивается ли
 * оно после отправки, решает настройка (по умолчанию Enter — отправить и закрыть, Shift+Enter —
 * отправить, не закрывая). Также сворачивают `Esc`, щелчок по миру и кнопка чата. Несохранённый
 * текст при сворачивании не теряется; отклонённое сообщение остаётся в поле. Истории нет.
 */
export class ChatConsole {
  private readonly controller = new AbortController();
  private state: ChatConsoleStatus = { available: false, pending: false, remainingMs: 0 };
  private composing = false;
  /** The current wait is longer than usual because of flooding. */
  private slowed = false;
  constructor(
    private readonly toggle: HTMLButtonElement,
    private readonly form: HTMLFormElement,
    private readonly row: HTMLElement,
    private readonly input: HTMLInputElement,
    private readonly status: HTMLElement,
    private readonly counter: HTMLElement,
    private readonly submit: HTMLButtonElement,
    private readonly canvas: HTMLCanvasElement,
    /** Returns whether the message actually left for the server. */
    private readonly send: (text: string) => boolean,
    private readonly lifecycle: ChatLifecycle,
    private readonly settings: ChatSettings,
  ) {
    const options = { signal: this.controller.signal };
    this.input.maxLength = CHAT_MAX_LENGTH;
    const renderHint = () => (this.input.placeholder = chatSendHint(settings.closeMode));
    renderHint();
    const unsubscribe = settings.onChange(renderHint);
    this.controller.signal.addEventListener('abort', unsubscribe);
    toggle.addEventListener(
      'click',
      () => (this.isOpen ? this.close('button') : this.open()),
      options,
    );
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
          this.handleEscape(event);
        } else if (
          (event.code === 'Enter' || event.code === 'NumpadEnter') &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          // Handled here rather than by implicit submission, so Shift is known.
          event.preventDefault();
          if (!event.repeat) this.trySend(event.shiftKey);
        }
      },
      options,
    );
    // The send button behaves like a plain Enter.
    form.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        this.trySend(false);
      },
      options,
    );
    // Only a click on the world collapses the field; other HUD controls leave it as it is.
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (this.isOpen && event.target === this.canvas) this.close('world');
      },
      options,
    );
  }
  private trySend(shift: boolean): void {
    if (this.composing || this.submit.disabled) return;
    if (this.send(this.input.value) && closesAfterSend(this.settings.closeMode, shift))
      this.close('send');
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
    this.lifecycle.beforeOpen();
    this.form.hidden = false;
    this.row.dataset.open = 'true';
    this.toggle.setAttribute('aria-expanded', 'true');
    this.toggle.setAttribute('aria-label', 'Свернуть чат');
    // `/` starts a command; otherwise the unsent draft is kept.
    if (initialText) this.input.value = initialText;
    this.render();
    this.focusInput();
  }
  /** The application routes Escape before other panels and gameplay handlers. */
  handleEscape(event: KeyboardEvent): void {
    event.stopImmediatePropagation();
    if (event.isComposing || this.composing || event.repeat) return;
    event.preventDefault();
    this.close('escape');
  }
  close(reason: ChatCloseReason): void {
    const wasOpen = this.isOpen;
    this.form.hidden = true;
    this.row.dataset.open = 'false';
    this.composing = false;
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.setAttribute('aria-label', 'Чат');
    this.render();
    if (wasOpen) this.lifecycle.closed(reason);
  }
  /** Server answer for the last message: a delivered message clears the field. */
  complete(ok: boolean): void {
    if (ok) this.input.value = '';
    this.render();
    const active = document.activeElement;
    if (
      this.isOpen &&
      this.lifecycle.canFocus() &&
      (active === this.input || active === document.body)
    )
      this.focusInput();
  }
  update(state: ChatConsoleStatus): void {
    this.state = state;
    this.toggle.hidden = !state.available;
    if (!state.available && !state.keepOpen) this.close('unavailable');
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
    if (this.state.remainingMs > CHAT_COOLDOWN_MS) this.slowed = true;
    else if (this.state.remainingMs <= 0) this.slowed = false;
    this.submit.disabled =
      !this.state.available ||
      this.state.pending ||
      (this.state.remainingMs > 0 && !command) ||
      !normalizeChatText(this.input.value);
    // Only states worth reading are shown; the placeholder already names the send keys.
    const message = !this.isOpen
      ? ''
      : this.state.pending
        ? 'Отправляем…'
        : this.state.remainingMs > 0 && !command
          ? `${this.slowed ? 'Слишком часто. ' : ''}Следующее сообщение через ${Math.ceil(this.state.remainingMs / 1000)} с`
          : command
            ? 'Enter — выполнить команду · Esc — свернуть'
            : '';
    if (this.status.textContent !== message) this.status.textContent = message;
  }
  dispose(): void {
    this.close('dispose');
    this.controller.abort();
  }
}
