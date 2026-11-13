import { createSign } from './player-sign';

/** Replicated player fields the log reads; the protocol is unchanged. */
export interface ChatSource {
  name?: string;
  color?: string;
  chatText?: string;
  chatSequence?: number;
}
export interface ChatLine {
  key: string;
  name: string;
  color: string;
  text: string;
  own: boolean;
  system?: boolean;
}

export const CHAT_LOG_LINES = 5;

/**
 * Pure part of the log: remembers the last seen chat sequence per player and returns lines for
 * new messages only. A player who re-enters view with the same bubble is not logged twice.
 */
export class ChatHistory {
  private readonly seen = new Map<string, number>();
  private lines: ChatLine[] = [];
  private counter = 0;
  observe(players: Iterable<[string, ChatSource]>, ownKey: string | undefined): boolean {
    let changed = false;
    for (const [key, player] of players) {
      const sequence = player.chatSequence ?? 0;
      const text = player.chatText?.trim();
      if (!text || !sequence || this.seen.get(key) === sequence) continue;
      this.seen.set(key, sequence);
      this.push({
        name: player.name || 'Гость',
        color: player.color ?? '',
        text,
        own: key === ownKey,
      });
      changed = true;
    }
    return changed;
  }
  system(text: string): void {
    this.push({ name: '', color: '', text, own: false, system: true });
  }
  get current(): readonly ChatLine[] {
    return this.lines;
  }
  clear(): void {
    this.seen.clear();
    this.lines = [];
  }
  private push(line: Omit<ChatLine, 'key'>): void {
    this.lines = [...this.lines, { ...line, key: String(++this.counter) }].slice(-CHAT_LOG_LINES);
  }
}

/** Лента последних сообщений над полем ввода: видна всегда, старые строки бледнеют. */
export class ChatLog {
  private readonly history = new ChatHistory();
  private rendered = '';
  constructor(private readonly container: HTMLElement) {}
  observe(players: Iterable<[string, ChatSource]>, ownKey: string | undefined): void {
    if (this.history.observe(players, ownKey)) this.render();
  }
  system(text: string): void {
    this.history.system(text);
    this.render();
  }
  clear(): void {
    this.history.clear();
    this.render();
  }
  private render(): void {
    const lines = this.history.current;
    const signature = lines.map((line) => line.key).join(',');
    if (signature === this.rendered) return;
    this.rendered = signature;
    this.container.replaceChildren(
      ...lines.map((line) => {
        const row = document.createElement('div');
        row.className = line.system ? 'chat-line sys' : 'chat-line';
        if (line.system) row.textContent = line.text;
        else {
          const name = document.createElement('b');
          name.textContent = `${line.own ? 'Вы' : line.name}:`;
          row.append(createSign(line.name, line.color), name, ` ${line.text}`);
        }
        return row;
      }),
    );
  }
}
