/**
 * Что делает чат после отправки. `enter`: Enter отправляет и сворачивает, Shift+Enter отправляет и
 * оставляет поле открытым. `shift-enter`: наоборот. `never`: чат всегда остаётся открытым.
 */
export type ChatCloseMode = 'enter' | 'shift-enter' | 'never';

export const DEFAULT_CHAT_CLOSE_MODE: ChatCloseMode = 'enter';
const STORAGE_KEY = 'su:chat-close:v1';

export const isChatCloseMode = (value: unknown): value is ChatCloseMode =>
  value === 'enter' || value === 'shift-enter' || value === 'never';

/** Pure rule for one send: the Shift state of the Enter press (or `false` for the send button). */
export function closesAfterSend(mode: ChatCloseMode, shift: boolean): boolean {
  return mode === 'enter' ? !shift : mode === 'shift-enter' ? shift : false;
}

/** Хранится только в браузере игрока: без базы данных и без синхронизации между устройствами. */
export class ChatSettings {
  private chosen: ChatCloseMode = DEFAULT_CHAT_CLOSE_MODE;
  private readonly listeners = new Set<() => void>();
  constructor() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isChatCloseMode(stored)) this.chosen = stored;
    } catch {
      /* Без хранилища действует значение по умолчанию. */
    }
  }
  get closeMode(): ChatCloseMode {
    return this.chosen;
  }
  setCloseMode(mode: ChatCloseMode): void {
    if (mode === this.chosen) return;
    this.chosen = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* Настройка действует до перезагрузки. */
    }
    for (const listener of this.listeners) listener();
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Подпись под полем ввода для выбранного режима. */
export function chatSendHint(mode: ChatCloseMode): string {
  return mode === 'enter'
    ? 'Enter — отправить · Shift+Enter — не закрывая'
    : mode === 'shift-enter'
      ? 'Enter — отправить · Shift+Enter — и закрыть'
      : 'Enter — отправить';
}
