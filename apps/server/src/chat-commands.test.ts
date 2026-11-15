import { describe, expect, it } from 'vitest';
import { parseCommandHelpEffect } from '@su/contracts';
import { commandCatalog, commandHelp, parseChatCommand } from './chat-commands.js';
import { parseCommandLine, tokenize } from './commands/command-line.js';

const admin = (text: string) => parseChatCommand(text, 'admin');

describe('command line', () => {
  it('splits on whitespace and keeps quoted words together', () => {
    expect(tokenize('speed  @"Гость 2" --set=2')).toEqual(['speed', '@Гость 2', '--set=2']);
    expect(tokenize('give ""')).toEqual(['give', '']);
    expect(() => tokenize('speed @"Гость')).toThrow('кавычка');
  });

  it('reads long, short, inline and negated flags', () => {
    const spec = {
      name: 'demo',
      category: 'Тест',
      access: 'admin' as const,
      summary: 'Демо',
      args: [{ name: 'x', optional: true, help: 'x' }],
      flags: {
        level: {
          short: 'l',
          value: { name: 'N', parse: (raw: string) => Number(raw) || undefined },
          help: 'n',
        },
        loud: { negatable: true, help: 'l' },
      },
      examples: [],
    };
    const parsed = parseCommandLine(spec, ['arg', '-l', '3', '--no-loud'])!;
    expect(parsed.args).toEqual(['arg']);
    expect([...parsed.flags]).toEqual([
      ['level', 3],
      ['loud', false],
    ]);
    expect(parseCommandLine(spec, ['--level=4'])!.flags.get('level')).toBe(4);
    expect(parseCommandLine(spec, ['--loud', '-h'])).toBeUndefined();
    for (const [tokens, message] of [
      [['--level'], 'нужно значение'],
      [['--level', '--loud'], 'нужно значение'],
      [['--level', 'x'], 'Неверное значение'],
      [['--loud=yes'], 'не принимает'],
      [['--loud', '--loud'], 'дважды'],
      [['--quiet'], 'Неизвестный флаг'],
      [['-q'], 'Неизвестный флаг'],
      [['--no-level'], 'Неизвестный флаг'],
      [['a', 'b'], 'Лишний аргумент'],
    ] as const)
      expect(() => parseCommandLine(spec, tokens)).toThrow(message);
  });
});

describe('chat commands', () => {
  it('leaves ordinary chat alone', () => {
    expect(admin('Привет!')).toBeUndefined();
  });

  it('parses /time flags, combined in a stable order', () => {
    expect(admin('/time')).toEqual({ kind: 'time', actions: [] });
    expect(admin('/time --set 7')).toEqual({ kind: 'time', actions: [{ kind: 'set', hour: 7 }] });
    expect(admin('/time -s 18:30')).toEqual({
      kind: 'time',
      actions: [{ kind: 'set', hour: 18.5 }],
    });
    expect(admin('/time --set=00:00')).toEqual({
      kind: 'time',
      actions: [{ kind: 'set', hour: 0 }],
    });
    expect(admin('/time --set 22 --stop')).toEqual({
      kind: 'time',
      actions: [{ kind: 'stop' }, { kind: 'set', hour: 22 }],
    });
    expect(admin('/time --start --set 8')).toEqual({
      kind: 'time',
      actions: [{ kind: 'set', hour: 8 }, { kind: 'start' }],
    });
    for (const kind of ['stop', 'start', 'reset'] as const)
      expect(admin(`/time --${kind}`)).toEqual({ kind: 'time', actions: [{ kind }] });
  });

  it('takes the hour as a positional shorthand for --set', () => {
    expect(admin('/time 7')).toEqual({ kind: 'time', actions: [{ kind: 'set', hour: 7 }] });
    expect(admin('/time 22:30 --stop')).toEqual({
      kind: 'time',
      actions: [{ kind: 'stop' }, { kind: 'set', hour: 22.5 }],
    });
    for (const [text, message] of [
      ['/time 7 --set 8', 'дважды'],
      ['/time 7 --reset', 'нельзя указывать вместе'],
      ['/time 7 8', 'Лишний аргумент'],
      ['/time 25', 'Неверный час'],
    ] as const)
      expect(admin(text)).toMatchObject({
        kind: 'invalid',
        code: 'INVALID_INPUT',
        message: expect.stringContaining(message),
      });
  });

  it('rejects malformed /time input, including the old word forms', () => {
    for (const text of [
      '/time stop',
      '/time --set 24',
      '/time --set 12:60',
      '/time --set 12:5',
      '/time --set 1.5',
      '/time --set noon',
      '/time --set',
      '/time --stop --start',
      '/time --reset --set 5',
      '/time --stop=1',
    ])
      expect(admin(text)).toMatchObject({
        kind: 'invalid',
        code: 'INVALID_INPUT',
        message: expect.stringContaining('/time --help'),
      });
    expect(admin('/timestop')).toMatchObject({ kind: 'invalid', code: 'UNKNOWN_COMMAND' });
  });

  it('parses /weather toggles, clear and reset', () => {
    expect(admin('/weather')).toEqual({ kind: 'weather', actions: [] });
    expect(admin('/weather --reset')).toEqual({ kind: 'weather', actions: [{ kind: 'reset' }] });
    expect(admin('/weather --rain --no-clouds --fog')).toEqual({
      kind: 'weather',
      actions: [
        { kind: 'set', part: 'clouds', enabled: false },
        { kind: 'set', part: 'rain', enabled: true },
        { kind: 'set', part: 'fog', enabled: true },
      ],
    });
    expect(admin('/weather --snow --clear')).toEqual({
      kind: 'weather',
      actions: [{ kind: 'clear' }, { kind: 'set', part: 'snow', enabled: true }],
    });
    expect(admin('/weather --snow --no-rain')).toMatchObject({ kind: 'weather' });
    for (const text of [
      '/weather rain',
      '/weather --rain on',
      '/weather --rain --snow',
      '/weather --hail',
      '/weather --reset --fog',
      '/weather --no-clear',
      '/clouds off',
    ])
      expect(admin(text)).toMatchObject({ kind: 'invalid' });
  });

  it('parses /speed targets and multipliers as integer percent', () => {
    expect(admin('/speed')).toEqual({ kind: 'speed' });
    expect(admin('/speed --set 2')).toEqual({ kind: 'speed', percent: 200 });
    expect(admin('/speed -s 0,5')).toEqual({ kind: 'speed', percent: 50 });
    expect(admin('/speed --set x1.25')).toEqual({ kind: 'speed', percent: 125 });
    expect(admin('/speed @"Гость 2" --set=4')).toEqual({
      kind: 'speed',
      target: 'Гость 2',
      percent: 400,
    });
    expect(admin('/speed "@Гость 2" --reset')).toEqual({
      kind: 'speed',
      target: 'Гость 2',
      percent: 100,
    });
    expect(admin('/speed @Маша')).toEqual({ kind: 'speed', target: 'Маша' });
    expect(admin('/speed 2')).toEqual({ kind: 'speed', percent: 200 });
    expect(admin('/speed @Маша 0,5')).toEqual({ kind: 'speed', target: 'Маша', percent: 50 });
    expect(admin('/speed x1.5 @Маша')).toEqual({ kind: 'speed', target: 'Маша', percent: 150 });
    for (const [text, message] of [
      ['/speed --set 5', 'от 0.1 до 4'],
      ['/speed --set 0.05', 'от 0.1 до 4'],
      ['/speed --set fast', 'Неверное значение'],
      ['/speed --set 2 --reset', 'нельзя указывать вместе'],
      ['/speed 2 --set 3', 'дважды'],
      ['/speed 2 --reset', 'нельзя указывать вместе'],
      ['/speed Маша', 'через @'],
      ['/speed @', 'через @'],
      ['/speed @a @b', 'Лишний аргумент'],
      ['/speed 2 3', 'Лишний аргумент'],
    ] as const)
      expect(admin(text)).toMatchObject({
        kind: 'invalid',
        code: 'INVALID_INPUT',
        message: expect.stringContaining(message),
      });
    expect(parseChatCommand('/speed --set 2', 'player')).toMatchObject({
      code: 'UNKNOWN_COMMAND',
      forbidden: true,
    });
  });

  it('keeps old names as aliases of /give, /place and /remove', () => {
    for (const name of ['give', 'giveme'])
      expect(admin(`/${name} wooden-crate`)).toEqual({ kind: 'give', typeId: 'wooden-crate' });
    expect(admin('/give @Маша wooden-crate')).toEqual({
      kind: 'give',
      target: 'Маша',
      typeId: 'wooden-crate',
    });
    expect(admin('/give wooden-crate @"Гость 2"')).toEqual({
      kind: 'give',
      target: 'Гость 2',
      typeId: 'wooden-crate',
    });
    expect(admin('/give --list')).toEqual({ kind: 'giveList' });
    for (const text of [
      '/give',
      '/give a b',
      '/give @a @b crate',
      '/give @',
      '/give __proto__!',
      '/give crate --list',
      '/give @Маша --list',
    ])
      expect(admin(text)).toMatchObject({ kind: 'invalid', code: 'INVALID_INPUT' });
    for (const name of ['place', 'motherlode', 'PLACE'])
      expect(admin(`/${name}`)).toEqual({ kind: 'staticPlacement' });
    for (const name of ['remove', 'vilievna'])
      expect(admin(`/${name}`)).toEqual({ kind: 'staticRemoval' });
    expect(admin('/vilievna bench')).toMatchObject({ kind: 'invalid', code: 'INVALID_INPUT' });
  });

  it('turns --help, /help and /h into a help request for a canonical name', () => {
    expect(admin('/help')).toEqual({ kind: 'help' });
    expect(admin('/h')).toEqual({ kind: 'help' });
    expect(admin('/help /giveme')).toEqual({ kind: 'help', focus: 'give' });
    expect(admin('/time --help')).toEqual({ kind: 'help', focus: 'time' });
    expect(admin('/weather --rain -h')).toEqual({ kind: 'help', focus: 'weather' });
    expect(admin('/help nope')).toMatchObject({ kind: 'invalid', code: 'UNKNOWN_COMMAND' });
  });

  it('suggests close names and points to /help', () => {
    expect(admin('/tiem')).toMatchObject({
      message: 'Неизвестная команда. Возможно, /time? Список: /help.',
    });
    expect(admin('/zzzzzz')).toMatchObject({ message: 'Неизвестная команда. Список: /help.' });
  });

  it('makes admin commands indistinguishable from unknown ones for players', () => {
    for (const text of ['/time', '/time --stop', '/giveme crate', '/place', '/tiem', '/nope'])
      expect(parseChatCommand(text, 'player')).toMatchObject({
        kind: 'invalid',
        code: 'UNKNOWN_COMMAND',
        message: 'Неизвестная команда.',
      });
    expect(parseChatCommand('/time', 'player')).toMatchObject({ forbidden: true });
    expect(parseChatCommand('/nope', 'player')).not.toHaveProperty('forbidden');
    expect(parseChatCommand('/help', 'player')).toEqual({ kind: 'help' });
    expect(parseChatCommand('/help time', 'player')).toMatchObject({ code: 'UNKNOWN_COMMAND' });
  });

  it('builds help only from permitted commands and passes contract validation', () => {
    expect(commandHelp('player')).toBeUndefined();
    const playerCatalog = commandCatalog('player', { itemTypes: ['wooden-crate'] });
    expect(playerCatalog.commands.map((command) => command.name)).toEqual(['help']);
    expect(playerCatalog.commands[0].args[0].choices).toEqual(['help']);

    const help = commandHelp('admin', 'time', { itemTypes: ['lamp', 'wooden-crate'] })!;
    expect(help.commands.map((command) => command.name)).toEqual([
      'time',
      'weather',
      'speed',
      'give',
      'place',
      'remove',
      'help',
    ]);
    expect(help.focus).toBe('time');
    expect(help.commands[0].usage).toBe(
      'time [<ЧЧ[:ММ]>] [--set ЧЧ[:ММ]] [--stop | --start | --reset]',
    );
    expect(help.commands[0].conflicts).toContainEqual(['stop', 'start']);
    expect(help.commands.find((c) => c.name === 'give')?.args).toEqual([
      expect.objectContaining({ name: '@игрок', player: true }),
      expect.objectContaining({ name: 'тип', choices: ['lamp', 'wooden-crate'] }),
    ]);
    expect(parseCommandHelpEffect(JSON.parse(JSON.stringify(help)))).toEqual(help);
    expect(parseCommandHelpEffect(JSON.parse(JSON.stringify(playerCatalog)))).toEqual(
      playerCatalog,
    );
    expect(parseCommandHelpEffect({ ...help, focus: 'missing' })).toBeUndefined();
  });
});
