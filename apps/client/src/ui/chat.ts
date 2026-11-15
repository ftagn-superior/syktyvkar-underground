import {
  CHAT_COOLDOWN_MS,
  CHAT_MAX_LENGTH,
  normalizeChatText,
  type CommandHelpEntry,
} from '@su/contracts';
import { completeCommand, type Completion, type CompletionCandidate } from './command-completion';
import { chatSendHint, closesAfterSend, type ChatSettings } from './chat-settings';

export interface ChatConsoleStatus {
  available: boolean;
  keepOpen?: boolean;
  pending: boolean;
  remainingMs: number;
}
/** Откуда поле берёт данные для автодополнения команд. */
export interface ChatCompletionSource {
  /** Список с сервера; `undefined`, пока он не получен (вызов заодно его запрашивает). */
  commands(): readonly CommandHelpEntry[] | undefined;
  /** Имена игроков, известных клиенту. */
  players(): string[];
}
/** Сколько подсказок видно одновременно. */
const SUGGESTIONS_SHOWN = 6;

export type ChatCloseReason =
  'send' | 'escape' | 'button' | 'world' | 'replace' | 'unavailable' | 'dispose';

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
 *
 * Если текст начинается с `/`, над полем показаны подходящие команды, флаги и значения, а `Tab`
 * подставляет их: повторный `Tab` перебирает варианты, `Shift+Tab` — в обратную сторону.
 */
export class ChatConsole {
  private readonly controller = new AbortController();
  private state: ChatConsoleStatus = { available: false, pending: false, remainingMs: 0 };
  private composing = false;
  /** The current wait is longer than usual because of flooding. */
  private slowed = false;
  /** Перебор вариантов по Tab; действует, пока текст поля равен `value`. */
  private cycle?: {
    start: number;
    end: number;
    value: string;
    candidates: CompletionCandidate[];
    index: number;
    hint?: string;
  };
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
    private readonly suggest?: HTMLElement,
    private readonly completion?: ChatCompletionSource,
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
    input.addEventListener(
      'input',
      () => {
        this.cycle = undefined;
        this.render();
      },
      options,
    );
    input.addEventListener('click', () => this.render(), options);
    input.addEventListener(
      'keyup',
      (event) => {
        if (
          event.code === 'ArrowLeft' ||
          event.code === 'ArrowRight' ||
          event.code === 'Home' ||
          event.code === 'End'
        )
          this.render();
      },
      options,
    );
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
          event.code === 'Tab' &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          this.input.value.trimStart().startsWith('/')
        ) {
          event.preventDefault();
          if (!event.repeat && !this.input.readOnly) this.applyTab(event.shiftKey ? -1 : 1);
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
    suggest?.addEventListener(
      'pointerdown',
      (event) => {
        if ((event.target as Element | null)?.closest?.('.chat-suggest-option'))
          event.preventDefault();
      },
      options,
    );
    suggest?.addEventListener(
      'click',
      (event) => {
        const option = (event.target as Element | null)?.closest?.<HTMLElement>(
          '.chat-suggest-option',
        );
        if (!option) return;
        const index = Number(option.dataset.index);
        if (Number.isInteger(index)) this.pickCandidate(index);
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
    this.cycle = undefined;
    this.render();
    this.focusInput();
  }
  /** Заменяет текст поля (например, командой из справки) и ставит курсор в конец. */
  insert(text: string): void {
    if (!this.state.available) return;
    if (!this.isOpen) this.open();
    this.cycle = undefined;
    this.input.value = text.slice(0, CHAT_MAX_LENGTH);
    this.render();
    this.focusInput();
  }
  /** Обновляет подсказки, когда с сервера пришёл список доступных команд. */
  refreshSuggestions(): void {
    if (this.isOpen) this.render();
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
    this.cycle = undefined;
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
  private activeCompletion(): { completion: Completion; selectedIndex: number } | undefined {
    if (!this.isOpen || !this.completion || !this.input.value.trimStart().startsWith('/')) return;
    const commands = this.completion.commands();
    if (!commands) return;
    if (this.cycle && this.cycle.value === this.input.value) {
      return {
        completion: {
          start: this.cycle.start,
          end: this.cycle.end,
          candidates: this.cycle.candidates,
          hint: this.cycle.hint,
        },
        selectedIndex: this.cycle.index,
      };
    }
    this.cycle = undefined;
    const cursor = this.input.selectionStart ?? this.input.value.length;
    const completion = completeCommand(
      this.input.value,
      cursor,
      commands,
      this.completion.players(),
    );
    if (!completion) return;
    return { completion, selectedIndex: -1 };
  }
  private applyCompletion(
    completion: Completion,
    candidate: CompletionCandidate,
    keepCycle?: { candidates: CompletionCandidate[]; index: number; hint?: string },
  ): void {
    const nextValue =
      this.input.value.slice(0, completion.start) +
      candidate.insert +
      this.input.value.slice(completion.end);
    if (nextValue.length > CHAT_MAX_LENGTH) return;
    const nextEnd = completion.start + candidate.insert.length;
    this.input.value = nextValue;
    this.input.setSelectionRange(nextEnd, nextEnd);
    this.cycle =
      keepCycle && keepCycle.candidates.length > 1
        ? {
            start: completion.start,
            end: nextEnd,
            value: nextValue,
            candidates: keepCycle.candidates,
            index: keepCycle.index,
            hint: keepCycle.hint,
          }
        : undefined;
    this.render();
  }
  private applyTab(step: 1 | -1): void {
    const active = this.activeCompletion();
    if (!active || !active.completion.candidates.length) return;
    const { completion } = active;
    const count = completion.candidates.length;
    const index =
      this.cycle && this.cycle.value === this.input.value
        ? (this.cycle.index + step + count) % count
        : step < 0
          ? count - 1
          : 0;
    this.applyCompletion(completion, completion.candidates[index], {
      candidates: completion.candidates,
      index,
      hint: completion.hint,
    });
  }
  private pickCandidate(index: number): void {
    if (this.input.readOnly) return;
    const active = this.activeCompletion();
    const candidate = active?.completion.candidates[index];
    if (!active || !candidate) return;
    this.applyCompletion(active.completion, candidate);
    this.input.focus({ preventScroll: true });
  }
  private renderSuggestions(): boolean {
    if (!this.suggest) return false;
    const active = this.activeCompletion();
    if (!active || (!active.completion.candidates.length && !active.completion.hint)) {
      this.suggest.hidden = true;
      this.suggest.replaceChildren();
      this.input.setAttribute('aria-expanded', 'false');
      this.input.removeAttribute('aria-activedescendant');
      return false;
    }
    const { candidates, hint } = active.completion;
    const nodes: HTMLElement[] = [];
    if (candidates.length) {
      const start =
        active.selectedIndex >= SUGGESTIONS_SHOWN
          ? active.selectedIndex - SUGGESTIONS_SHOWN + 1
          : 0;
      const visible = candidates.slice(start, start + SUGGESTIONS_SHOWN);
      for (const [offset, candidate] of visible.entries()) {
        const index = start + offset;
        const option = document.createElement('div');
        option.id = `chat-suggest-opt-${index}`;
        option.className = 'chat-suggest-option';
        option.setAttribute('role', 'option');
        option.dataset.index = String(index);
        option.setAttribute('aria-selected', String(index === active.selectedIndex));
        const label = document.createElement('code');
        label.textContent = candidate.label;
        const help = document.createElement('span');
        help.textContent = candidate.help;
        option.append(label, help);
        nodes.push(option);
      }
      if (active.selectedIndex >= 0)
        this.input.setAttribute(
          'aria-activedescendant',
          `chat-suggest-opt-${active.selectedIndex}`,
        );
      else this.input.removeAttribute('aria-activedescendant');
    } else if (hint) {
      const row = document.createElement('div');
      row.className = 'chat-suggest-hint';
      const separator = hint.indexOf(' — ');
      const code = document.createElement('code');
      code.textContent = separator < 0 ? hint : hint.slice(0, separator);
      row.append(code);
      if (separator >= 0) {
        const help = document.createElement('span');
        help.textContent = hint.slice(separator + 3);
        row.append(help);
      }
      nodes.push(row);
      this.input.removeAttribute('aria-activedescendant');
    }
    this.suggest.replaceChildren(...nodes);
    this.suggest.hidden = false;
    this.input.setAttribute('aria-expanded', String(candidates.length > 0));
    return candidates.length > 0;
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
    const hasSuggestions = this.renderSuggestions();
    // Only states worth reading are shown; the placeholder already names the send keys.
    const message = !this.isOpen
      ? ''
      : this.state.pending
        ? 'Отправляем…'
        : this.state.remainingMs > 0 && !command
          ? `${this.slowed ? 'Слишком часто. ' : ''}Следующее сообщение через ${Math.ceil(this.state.remainingMs / 1000)} с`
          : command
            ? hasSuggestions
              ? 'Tab — дополнить · Enter — выполнить · Esc — свернуть'
              : 'Enter — выполнить команду · Esc — свернуть'
            : '';
    if (this.status.textContent !== message) this.status.textContent = message;
  }
  dispose(): void {
    this.close('dispose');
    this.controller.abort();
  }
}
