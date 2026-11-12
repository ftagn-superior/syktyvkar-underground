import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_LENGTH,
  CHAT_MIN_COOLDOWN_MS,
  CHAT_MAX_COOLDOWN_MS,
  chatCooldownMs,
  normalizeChatText,
} from './chat.js';

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

  it('preserves the sending cooldown independently of the message lifetime', () => {
    expect(chatCooldownMs('Привет')).toBe(CHAT_MIN_COOLDOWN_MS);
    expect(chatCooldownMs('я'.repeat(150))).toBeGreaterThan(CHAT_MIN_COOLDOWN_MS);
    expect(chatCooldownMs('я'.repeat(CHAT_MAX_LENGTH))).toBe(CHAT_MAX_COOLDOWN_MS);
  });
});
