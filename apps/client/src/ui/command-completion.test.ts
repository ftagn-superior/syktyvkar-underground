import { describe, expect, it } from 'vitest';
import type { CommandHelpEntry } from '@su/contracts';
import { completeCommand } from './command-completion';

const entry = (value: Partial<CommandHelpEntry> & { name: string }): CommandHelpEntry => ({
  aliases: [],
  category: 'Тест',
  summary: `Команда ${value.name}`,
  usage: value.name,
  args: [],
  flags: [],
  conflicts: [],
  examples: [],
  ...value,
});

const commands: CommandHelpEntry[] = [
  entry({
    name: 'time',
    args: [{ name: 'ЧЧ[:ММ]', optional: true, help: 'Краткая форма --set' }],
    flags: [
      { name: 'set', short: 's', value: 'ЧЧ[:ММ]', help: 'Установить час' },
      { name: 'stop', help: 'Остановить' },
      { name: 'start', help: 'Запустить' },
      { name: 'reset', help: 'Сбросить' },
    ],
    conflicts: [
      ['stop', 'start'],
      ['reset', 'set'],
      ['reset', 'stop'],
      ['reset', 'start'],
    ],
  }),
  entry({
    name: 'weather',
    flags: [{ name: 'rain', negatable: true, help: 'Дождь' }],
  }),
  entry({
    name: 'speed',
    args: [
      { name: '@игрок', optional: true, help: 'Кому', player: true },
      { name: 'МНОЖИТЕЛЬ', optional: true, help: 'Краткая форма --set' },
    ],
    flags: [
      { name: 'set', short: 's', value: 'МНОЖИТЕЛЬ', help: 'Множитель' },
      { name: 'reset', help: 'Сбросить' },
    ],
    conflicts: [['set', 'reset']],
  }),
  entry({
    name: 'give',
    aliases: ['giveme'],
    args: [
      { name: '@игрок', optional: true, help: 'Кому', player: true },
      {
        name: 'тип',
        optional: true,
        help: 'ID типа',
        choices: ['wooden-crate', 'wooden-chair', 'lamp'],
      },
    ],
    flags: [{ name: 'list', short: 'l', help: 'Список' }],
  }),
  entry({ name: 'place', aliases: ['motherlode'] }),
  entry({
    name: 'help',
    aliases: ['h'],
    args: [
      {
        name: 'команда',
        optional: true,
        help: 'Команда',
        choices: ['time', 'weather', 'speed', 'give', 'place', 'help'],
      },
    ],
  }),
];

describe('command completion', () => {
  it('completes canonical command names and hides aliases unless no canonical matches', () => {
    expect(completeCommand('обычный текст', 5, commands)).toBeUndefined();
    expect(completeCommand('/ti', 3, commands)).toEqual({
      start: 1,
      end: 3,
      candidates: [{ insert: 'time ', label: '/time', help: 'Команда time' }],
    });
    expect(completeCommand('/g', 2, commands)?.candidates.map((c) => c.label)).toEqual(['/give']);
    expect(completeCommand('/givem', 6, commands)?.candidates.map((c) => c.label)).toEqual([
      '/giveme',
    ]);
    expect(completeCommand('/m', 2, commands)?.candidates.map((c) => c.label)).toEqual([
      '/motherlode',
    ]);
  });

  it('completes flags, negatable forms, and excludes used or conflicting flags', () => {
    expect(completeCommand('/time --st', 10, commands)?.candidates.map((c) => c.insert)).toEqual([
      '--stop ',
      '--start ',
    ]);
    expect(
      completeCommand('/time --stop --', 15, commands)?.candidates.map((c) => c.insert),
    ).toEqual(['--set ']);
    expect(
      completeCommand('/time 18:30 --', 14, commands)?.candidates.map((c) => c.insert),
    ).toEqual(['--stop ', '--start ']);
    expect(
      completeCommand('/weather --no-', 14, commands)?.candidates.map((c) => c.insert),
    ).toEqual(['--no-rain ']);
  });

  it('shows expected value hint after value flags instead of candidates', () => {
    expect(completeCommand('/time --set ', 12, commands)).toEqual({
      start: 12,
      end: 12,
      candidates: [],
      hint: 'ЧЧ[:ММ] — Установить час',
    });
    expect(completeCommand('/time -s ', 9, commands)?.hint).toContain('ЧЧ[:ММ]');
    expect(completeCommand('/time --set=18', 14, commands)?.hint).toContain('ЧЧ[:ММ]');
  });

  it('completes @player names with quoting for spaces and item choices in any order', () => {
    const players = ['Маша', 'Гость 2'];
    expect(completeCommand('/speed @', 8, commands, players)?.candidates).toEqual([
      { insert: '@Маша ', label: '@Маша', help: 'Игрок в сети' },
      { insert: '@"Гость 2" ', label: '@Гость 2', help: 'Игрок в сети' },
    ]);
    expect(
      completeCommand('/speed @"го', 11, commands, players)?.candidates.map((c) => c.insert),
    ).toEqual(['@"Гость 2" ']);
    expect(
      completeCommand('/give w', 7, commands, players)?.candidates.map((c) => c.insert),
    ).toEqual(['wooden-crate ', 'wooden-chair ']);
    expect(
      completeCommand('/give @Маша ', 12, commands, players)?.candidates.map((c) => c.insert),
    ).toEqual(['wooden-crate ', 'wooden-chair ', 'lamp ']);
    expect(
      completeCommand('/give wooden-crate @м', 21, commands, players)?.candidates.map(
        (c) => c.insert,
      ),
    ).toEqual(['@Маша ']);
    expect(
      completeCommand('/give ', 6, commands, players)?.candidates.map((c) => c.insert),
    ).toEqual(['wooden-crate ', 'wooden-chair ', 'lamp ', '@Маша ', '@"Гость 2" ', '--list ']);
    expect(
      completeCommand('/give wooden-crate ', 19, commands, players)?.candidates.map(
        (c) => c.insert,
      ),
    ).toEqual(['@Маша ', '@"Гость 2" ']);
    expect(completeCommand('/give --list ', 13, commands, players)).toBeUndefined();
    expect(completeCommand('/give --list w', 14, commands, players)).toBeUndefined();
    expect(completeCommand('/give --list @', 14, commands, players)).toBeUndefined();
    expect(completeCommand('/give @Маша @', 13, commands, players)).toBeUndefined();
  });

  it('suppresses positional shorthand hints when --set or --reset already satisfies or blocks it', () => {
    const players = ['Маша'];
    expect(completeCommand('/time --set 18:30 --stop ', 25, commands)).toBeUndefined();
    expect(completeCommand('/time --reset ', 14, commands)).toBeUndefined();
    expect(
      completeCommand('/speed --reset ', 15, commands, players)?.candidates.map((c) => c.insert),
    ).toEqual(['@Маша ']);
    expect(completeCommand('/speed @Маша --set 2 ', 21, commands, players)).toBeUndefined();
    expect(completeCommand('/speed @Маша --reset ', 21, commands, players)).toBeUndefined();
  });

  it('only completes commands allowed in the provided catalog', () => {
    const playerOnly = [commands[5]];
    expect(completeCommand('/', 1, playerOnly)?.candidates.map((c) => c.label)).toEqual(['/help']);
    expect(completeCommand('/ti', 3, playerOnly)).toBeUndefined();
  });
});
