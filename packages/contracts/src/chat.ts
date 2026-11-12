export const CHAT_MAX_LENGTH = 255;
export const CHAT_MOVE_DURATION_MS = 5000;
export const CHAT_MIN_COOLDOWN_MS = 5000;
export const CHAT_MAX_COOLDOWN_MS = 15_000;

/** One line of plain text. The same limit applies to typing and network requests. */
export function normalizeChatText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > CHAT_MAX_LENGTH) return;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text || undefined;
}

/** Sending cooldown is independent of the message's time on screen. */
export function chatCooldownMs(text: string): number {
  return Math.min(CHAT_MAX_COOLDOWN_MS, Math.max(CHAT_MIN_COOLDOWN_MS, text.length * 60));
}

export interface ChatRequest {
  requestId: number;
  worldEpoch: string;
  text: string;
}

export interface DisplayChat {
  text: string;
  sequence: number;
  /** Infinity while the author has not moved since sending. */
  remainingMs: number;
}
