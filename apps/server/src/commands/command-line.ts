import type { CommandHelpEntry } from '@su/contracts';

/**
 * Разбор строки команды в духе CLI: позиционные аргументы и флаги `--name`, `--name value`,
 * `--name=value`, `-n value`, `--no-name`. Кавычки `"…"` объединяют слова с пробелами, в том числе
 * после `@`: `@"Гость 2"`. Ошибки — готовый текст для игрока.
 */

export type CommandAccess = 'player' | 'admin';

export interface FlagSpec {
  short?: string;
  /** Есть у флагов со значением; у переключателей отсутствует. */
  value?: { name: string; parse: (raw: string) => unknown };
  /** Разрешает `--no-<имя>`. */
  negatable?: boolean;
  help: string;
}
export interface ArgumentSpec {
  name: string;
  optional?: boolean;
  help: string;
}
export interface ParsedCommandLine {
  args: string[];
  /** Переключатель — `true`/`false`, флаг со значением — результат `parse`. */
  flags: Map<string, unknown>;
}
export interface CommandSpec {
  name: string;
  aliases?: string[];
  category: string;
  access: CommandAccess;
  summary: string;
  args?: ArgumentSpec[];
  flags?: Record<string, FlagSpec>;
  /** Взаимоисключающие флаги. */
  conflicts?: string[][];
  examples: string[];
}

export class CommandLineError extends Error {}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) throw new CommandLineError('Не закрыта кавычка.');
  if (started) tokens.push(current);
  return tokens;
}

const HELP_FLAGS = new Set(['--help', '-h']);

/** `undefined` — запрошена справка (`--help` или `-h`). */
export function parseCommandLine(
  spec: CommandSpec,
  tokens: readonly string[],
): ParsedCommandLine | undefined {
  if (tokens.some((token) => HELP_FLAGS.has(token))) return;
  const flags = spec.flags ?? {};
  const byShort = new Map(
    Object.entries(flags)
      .filter(([, flag]) => flag.short)
      .map(([name, flag]) => [flag.short!, name]),
  );
  const parsed: ParsedCommandLine = { args: [], flags: new Map() };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith('-') || token === '-' || /^-\d/.test(token)) {
      parsed.args.push(token);
      continue;
    }
    let name: string;
    let inline: string | undefined;
    let negated = false;
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      name = equals < 0 ? body : body.slice(0, equals);
      inline = equals < 0 ? undefined : body.slice(equals + 1);
      if (!Object.hasOwn(flags, name) && name.startsWith('no-')) {
        const positive = name.slice(3);
        if (Object.hasOwn(flags, positive) && flags[positive].negatable) {
          name = positive;
          negated = true;
        }
      }
    } else {
      const short = token.slice(1);
      name = byShort.get(short) ?? '';
      if (!name) throw new CommandLineError(`Неизвестный флаг ${token}.`);
    }
    if (!Object.hasOwn(flags, name)) throw new CommandLineError(`Неизвестный флаг ${token}.`);
    if (parsed.flags.has(name)) throw new CommandLineError(`Флаг --${name} указан дважды.`);
    const flag = flags[name];
    if (!flag.value) {
      if (inline !== undefined) throw new CommandLineError(`Флаг --${name} не принимает значение.`);
      parsed.flags.set(name, !negated);
      continue;
    }
    if (negated) throw new CommandLineError(`Неизвестный флаг ${token}.`);
    let raw = inline;
    if (raw === undefined) {
      const next = tokens[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        raw = next;
        index++;
      }
    }
    if (raw === undefined || raw === '')
      throw new CommandLineError(`Флагу --${name} нужно значение ${flag.value.name}.`);
    const value = flag.value.parse(raw);
    if (value === undefined)
      throw new CommandLineError(
        `Неверное значение --${name}: «${raw}». Ожидается ${flag.value.name}.`,
      );
    parsed.flags.set(name, value);
  }
  const specArgs = spec.args ?? [];
  if (parsed.args.length > specArgs.length)
    throw new CommandLineError(
      specArgs.length
        ? `Лишний аргумент «${parsed.args[specArgs.length]}».`
        : `Команда не принимает аргументы: «${parsed.args[0]}».`,
    );
  const missing = specArgs.find((arg, index) => !arg.optional && parsed.args[index] === undefined);
  if (missing) throw new CommandLineError(`Не указан аргумент <${missing.name}>.`);
  for (const group of spec.conflicts ?? []) {
    const present = group.filter((name) => parsed.flags.has(name));
    if (present.length > 1)
      throw new CommandLineError(
        `Флаги ${present.map((name) => `--${name}`).join(' и ')} нельзя указывать вместе.`,
      );
  }
  return parsed;
}

/** Строка формата: `time [--set ЧЧ[:ММ]] [--stop] …`. */
export function commandUsage(spec: CommandSpec): string {
  const parts = [spec.name];
  for (const arg of spec.args ?? []) parts.push(arg.optional ? `[<${arg.name}>]` : `<${arg.name}>`);
  for (const [name, flag] of Object.entries(spec.flags ?? {}))
    parts.push(
      `[--${flag.negatable ? `[no-]` : ''}${name}${flag.value ? ` ${flag.value.name}` : ''}]`,
    );
  return parts.join(' ');
}

export function commandHelpEntry(spec: CommandSpec): CommandHelpEntry {
  return {
    name: spec.name,
    aliases: [...(spec.aliases ?? [])],
    category: spec.category,
    summary: spec.summary,
    usage: commandUsage(spec),
    args: (spec.args ?? []).map((arg) => ({
      name: arg.name,
      ...(arg.optional ? { optional: true } : {}),
      help: arg.help,
    })),
    flags: Object.entries(spec.flags ?? {}).map(([name, flag]) => ({
      name,
      ...(flag.short ? { short: flag.short } : {}),
      ...(flag.value ? { value: flag.value.name } : {}),
      ...(flag.negatable ? { negatable: true } : {}),
      help: flag.help,
    })),
    examples: [...spec.examples],
  };
}

/** Расстояние Левенштейна для подсказки «Возможно, /time?». */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = next;
    }
  }
  return row[b.length];
}
