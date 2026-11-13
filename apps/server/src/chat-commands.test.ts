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
    for (const kind of ['reset', 'clear'] as const)
      expect(parseChatCommand(`/weather ${kind}`)).toEqual({ kind: 'weather', action: { kind } });
    for (const [text, part, enabled] of [
      ['/weather clouds off', 'clouds', false],
      ['/weather clouds on', 'clouds', true],
      ['/weather rain', 'rain', true],
      ['/weather rain off', 'rain', false],
      ['/weather snow on', 'snow', true],
      ['/weather fog', 'fog', true],
      ['/weather fog off', 'fog', false],
      ['/clouds off', 'clouds', false],
      ['/clouds on', 'clouds', true],
    ] as const)
      expect(parseChatCommand(text)).toEqual({
        kind: 'weather',
        action: { kind: 'set', part, enabled },
      });
    for (const text of [
      '/weather clouds maybe',
      '/weather clouds on now',
      '/weather hail on',
      '/weather reset now',
      '/weather clear off',
      '/weather  rain',
      '/clouds',
      '/clouds on off',
    ])
      expect(parseChatCommand(text)).toMatchObject({ kind: 'invalid', code: 'INVALID_INPUT' });
  });
});
