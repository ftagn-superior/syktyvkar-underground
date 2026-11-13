import { STATIC_PLACEMENT_COOLDOWN_MS, type StaticPlacementError } from '@su/contracts';

export const messages: Record<string, string> = {
  STORAGE_UNAVAILABLE:
    'Сохранение временно недоступно. Мир приостановлен до восстановления связи с БД.',
  ITEM_UNAVAILABLE: 'Предмет уже перемещён. Инвентарь обновлён.',
  OUT_OF_REACH: 'Подойдите ближе: дальность взаимодействия — 3 метра.',
  BLOCKED: 'Здесь есть препятствие или место уже занято.',
  NO_SUPPORT: 'Для предмета нужна опора.',
  OUT_OF_BOUNDS: 'Предмет должен целиком находиться в границах мира.',
  INCOMPATIBLE_STACK: 'Эти стопки нельзя объединить или ячейка уже заполнена.',
  LAYOUT_UPDATING: 'Обновляется окружение. Дождитесь загрузки.',
  LAYOUT_CHANGED: 'Раскладка изменилась. Выберите место и подтвердите заново.',
  CONTENT_LIMIT: 'Достигнут лимит статичных объектов.',
  OPERATION_CONFLICT: 'Идентификатор операции уже использован.',
  WORLD_FULL: 'На полигоне уже 8 игроков. Попробуйте войти чуть позже.',
  WORLD_NOT_READY: 'Сервер ещё готовит мир. Попробуйте снова через несколько секунд.',
  VERSION_MISMATCH: 'Версия мира изменилась. Перезагрузите страницу.',
  PREPARE_TIMEOUT: 'Подготовка заняла слишком много времени. Попробуйте войти снова.',
  SPAWN_UNAVAILABLE: 'Все точки старта заняты. Освободите место и попробуйте снова.',
  RATE_LIMITED: 'Возврат на старт доступен раз в 3 секунды.',
  STALE_WORLD: 'Мир был перезапущен. Войдите снова.',
  INVALID_INPUT: 'Сервер отклонил команду. Состояние восстановлено.',
  INVALID_SKIN: 'Эта внешность недоступна. Выберите вариант из каталога.',
  ANIMATION_NOT_ALLOWED: 'Дождитесь опоры; для движений всем телом остановитесь.',
  ALREADY_PROCESSED: 'Этот запрос уже обработан.',
  PLAN_REPLACED: 'Готовим другую безопасную точку.',
  AUTH_REQUIRED: 'Авторизация истекла. Обновите страницу и войдите через Telegram снова.',
  ACCOUNT_CHANGED: 'Аккаунт изменился в другой вкладке. Обновите страницу перед входом.',
  ACCOUNT_IN_USE:
    'Этот аккаунт уже находится в игре. Покиньте мир в другой вкладке или дождитесь завершения переподключения.',
  ACCOUNTS_UNAVAILABLE: 'Хранилище аккаунтов временно недоступно. Повторите вход позже.',
};
export const staticPlacementMessages: Partial<Record<StaticPlacementError, string>> = {
  RATE_LIMITED: `Размещать объекты можно раз в ${STATIC_PLACEMENT_COOLDOWN_MS / 1000} секунды.`,
  AUTH_REQUIRED: 'Чтобы размещать объекты, войдите через Telegram.',
  COMMAND_DISABLED: 'Размещение объектов недоступно в этом мире.',
  OUT_OF_BOUNDS: 'Объект должен целиком находиться в границах мира.',
  CATALOG_CHANGED: 'Каталог обновлён. Выберите модель и подтвердите размещение заново.',
  ASSET_NOT_ALLOWED: 'Эта модель больше недоступна для размещения. Выберите другую.',
};
export function readableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = Object.keys(messages).find((key) => text.includes(key));
  if (code) return messages[code];
  if (/room.*(?:full|locked)|maximum.*clients|seat.*full/i.test(text)) return messages.WORLD_FULL;
  if (/fetch|network|connect|ECONN|Failed|timeout|aborted/i.test(text))
    return 'Не удалось связаться с сервером. Проверьте, что локальный сервер запущен, и повторите вход.';
  return 'Не удалось подготовить полигон. Перезагрузите страницу или проверьте консоль сервера.';
}
