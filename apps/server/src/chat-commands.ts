import { ITEM_GIVE_COOLDOWN_MS, type ItemError } from '@su/contracts';

export type ChatCommand =
  | { kind: 'give'; typeId: string }
  | { kind: 'staticPlacement' }
  | { kind: 'invalid'; code: 'INVALID_INPUT' | 'UNKNOWN_COMMAND'; message: string };

/** Slash-prefixed input is always private, including unknown or malformed commands. */
export function parseChatCommand(text: string): ChatCommand | undefined {
  if (!text.startsWith('/')) return;
  const [name, typeId, ...extra] = text.split(' ');
  if (name === '/motherlode')
    return typeId || extra.length
      ? { kind: 'invalid', code: 'INVALID_INPUT', message: 'Формат команды: /motherlode.' }
      : { kind: 'staticPlacement' };
  if (name !== '/giveme')
    return { kind: 'invalid', code: 'UNKNOWN_COMMAND', message: 'Неизвестная команда.' };
  if (!typeId || !/^[a-zA-Z0-9_-]{1,64}$/.test(typeId) || extra.length)
    return {
      kind: 'invalid',
      code: 'INVALID_INPUT',
      message: 'Формат команды: /giveme <type-id>.',
    };
  return { kind: 'give', typeId };
}
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
