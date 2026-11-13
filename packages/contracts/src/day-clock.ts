/**
 * Игровые часы мира. Сутки длятся 24 реальные минуты и по умолчанию привязаны
 * к настенному времени, поэтому одинаковы у всех клиентов без обмена сообщениями.
 * Команда `/time` сдвигает или останавливает часы; сдвиг хранится в состоянии комнаты.
 */

/** One game day in real time. */
export const DAY_LENGTH_MS = 24 * 60 * 1000;

export interface DayClock {
  /** Сдвиг относительно настенного времени, 0..DAY_LENGTH_MS. */
  offsetMs: number;
  /** Час, на котором часы остановлены; отрицательное значение — часы идут. */
  frozenHour: number;
}
export const DEFAULT_DAY_CLOCK: DayClock = { offsetMs: 0, frozenHour: -1 };

export type DayClockAction = { kind: 'set'; hour: number } | { kind: 'stop' | 'start' | 'reset' };

/** Game hour (0..24) for a moment of wall-clock time; the same on every client. */
export function hourAt(epochMs: number): number {
  const phase = epochMs / DAY_LENGTH_MS;
  return (phase - Math.floor(phase)) * 24;
}

export function dayClockHour(clock: DayClock, epochMs: number): number {
  return clock.frozenHour >= 0 ? clock.frozenHour % 24 : hourAt(epochMs + clock.offsetMs);
}

/** Сдвиг, при котором идущие часы показывают `hour` в момент `epochMs`. */
function offsetFor(hour: number, epochMs: number): number {
  const offset = Math.round(((hour - hourAt(epochMs)) / 24) * DAY_LENGTH_MS);
  return ((offset % DAY_LENGTH_MS) + DAY_LENGTH_MS) % DAY_LENGTH_MS;
}

export function applyDayClockAction(
  clock: DayClock,
  action: DayClockAction,
  epochMs: number,
): DayClock {
  const frozen = clock.frozenHour >= 0;
  switch (action.kind) {
    case 'set':
      // Остановленные часы остаются остановленными на новом часе.
      return frozen
        ? { offsetMs: clock.offsetMs, frozenHour: action.hour }
        : { offsetMs: offsetFor(action.hour, epochMs), frozenHour: -1 };
    case 'stop':
      return frozen
        ? clock
        : { offsetMs: clock.offsetMs, frozenHour: dayClockHour(clock, epochMs) };
    case 'start':
      // Часы продолжают идти с того часа, на котором стояли.
      return frozen ? { offsetMs: offsetFor(clock.frozenHour, epochMs), frozenHour: -1 } : clock;
    case 'reset':
      return DEFAULT_DAY_CLOCK;
  }
}

/** «ЧЧ:ММ» для ответа игроку. Сдвиг округлён до миллисекунды, поэтому минута берётся с допуском. */
export function formatGameHour(hour: number): string {
  const minutes = Math.floor((((hour % 24) + 24) % 24) * 60 + 1e-3) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
