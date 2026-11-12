import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_LENGTH,
  CHAT_MIN_DURATION_MS,
  CHAT_MAX_DURATION_MS,
  chatDurationMs,
  normalizeChatText,
} from './chat.js';

describe('transient chat text', () => {
  it('accepts plain text up to the input limit, including Cyrillic, emoji and literal markup', () => {
    expect(normalizeChatText('  Привет! 🙂 <b>сосед</b>\n как\tдела?  ')).toBe(
      'Привет! 🙂 <b>сосед</b> как дела?',
    );
    expect(normalizeChatText('я'.repeat(CHAT_MAX_LENGTH))).toHaveLength(CHAT_MAX_LENGTH);
    expect(normalizeChatText('я'.repeat(CHAT_MAX_LENGTH + 1))).toBeUndefined();
  });

  it('rejects empty, whitespace-only and non-string payloads', () => {
    for (const value of ['', ' \n\t ', null, undefined, 123, {}, ['привет']])
      expect(normalizeChatText(value)).toBeUndefined();
  });

  it('leaves more reading time for longer messages within a short bounded lifetime', () => {
    expect(chatDurationMs('Привет')).toBe(CHAT_MIN_DURATION_MS);
    expect(chatDurationMs('я'.repeat(150))).toBeGreaterThan(CHAT_MIN_DURATION_MS);
    expect(chatDurationMs('я'.repeat(CHAT_MAX_LENGTH))).toBe(CHAT_MAX_DURATION_MS);
  });
});
