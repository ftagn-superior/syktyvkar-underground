import type { CommandHelpEntry, CommandHelpFlag } from '@su/contracts';

/**
 * Автодополнение консольных команд в поле чата. Список команд приходит с сервера уже
 * отфильтрованным по правам, поэтому здесь нет ни одного имени команды: модуль только сопоставляет
 * набранный текст с присланной справкой.
 */
export interface CompletionCandidate {
  /** Текст, которым заменяется набираемое слово; пробел в конце — слово закончено. */
  insert: string;
  label: string;
  help: string;
}
export interface Completion {
  /** Границы заменяемого слова в исходном тексте. */
  start: number;
  end: number;
  candidates: CompletionCandidate[];
  /** Что ожидается на этом месте, когда подставить нечего: например, значение флага. */
  hint?: string;
}

interface Word {
  raw: string;
  text: string;
  start: number;
  end: number;
}

/** Слова до курсора с позициями в исходном тексте; кавычки объединяют слова с пробелами. */
function splitWords(text: string, baseOffset: number): { tokens: Word[]; current: Word } {
  const tokens: Word[] = [];
  let raw = '';
  let unquoted = '';
  let start = -1;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!quoted && /\s/.test(char)) {
      if (start >= 0) {
        tokens.push({ raw, text: unquoted, start: baseOffset + start, end: baseOffset + index });
        raw = '';
        unquoted = '';
        start = -1;
      }
      continue;
    }
    if (start < 0) start = index;
    raw += char;
    if (char === '"') quoted = !quoted;
    else unquoted += char;
  }
  const end = baseOffset + text.length;
  const current: Word =
    start >= 0
      ? { raw, text: unquoted, start: baseOffset + start, end }
      : { raw: '', text: '', start: end, end };
  return { tokens, current };
}

function matchFlagToken(command: CommandHelpEntry, token: string): CommandHelpFlag | undefined {
  if (token.startsWith('--')) {
    const body = token.slice(2);
    const equals = body.indexOf('=');
    const name = equals < 0 ? body : body.slice(0, equals);
    const direct = command.flags.find((flag) => flag.name === name);
    if (direct) return direct;
    if (name.startsWith('no-'))
      return command.flags.find((flag) => flag.negatable && flag.name === name.slice(3));
    return;
  }
  if (token.startsWith('-') && token.length === 2 && !/^-\d/.test(token))
    return command.flags.find((flag) => flag.short === token[1]);
}

function flagLabel(flag: CommandHelpFlag): string {
  return `--${flag.name}${flag.value ? ` ${flag.value}` : ''}${flag.short ? `, -${flag.short}` : ''}`;
}

function formatPlayerInsert(name: string): string {
  return /\s/.test(name) ? `@"${name}" ` : `@${name} `;
}

function filterPrefixOrIncludes(
  items: readonly string[],
  query: string,
  lowerRu = false,
): string[] {
  const norm = (value: string) =>
    lowerRu ? value.normalize('NFC').toLocaleLowerCase('ru') : value.toLowerCase();
  const wanted = norm(query);
  const prefix = items.filter((item) => norm(item).startsWith(wanted));
  if (prefix.length || !wanted) return prefix;
  return items.filter((item) => norm(item).includes(wanted));
}

function flagCandidates(
  command: CommandHelpEntry,
  prefix: string,
  blocked: ReadonlySet<string>,
): CompletionCandidate[] {
  const available = command.flags.filter((flag) => !blocked.has(flag.name));
  if (prefix.length === 2 && prefix.startsWith('-') && !prefix.startsWith('--')) {
    const shortMatch = available.find((flag) => flag.short === prefix[1]);
    return shortMatch
      ? [{ insert: `-${shortMatch.short} `, label: flagLabel(shortMatch), help: shortMatch.help }]
      : [];
  }
  const positive: CompletionCandidate[] = [];
  const negated: CompletionCandidate[] = [];
  for (const flag of available) {
    const long = `--${flag.name}`;
    if (long.startsWith(prefix))
      positive.push({ insert: `${long} `, label: flagLabel(flag), help: flag.help });
    if (flag.negatable) {
      const neg = `--no-${flag.name}`;
      if (neg.startsWith(prefix))
        negated.push({
          insert: `${neg} `,
          label: neg,
          help: `Выключить: ${flag.help.toLowerCase()}`,
        });
    }
  }
  return [...positive, ...negated];
}

export function completeCommand(
  text: string,
  cursor: number,
  commands: readonly CommandHelpEntry[],
  players: readonly string[] = [],
): Completion | undefined {
  const clamped = Math.max(0, Math.min(cursor, text.length));
  const beforeCursor = text.slice(0, clamped);
  const lead = beforeCursor.length - beforeCursor.trimStart().length;
  if (beforeCursor[lead] !== '/' || clamped <= lead) return;

  const { tokens, current } = splitWords(beforeCursor.slice(lead + 1), lead + 1);
  if (tokens.length === 0) {
    const prefix = current.text.toLowerCase();
    const canonical = commands
      .filter((command) => command.name.toLowerCase().startsWith(prefix))
      .map((command) => ({
        insert: `${command.name} `,
        label: `/${command.name}`,
        help: command.summary,
      }));
    if (canonical.length) return { start: current.start, end: current.end, candidates: canonical };
    // Синонимы не засоряют подсказки, пока подходит хотя бы одно основное имя.
    const aliases: CompletionCandidate[] = [];
    for (const command of commands) {
      for (const alias of command.aliases) {
        if (alias.toLowerCase().startsWith(prefix))
          aliases.push({
            insert: `${alias} `,
            label: `/${alias}`,
            help: `${command.summary} (синоним /${command.name})`,
          });
      }
    }
    return aliases.length
      ? { start: current.start, end: current.end, candidates: aliases }
      : undefined;
  }

  const commandName = tokens[0].text.toLowerCase();
  const command = commands.find(
    (entry) =>
      entry.name.toLowerCase() === commandName ||
      entry.aliases.some((alias) => alias.toLowerCase() === commandName),
  );
  if (!command) return;

  const prev = tokens.slice(1);
  const usedFlags = new Set<string>();
  const positional: string[] = [];
  let expectValueFor: CommandHelpFlag | undefined;
  for (let index = 0; index < prev.length; index++) {
    const token = prev[index].text;
    const flag = matchFlagToken(command, token);
    if (flag) {
      usedFlags.add(flag.name);
      if (flag.value && !token.includes('=')) {
        if (index + 1 < prev.length) index++;
        else expectValueFor = flag;
      }
    } else {
      positional.push(token);
    }
  }
  if (expectValueFor) {
    return {
      start: current.start,
      end: current.end,
      candidates: [],
      hint: `${expectValueFor.value} — ${expectValueFor.help}`,
    };
  }
  if (current.raw.startsWith('--') && current.raw.includes('=')) {
    const inlineFlag = matchFlagToken(command, current.raw);
    if (inlineFlag?.value)
      return {
        start: current.start,
        end: current.end,
        candidates: [],
        hint: `${inlineFlag.value} — ${inlineFlag.help}`,
      };
    return;
  }

  // Позиционная краткая форма (`/time 18:30`, `/speed 2`) занимает `--set` и его конфликты.
  if (positional.some((arg) => !arg.startsWith('@')) && command.flags.some((f) => f.name === 'set'))
    usedFlags.add('set');

  const blockedFlags = new Set(usedFlags);
  // Флаг `--list` не сочетается с позиционными аргументами (`/give --list`).
  if (positional.length > 0 && command.flags.some((f) => f.name === 'list'))
    blockedFlags.add('list');
  for (const group of command.conflicts)
    if (group.some((name) => usedFlags.has(name))) for (const name of group) blockedFlags.add(name);

  if (current.raw.startsWith('-')) {
    const candidates = flagCandidates(command, current.raw, blockedFlags);
    return candidates.length ? { start: current.start, end: current.end, candidates } : undefined;
  }

  const listOnly = usedFlags.has('list');
  const shorthandBlocked = command.flags.some((f) => f.name === 'set') && blockedFlags.has('set');
  const hasPlayer = positional.some((arg) => arg.startsWith('@'));
  const playerArg = command.args.find((arg) => arg.player);
  const nonPlayerArgs = command.args.filter((arg) => !arg.player);
  const nonPlayerCount = positional.filter((arg) => !arg.startsWith('@')).length;
  const nextArg = nonPlayerArgs[nonPlayerCount];
  const allowPlayerArg = !listOnly && !!playerArg && !hasPlayer;
  const allowNonPlayerArg = !listOnly && !shorthandBlocked;
  const uniquePlayers = [...new Set(players)];

  if (current.raw.startsWith('@')) {
    if (!allowPlayerArg) return;
    const matches = filterPrefixOrIncludes(uniquePlayers, current.text.slice(1), true);
    const candidates = matches.map((name) => ({
      insert: formatPlayerInsert(name),
      label: `@${name}`,
      help: 'Игрок в сети',
    }));
    return candidates.length ? { start: current.start, end: current.end, candidates } : undefined;
  }

  if (current.raw !== '' && allowNonPlayerArg && nextArg?.choices?.length) {
    const matches = filterPrefixOrIncludes(nextArg.choices, current.text);
    const candidates = matches.map((choice) => ({
      insert: `${choice} `,
      label: choice,
      help: nextArg.help,
    }));
    return candidates.length ? { start: current.start, end: current.end, candidates } : undefined;
  }

  if (current.raw === '') {
    const candidates: CompletionCandidate[] = [];
    if (allowNonPlayerArg && nextArg?.choices?.length) {
      for (const choice of nextArg.choices)
        candidates.push({ insert: `${choice} `, label: choice, help: nextArg.help });
    }
    if (allowPlayerArg) {
      for (const name of uniquePlayers)
        candidates.push({
          insert: formatPlayerInsert(name),
          label: `@${name}`,
          help: 'Игрок в сети',
        });
    }
    candidates.push(...flagCandidates(command, '--', blockedFlags));
    if (candidates.length) return { start: current.start, end: current.end, candidates };
    if (allowNonPlayerArg && nextArg)
      return {
        start: current.start,
        end: current.end,
        candidates: [],
        hint: `${nextArg.name} — ${nextArg.help}`,
      };
  }

  return undefined;
}
