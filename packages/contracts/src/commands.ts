/**
 * Справка по консольным командам чата. Сервер присылает её в ответ на `/help` уже отфильтрованной
 * по правам отправителя, поэтому в клиентской сборке списка команд нет.
 */
export interface CommandHelpFlag {
  /** Длинное имя без `--`. */
  name: string;
  /** Короткое имя без `-`. */
  short?: string;
  /** Название значения, например `ЧЧ[:ММ]`; флаг без значения — переключатель. */
  value?: string;
  /** Флаг можно выключить формой `--no-<имя>`. */
  negatable?: boolean;
  help: string;
}
export interface CommandHelpArgument {
  name: string;
  optional?: boolean;
  help: string;
  /** Значение — `@имя` игрока в сети; имена клиент берёт из своего списка игроков. */
  player?: boolean;
  /** Допустимые значения для автодополнения, например ID типов предметов. */
  choices?: string[];
}
export interface CommandHelpEntry {
  name: string;
  aliases: string[];
  category: string;
  summary: string;
  /** Строка формата без ведущего `/`, например `time [--set ЧЧ[:ММ]] [--stop | --start]`. */
  usage: string;
  args: CommandHelpArgument[];
  flags: CommandHelpFlag[];
  /** Группы взаимоисключающих флагов (длинные имена). */
  conflicts: string[][];
  examples: string[];
}
/** Максимум вариантов значения одного аргумента. */
export const COMMAND_CHOICES_MAX = 256;
export interface CommandHelpEffect {
  kind: 'commandHelp';
  commands: CommandHelpEntry[];
  /** Команда, справку по которой просили (`/help time`, `/time --help`). */
  focus?: string;
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const optionalText = (value: unknown, max: number) => value === undefined || text(value, max);

/** Ответ сервера проверяется так же строго, как остальные эффекты: лишнее отбрасывается. */
export function parseCommandHelpEffect(value: unknown): CommandHelpEffect | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'commandHelp' || !Array.isArray(v.commands) || v.commands.length > 64) return;
  const commands: CommandHelpEntry[] = [];
  for (const raw of v.commands as unknown[]) {
    if (!raw || typeof raw !== 'object') return;
    const c = raw as Record<string, unknown>;
    if (
      typeof c.name !== 'string' ||
      !NAME.test(c.name) ||
      !Array.isArray(c.aliases) ||
      c.aliases.length > 8 ||
      !c.aliases.every((alias) => typeof alias === 'string' && NAME.test(alias)) ||
      !text(c.category, 32) ||
      !text(c.summary, 160) ||
      !text(c.usage, 200) ||
      !Array.isArray(c.args) ||
      c.args.length > 8 ||
      !Array.isArray(c.flags) ||
      c.flags.length > 16 ||
      // Сервер до появления поля его не присылал: отсутствие равно пустому списку.
      !(c.conflicts === undefined || Array.isArray(c.conflicts)) ||
      (c.conflicts ?? []).length > 32 ||
      !(c.conflicts ?? []).every(
        (group) =>
          Array.isArray(group) &&
          group.length >= 2 &&
          group.length <= 16 &&
          group.every((name) => typeof name === 'string' && NAME.test(name)),
      ) ||
      !Array.isArray(c.examples) ||
      c.examples.length > 8 ||
      !c.examples.every((example) => text(example, 120))
    )
      return;
    const args: CommandHelpArgument[] = [];
    for (const a of c.args as unknown[]) {
      const arg = a as Record<string, unknown> | null;
      if (
        !arg ||
        !text(arg.name, 32) ||
        !text(arg.help, 160) ||
        !(arg.player === undefined || typeof arg.player === 'boolean') ||
        !(
          arg.choices === undefined ||
          (Array.isArray(arg.choices) &&
            arg.choices.length <= COMMAND_CHOICES_MAX &&
            arg.choices.every((choice) => text(choice, 64)))
        )
      )
        return;
      args.push({
        name: arg.name,
        ...(arg.optional === true ? { optional: true } : {}),
        help: arg.help,
        ...(arg.player === true ? { player: true } : {}),
        ...(arg.choices ? { choices: [...(arg.choices as string[])] } : {}),
      });
    }
    const flags: CommandHelpFlag[] = [];
    for (const f of c.flags as unknown[]) {
      const flag = f as Record<string, unknown> | null;
      if (
        !flag ||
        typeof flag.name !== 'string' ||
        !NAME.test(flag.name) ||
        !(
          flag.short === undefined ||
          (typeof flag.short === 'string' && /^[a-z]$/.test(flag.short))
        ) ||
        !optionalText(flag.value, 32) ||
        !text(flag.help, 160)
      )
        return;
      flags.push({
        name: flag.name,
        ...(flag.short ? { short: flag.short as string } : {}),
        ...(flag.value ? { value: flag.value as string } : {}),
        ...(flag.negatable === true ? { negatable: true } : {}),
        help: flag.help,
      });
    }
    commands.push({
      name: c.name,
      aliases: [...(c.aliases as string[])],
      category: c.category,
      summary: c.summary,
      usage: c.usage,
      args,
      flags,
      conflicts: ((c.conflicts ?? []) as string[][]).map((group) => [...group]),
      examples: [...(c.examples as string[])],
    });
  }
  if (v.focus !== undefined && !commands.some((command) => command.name === v.focus)) return;
  return {
    kind: 'commandHelp',
    commands,
    ...(typeof v.focus === 'string' ? { focus: v.focus } : {}),
  };
}
