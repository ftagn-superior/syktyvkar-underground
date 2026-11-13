import { describe, expect, it } from 'vitest';
import { closesAfterSend, isChatCloseMode } from './chat-settings';

describe('chat close setting', () => {
  it('closes on the chosen Enter variant and keeps the field open for the other one', () => {
    expect(closesAfterSend('enter', false)).toBe(true);
    expect(closesAfterSend('enter', true)).toBe(false);
    expect(closesAfterSend('shift-enter', false)).toBe(false);
    expect(closesAfterSend('shift-enter', true)).toBe(true);
    expect(closesAfterSend('never', false)).toBe(false);
    expect(closesAfterSend('never', true)).toBe(false);
  });

  it('accepts only known stored values', () => {
    for (const mode of ['enter', 'shift-enter', 'never']) expect(isChatCloseMode(mode)).toBe(true);
    for (const value of ['', 'Enter', null, undefined, 1])
      expect(isChatCloseMode(value)).toBe(false);
  });
});
