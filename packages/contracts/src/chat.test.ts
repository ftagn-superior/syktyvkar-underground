import { describe, expect, it } from 'vitest';
import { CHAT_MAX_LENGTH, normalizeChatText } from './chat.js';

describe('world chat text', () => {
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
});
