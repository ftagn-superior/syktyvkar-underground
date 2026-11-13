import {
  ITEM_GIVE_COOLDOWN_MS,
  type DayClockAction,
  type ItemError,
  type WeatherAction,
} from '@su/contracts';

export type ChatCommand =
  | { kind: 'give'; typeId: string }
  /** Без `action` команда только сообщает текущее время. */
  | { kind: 'time'; action?: DayClockAction }
  /** Без `action` команда только сообщает текущую погоду. */
  | { kind: 'weather'; action?: WeatherAction }
  | { kind: 'staticPlacement' }
  | { kind: 'staticRemoval' }
  | { kind: 'invalid'; code: 'INVALID_INPUT' | 'UNKNOWN_COMMAND'; message: string };

const invalid = (message: string): ChatCommand => ({
  kind: 'invalid',
  code: 'INVALID_INPUT',
  message,
});

/** Slash-prefixed input is always private, including unknown or malformed commands. */
export function parseChatCommand(text: string): ChatCommand | undefined {
  if (!text.startsWith('/')) return;
  const [name, argument, ...extra] = text.split(' ');
  if (name === '/motherlode')
    return argument || extra.length
      ? invalid('Формат команды: /motherlode.')
      : { kind: 'staticPlacement' };
  if (name === '/vilievna')
    return argument || extra.length
      ? invalid('Формат команды: /vilievna.')
      : { kind: 'staticRemoval' };
  if (name === '/giveme') {
    if (!argument || !/^[a-zA-Z0-9_-]{1,64}$/.test(argument) || extra.length)
      return invalid('Формат команды: /giveme <type-id>.');
    return { kind: 'give', typeId: argument };
  }
  if (name === '/time') {
    if (extra.length) return invalid(TIME_FORMAT);
    if (!argument) return { kind: 'time' };
    if (argument === 'stop' || argument === 'start' || argument === 'reset')
      return { kind: 'time', action: { kind: argument } };
    const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(argument);
    const hours = Number(match?.[1]),
      minutes = Number(match?.[2] ?? 0);
    if (!match || hours > 23 || minutes > 59) return invalid(TIME_FORMAT);
    return { kind: 'time', action: { kind: 'set', hour: hours + minutes / 60 } };
  }
  if (name === '/weather') {
    if (!argument && !extra.length) return { kind: 'weather' };
    if (argument === 'reset' && !extra.length)
      return { kind: 'weather', action: { kind: 'reset' } };
    if (argument === 'clouds' && extra.length === 1) return clouds(extra[0]!);
    return invalid(WEATHER_FORMAT);
  }
  // Короткая форма `/weather clouds`.
  if (name === '/clouds') return extra.length ? invalid(WEATHER_FORMAT) : clouds(argument);
  return { kind: 'invalid', code: 'UNKNOWN_COMMAND', message: 'Неизвестная команда.' };
}
function clouds(state: string | undefined): ChatCommand {
  return state === 'on' || state === 'off'
    ? { kind: 'weather', action: { kind: 'clouds', enabled: state === 'on' } }
    : invalid(WEATHER_FORMAT);
}
const WEATHER_FORMAT = 'Формат команды: /weather [clouds on|off | reset] или /clouds on|off.';
const TIME_FORMAT = 'Формат команды: /time [ЧЧ[:ММ] | stop | start | reset].';

export function giveFailureMessage(code: ItemError | undefined): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'Чтобы получить предмет, войдите через Telegram.';
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
