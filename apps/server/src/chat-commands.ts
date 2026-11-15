import {
  COMMAND_CHOICES_MAX,
  ITEM_GIVE_COOLDOWN_MS,
  PLAYER_SPEED_PERCENT,
  type CommandHelpEffect,
  type DayClockAction,
  type ItemError,
  type WeatherAction,
  type WeatherPart,
} from '@su/contracts';
import {
  CommandLineError,
  commandHelpEntry,
  editDistance,
  parseCommandLine,
  tokenize,
  type CommandAccess,
  type CommandSpec,
  type ParsedCommandLine,
} from './commands/command-line.js';

export type { CommandAccess } from './commands/command-line.js';

export type ChatCommand =
  /** `target` — имя игрока без `@`, по умолчанию отправитель. */
  | { kind: 'give'; typeId: string; target?: string }
  | { kind: 'giveList' }
  /** Пустой список действий — только сообщить текущее время. */
  | { kind: 'time'; actions: DayClockAction[] }
  /** Пустой список действий — только сообщить текущую погоду. */
  | { kind: 'weather'; actions: WeatherAction[] }
  | { kind: 'staticPlacement' }
  | { kind: 'staticRemoval' }
  | { kind: 'help'; focus?: string }
  /**
   * `target` — имя игрока без `@`, по умолчанию отправитель. Без `percent` только сообщает
   * скорость; 100 — обычная.
   */
  | { kind: 'speed'; target?: string; percent?: number }
  | {
      kind: 'invalid';
      code: 'INVALID_INPUT' | 'UNKNOWN_COMMAND';
      message: string;
      /** Команда существует, но отправителю недоступна; для него она выглядит неизвестной. */
      forbidden?: boolean;
    };

interface ChatCommandDefinition extends CommandSpec {
  build(parsed: ParsedCommandLine): ChatCommand | string;
}

const hour = {
  name: 'ЧЧ[:ММ]',
  parse(raw: string) {
    const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(raw);
    if (!match) return;
    const hours = Number(match[1]),
      minutes = Number(match[2] ?? 0);
    if (hours > 23 || minutes > 59) return;
    return hours + minutes / 60;
  },
};

/**
 * Делит позиционные аргументы на `@игрок` и остальные: порядок между ними свободный, так что
 * годятся и `/speed @Гость 2`, и `/speed 2 @Гость`. Строка — текст ошибки.
 */
function splitTarget(args: readonly string[]): { target?: string; rest: string[] } | string {
  let target: string | undefined;
  const rest: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith('@')) rest.push(arg);
    else if (arg.length < 2) return 'Игрока указывают через @: @Имя.';
    else if (target !== undefined) return `Лишний аргумент «${arg}».`;
    else target = arg.slice(1);
  }
  return { ...(target === undefined ? {} : { target }), rest };
}
const PLAYER_ARGUMENT = {
  name: '@игрок',
  optional: true,
  help: 'По умолчанию вы. Имя с пробелами — в кавычках: @"Гость 2"',
  complete: 'player',
};

const WEATHER_PARTS: readonly WeatherPart[] = ['clouds', 'rain', 'snow', 'fog'];

const SPEED_RANGE = `от ${PLAYER_SPEED_PERCENT.min / 100} до ${PLAYER_SPEED_PERCENT.max / 100}`;
/** `2`, `1.5`, `1,5`, `x2` или `×2` → целые проценты. */
const speedMultiplier = {
  name: 'МНОЖИТЕЛЬ',
  parse(raw: string) {
    const match = /^[x×]?(\d{1,3}(?:[.,]\d{1,2})?)$/i.exec(raw);
    if (!match) return;
    const percent = Math.round(Number(match[1].replace(',', '.')) * 100);
    if (percent < PLAYER_SPEED_PERCENT.min || percent > PLAYER_SPEED_PERCENT.max)
      throw new CommandLineError(`Множитель скорости — ${SPEED_RANGE}.`);
    return percent;
  },
};

/** Порядок задаёт и порядок в `/help`. */
const COMMANDS: readonly ChatCommandDefinition[] = [
  {
    name: 'time',
    category: 'Мир',
    access: 'admin',
    summary: 'Игровое время. Без флагов сообщает текущий час.',
    args: [{ name: 'ЧЧ[:ММ]', optional: true, help: 'Краткая форма --set' }],
    flags: {
      set: { short: 's', value: hour, help: 'Установить час' },
      stop: { help: 'Остановить часы' },
      start: { help: 'Запустить остановленные часы' },
      reset: { help: 'Вернуть общее время' },
    },
    conflicts: [
      ['stop', 'start'],
      ['reset', 'set'],
      ['reset', 'stop'],
      ['reset', 'start'],
    ],
    examples: ['/time', '/time 18:30', '/time --set 22 --stop', '/time --start', '/time --reset'],
    build({ args, flags }) {
      let setHour = flags.has('set') ? (flags.get('set') as number) : undefined;
      if (args[0] !== undefined) {
        if (flags.has('set')) return 'Час указан дважды.';
        if (flags.get('reset')) return 'Флаг --reset нельзя указывать вместе с часом.';
        const parsed = hour.parse(args[0]);
        if (parsed === undefined) return `Неверный час: «${args[0]}». Ожидается ${hour.name}.`;
        setHour = parsed;
      }
      const actions: DayClockAction[] = [];
      // Сначала остановка: тогда `--set` закрепляет ровно указанный час.
      if (flags.get('stop')) actions.push({ kind: 'stop' });
      if (setHour !== undefined) actions.push({ kind: 'set', hour: setHour });
      if (flags.get('start')) actions.push({ kind: 'start' });
      if (flags.get('reset')) actions.push({ kind: 'reset' });
      return { kind: 'time', actions };
    },
  },
  {
    name: 'weather',
    category: 'Мир',
    access: 'admin',
    summary: 'Погода в комнате. Без флагов сообщает текущую.',
    flags: {
      clouds: { negatable: true, help: 'Облака' },
      rain: { negatable: true, help: 'Дождь' },
      snow: { negatable: true, help: 'Снег' },
      fog: { negatable: true, help: 'Туман' },
      clear: { help: 'Ясно: убрать облака, осадки и туман' },
      reset: { help: 'Погода по умолчанию' },
    },
    conflicts: [['reset', 'clear'], ...WEATHER_PARTS.map((part) => ['reset', part])],
    examples: [
      '/weather',
      '/weather --rain --fog',
      '/weather --no-clouds',
      '/weather --clear --snow',
      '/weather --reset',
    ],
    build({ flags }) {
      if (flags.get('rain') === true && flags.get('snow') === true)
        return 'Дождь и снег одновременно включить нельзя.';
      const actions: WeatherAction[] = [];
      if (flags.get('reset')) actions.push({ kind: 'reset' });
      if (flags.get('clear')) actions.push({ kind: 'clear' });
      for (const part of WEATHER_PARTS)
        if (flags.has(part))
          actions.push({ kind: 'set', part, enabled: flags.get(part) as boolean });
      return { kind: 'weather', actions };
    },
  },
  {
    name: 'speed',
    category: 'Игроки',
    access: 'admin',
    summary: 'Скорость ходьбы и бега игрока. Без флагов сообщает текущую.',
    args: [PLAYER_ARGUMENT, { name: 'МНОЖИТЕЛЬ', optional: true, help: 'Краткая форма --set' }],
    flags: {
      set: { short: 's', value: speedMultiplier, help: `Множитель ${SPEED_RANGE}` },
      reset: { help: 'Обычная скорость' },
    },
    conflicts: [['set', 'reset']],
    examples: ['/speed', '/speed 2', '/speed @"Гость 2" 0.5', '/speed @Гость --reset'],
    build({ args, flags }) {
      const split = splitTarget(args);
      if (typeof split === 'string') return split;
      if (split.rest.length > 1) return `Лишний аргумент «${split.rest[1]}».`;
      let positional: number | undefined;
      if (split.rest[0] !== undefined) {
        if (flags.has('set')) return 'Множитель скорости указан дважды.';
        if (flags.get('reset')) return 'Флаги --set и --reset нельзя указывать вместе.';
        positional = speedMultiplier.parse(split.rest[0]);
        if (positional === undefined)
          return split.target === undefined
            ? `Неверное значение «${split.rest[0]}». Ожидается ${speedMultiplier.name}; игрока указывают через @: @Имя.`
            : `Неверное значение «${split.rest[0]}». Ожидается ${speedMultiplier.name}.`;
      }
      const percent =
        positional ??
        (flags.has('set')
          ? (flags.get('set') as number)
          : flags.get('reset')
            ? PLAYER_SPEED_PERCENT.normal
            : undefined);
      return {
        kind: 'speed',
        ...(split.target === undefined ? {} : { target: split.target }),
        ...(percent === undefined ? {} : { percent }),
      };
    },
  },
  {
    name: 'give',
    aliases: ['giveme'],
    category: 'Предметы',
    access: 'admin',
    summary: 'Выдать предмет себе или игроку из каталога.',
    args: [
      PLAYER_ARGUMENT,
      { name: 'тип', optional: true, help: 'ID типа предмета', complete: 'itemTypes' },
    ],
    flags: { list: { short: 'l', help: 'Показать ID доступных типов' } },
    examples: ['/give wooden-crate', '/give @Гость wooden-crate', '/give --list'],
    build({ args, flags }) {
      const split = splitTarget(args);
      if (typeof split === 'string') return split;
      if (split.rest.length > 1) return `Лишний аргумент «${split.rest[1]}».`;
      const [typeId] = split.rest;
      if (flags.get('list'))
        return typeId || split.target !== undefined
          ? 'С --list аргументы не указывают.'
          : { kind: 'giveList' };
      if (!typeId) return 'Не указан тип предмета.';
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(typeId)) return `Неверный тип предмета «${typeId}».`;
      return {
        kind: 'give',
        typeId,
        ...(split.target === undefined ? {} : { target: split.target }),
      };
    },
  },
  {
    name: 'place',
    aliases: ['motherlode'],
    category: 'Строительство',
    access: 'admin',
    summary: 'Каталог моделей для размещения в мире.',
    examples: ['/place'],
    build: () => ({ kind: 'staticPlacement' }),
  },
  {
    name: 'remove',
    aliases: ['vilievna'],
    category: 'Строительство',
    access: 'admin',
    summary: 'Выбрать и удалить статичный объект.',
    examples: ['/remove'],
    build: () => ({ kind: 'staticRemoval' }),
  },
  {
    name: 'help',
    aliases: ['h'],
    category: 'Справка',
    access: 'player',
    summary: 'Список доступных команд.',
    args: [
      { name: 'команда', optional: true, help: 'Показать одну команду', complete: 'commands' },
    ],
    examples: ['/help', '/help time', '/time --help'],
    build({ args }) {
      return { kind: 'help', focus: args[0]?.replace(/^\//, '').toLowerCase() };
    },
  },
];

const LEVELS: Record<CommandAccess, number> = { player: 0, admin: 1 };
const allowed = (command: ChatCommandDefinition, access: CommandAccess) =>
  LEVELS[command.access] <= LEVELS[access];
const byName = new Map(
  COMMANDS.flatMap((command) =>
    [command.name, ...(command.aliases ?? [])].map((name) => [name, command] as const),
  ),
);

function findCommand(name: string, access: CommandAccess) {
  const command = byName.get(name.toLowerCase());
  return command && allowed(command, access) ? command : undefined;
}

function unknown(name: string, access: CommandAccess): ChatCommand {
  const known = byName.get(name.toLowerCase());
  const names = COMMANDS.filter(
    (command) => allowed(command, access) && command.name !== 'help',
  ).flatMap((command) => [command.name, ...(command.aliases ?? [])]);
  const suggestion = names
    .map((candidate) => ({ candidate, distance: editDistance(name.toLowerCase(), candidate) }))
    .filter(({ distance }) => distance <= 2)
    .sort((a, b) => a.distance - b.distance)[0]?.candidate;
  return {
    kind: 'invalid',
    code: 'UNKNOWN_COMMAND',
    message: `Неизвестная команда.${suggestion ? ` Возможно, /${suggestion}?` : ''}${names.length ? ' Список: /help.' : ''}`,
    ...(known ? { forbidden: true } : {}),
  };
}

/**
 * Текст со `/` всегда остаётся приватным, включая неизвестные и неверные команды. Команды выше прав
 * отправителя неотличимы от несуществующих.
 */
export function parseChatCommand(text: string, access: CommandAccess): ChatCommand | undefined {
  if (!text.startsWith('/')) return;
  let tokens: string[];
  try {
    tokens = tokenize(text.slice(1));
  } catch (error) {
    if (error instanceof CommandLineError)
      return { kind: 'invalid', code: 'INVALID_INPUT', message: error.message };
    throw error;
  }
  const [name = '', ...rest] = tokens;
  const command = findCommand(name, access);
  if (!command) return unknown(name, access);
  try {
    const parsed = parseCommandLine(command, rest);
    if (!parsed) return { kind: 'help', focus: command.name };
    const result = command.build(parsed);
    if (typeof result === 'string') throw new CommandLineError(result);
    if (result.kind === 'help' && result.focus !== undefined) {
      const focus = findCommand(result.focus, access);
      if (!focus) return unknown(result.focus, access);
      return { kind: 'help', focus: focus.name };
    }
    return result;
  } catch (error) {
    if (!(error instanceof CommandLineError)) throw error;
    return {
      kind: 'invalid',
      code: 'INVALID_INPUT',
      message: `${error.message} Справка: /${command.name} --help.`,
    };
  }
}

export interface CommandHelpContext {
  itemTypes?: readonly string[];
}

/**
 * Список доступных команд с вариантами значений аргументов. Всегда возвращает хотя бы `/help`,
 * поэтому подходит для автодополнения и для обычного игрока.
 */
export function commandCatalog(
  access: CommandAccess,
  context: CommandHelpContext = {},
): CommandHelpEffect {
  const commands = COMMANDS.filter((command) => allowed(command, access));
  const choices: Record<string, readonly string[]> = {
    commands: commands.map((command) => command.name),
    ...(context.itemTypes?.length
      ? { itemTypes: context.itemTypes.slice(0, COMMAND_CHOICES_MAX) }
      : {}),
  };
  return {
    kind: 'commandHelp',
    commands: commands.map((command) => commandHelpEntry(command, choices)),
  };
}

/** Справка по командам, доступным с этими правами; `/help` в счёт не идёт. */
export function commandHelp(
  access: CommandAccess,
  focus?: string,
  context: CommandHelpContext = {},
): CommandHelpEffect | undefined {
  const catalog = commandCatalog(access, context);
  if (!catalog.commands.some((command) => command.name !== 'help')) return;
  return { ...catalog, ...(focus ? { focus } : {}) };
}

export function giveFailureMessage(code: ItemError | undefined): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'Сессия истекла. Войдите через Telegram снова.';
    case 'ADMIN_REQUIRED':
      return 'Нет доступа к этой команде.';
    case 'RATE_LIMITED':
      return `Получать предметы можно раз в ${ITEM_GIVE_COOLDOWN_MS / 1000} секунды.`;
    case 'STALE_WORLD':
      return 'Мир был перезапущен. Войдите снова.';
    case 'WORLD_NOT_READY':
    case 'STORAGE_UNAVAILABLE':
      return 'Выдача предметов временно недоступна. Дождитесь восстановления мира.';
    default:
      return 'Не удалось выдать предмет.';
  }
}
