import { describe, expect, it } from 'vitest';
import { ChatReturnContext, type ChatReturnMode } from './chat-return';

describe('chat control return context', () => {
  it.each(['overview', 'first-person-cursor', 'first-person-active'] as ChatReturnMode[])(
    'remembers %s until one actual close, independently of the server reply',
    (mode) => {
      const context = new ChatReturnContext();
      const session = {};
      context.begin(mode, session);
      context.sent(1, session);
      const previous = context.finish(session)!;
      expect(previous.mode).toBe(mode);
      expect(context.isCurrent(previous, session)).toBe(true);
      expect(context.finish(session)).toBeUndefined();
      expect(context.acceptCommand(1, session)).toBe(true);
      expect(context.isCurrent(previous, session)).toBe(true);
    },
  );

  it('cancels both an open interaction and an already queued return on newer intent', () => {
    const context = new ChatReturnContext();
    const session = {};
    context.begin('first-person-active', session);
    context.invalidate();
    expect(context.finish(session)).toBeUndefined();
    context.begin('first-person-active', session);
    const previous = context.finish(session)!;
    context.invalidate();
    expect(context.isCurrent(previous, session)).toBe(false);
  });

  it('does not restore into a replaced room or revive after a new chat interaction', () => {
    const context = new ChatReturnContext();
    const session = {};
    context.begin('first-person-active', session);
    expect(context.finish({})).toBeUndefined();
    context.begin('first-person-active', session);
    const previous = context.finish(session)!;
    context.begin('first-person-cursor', session);
    expect(context.isCurrent(previous, session)).toBe(false);
    expect(context.finish(session)?.mode).toBe('first-person-cursor');
  });

  it('accepts a UI command once and rejects superseded, stale and foreign-room effects', () => {
    const context = new ChatReturnContext();
    const session = {};
    context.sent(1, session);
    context.sent(2, session);
    expect(context.acceptCommand(1, session)).toBe(false);
    expect(context.acceptCommand(2, session)).toBe(true);
    expect(context.acceptCommand(2, session)).toBe(false);
    context.sent(3, session);
    context.invalidate();
    expect(context.acceptCommand(3, session)).toBe(false);
    context.sent(4, session);
    expect(context.acceptCommand(4, {})).toBe(false);
  });

  it('keeps an in-flight UI reply through network waiting without restoring controls', () => {
    const context = new ChatReturnContext();
    const session = {};
    context.begin('first-person-active', session);
    const previous = context.finish(session)!;
    context.sent(1, session);
    context.pauseControls();
    expect(context.isCurrent(previous, session)).toBe(false);
    expect(context.finish(session)).toBeUndefined();
    expect(context.acceptCommand(1, session)).toBe(true);
    expect(context.acceptCommand(1, session)).toBe(false);
  });

  it('still cancels a paused UI reply on newer intent or a replaced room', () => {
    const context = new ChatReturnContext();
    const session = {};
    context.sent(1, session);
    context.pauseControls();
    context.invalidate();
    expect(context.acceptCommand(1, session)).toBe(false);
    context.sent(2, session);
    context.pauseControls();
    context.begin('overview', session);
    expect(context.acceptCommand(2, session)).toBe(false);
    context.sent(3, session);
    context.pauseControls();
    expect(context.acceptCommand(3, {})).toBe(false);
  });
});
