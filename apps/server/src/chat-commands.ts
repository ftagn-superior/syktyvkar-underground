import {
  ITEM_GIVE_COOLDOWN_MS,
  type DayClockAction,
  type ItemError,
  type WeatherAction,
  type WeatherPart,
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
    if (!argument) return extra.length ? invalid(WEATHER_FORMAT) : { kind: 'weather' };
    if ((argument === 'reset' || argument === 'clear') && !extra.length)
      return { kind: 'weather', action: { kind: argument } };
    if (extra.length > 1 || !isWeatherPart(argument)) return invalid(WEATHER_FORMAT);
    return weatherPart(argument, extra[0] ?? 'on');
  }
  // Короткая форма `/weather clouds on|off`.
  if (name === '/clouds')
    return argument && !extra.length ? weatherPart('clouds', argument) : invalid(WEATHER_FORMAT);
  return { kind: 'invalid', code: 'UNKNOWN_COMMAND', message: 'Неизвестная команда.' };
}
const WEATHER_PARTS: readonly WeatherPart[] = ['clouds', 'rain', 'snow', 'fog'];
const isWeatherPart = (value: string): value is WeatherPart =>
  (WEATHER_PARTS as readonly string[]).includes(value);
function weatherPart(part: WeatherPart, state: string): ChatCommand {
  return state === 'on' || state === 'off'
    ? { kind: 'weather', action: { kind: 'set', part, enabled: state === 'on' } }
    : invalid(WEATHER_FORMAT);
}
const WEATHER_FORMAT =
  'Формат команды: /weather [clouds | rain | snow | fog] [on | off], /weather clear или /weather reset.';
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
