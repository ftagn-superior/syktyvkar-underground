export const CHAT_MAX_LENGTH = 255;
/** Short flood guard: a new message replaces the one above the head. */
export const CHAT_COOLDOWN_MS = 1000;

/** One line of plain text. The same limit applies to typing and network requests. */
export function normalizeChatText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > CHAT_MAX_LENGTH) return;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text || undefined;
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
