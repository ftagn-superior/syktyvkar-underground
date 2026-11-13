import { describe, expect, it } from 'vitest';
import { parseChatCommand } from './chat-commands.js';

describe('chat commands', () => {
  it('opens /vilievna privately and rejects arguments', () => {
    expect(parseChatCommand('/vilievna')).toEqual({ kind: 'staticRemoval' });
    for (const text of ['/vilievna bench', '/vilievna all now'])
      expect(parseChatCommand(text)).toMatchObject({ kind: 'invalid', code: 'INVALID_INPUT' });
  });
  it('leaves ordinary chat alone and keeps /giveme strict', () => {
    expect(parseChatCommand('Привет!')).toBeUndefined();
    expect(parseChatCommand('/giveme wooden-crate')).toEqual({
      kind: 'give',
      typeId: 'wooden-crate',
    });
    for (const text of ['/giveme', '/giveme a b', '/giveme __proto__!'])
      expect(parseChatCommand(text)).toMatchObject({ kind: 'invalid', code: 'INVALID_INPUT' });
    expect(parseChatCommand('/other')).toMatchObject({ kind: 'invalid', code: 'UNKNOWN_COMMAND' });
  });

  it('parses /time forms', () => {
    expect(parseChatCommand('/time')).toEqual({ kind: 'time' });
    expect(parseChatCommand('/time 7')).toEqual({ kind: 'time', action: { kind: 'set', hour: 7 } });
    expect(parseChatCommand('/time 18:30')).toEqual({
      kind: 'time',
      action: { kind: 'set', hour: 18.5 },
    });
    expect(parseChatCommand('/time 00:00')).toEqual({
      kind: 'time',
      action: { kind: 'set', hour: 0 },
    });
    for (const kind of ['stop', 'start', 'reset'] as const)
      expect(parseChatCommand(`/time ${kind}`)).toEqual({ kind: 'time', action: { kind } });
  });

  it('rejects malformed /time arguments', () => {
    for (const text of [
      '/time 24',
      '/time 12:60',
      '/time 12:5',
      '/time -1',
      '/time 1.5',
      '/time noon',
      '/time 12 30',
      '/time stop now',
      '/timestop',
    ])
      expect(parseChatCommand(text)).toMatchObject({ kind: 'invalid' });
  });

  it('parses /weather and the /clouds shorthand', () => {
    expect(parseChatCommand('/weather')).toEqual({ kind: 'weather' });
    expect(parseChatCommand('/weather reset')).toEqual({
      kind: 'weather',
      action: { kind: 'reset' },
    });
    for (const [text, enabled] of [
      ['/weather clouds off', false],
      ['/weather clouds on', true],
      ['/clouds off', false],
      ['/clouds on', true],
    ] as const)
      expect(parseChatCommand(text)).toEqual({
        kind: 'weather',
        action: { kind: 'clouds', enabled },
      });
    for (const text of [
      '/weather clouds',
      '/weather clouds maybe',
      '/weather clouds on now',
      '/weather rain on',
      '/weather reset now',
      '/clouds',
      '/clouds on off',
    ])
      expect(parseChatCommand(text)).toMatchObject({ kind: 'invalid', code: 'INVALID_INPUT' });
  });
});
