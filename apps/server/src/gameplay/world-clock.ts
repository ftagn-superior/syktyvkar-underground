import {
  applyDayClockAction,
  dayClockHour,
  formatGameHour,
  type ActionResult,
  type DayClock,
  type DayClockAction,
} from '@su/contracts';

const TIME_COMMAND_COOLDOWN_MS = 1000;

interface ReplicatedDayClock {
  dayOffsetMs: number;
  dayFrozenHour: number;
}

/** One clock per room. Replication is its source of truth; restarting restores wall time. */
export class WorldClock {
  private changeAvailableAt = 0;

  constructor(private readonly state: ReplicatedDayClock) {}

  /**
   * Admission and duplicate requests are handled by the room's shared action ledger. Several
   * changes from one command apply together under a single cooldown; none means a read-only query.
   */
  command(changes: readonly DayClockAction[], now: number): Omit<ActionResult, 'requestId'> {
    let clock: DayClock = {
      offsetMs: this.state.dayOffsetMs,
      frozenHour: this.state.dayFrozenHour,
    };
    const changed = changes.length > 0;
    if (changed) {
      // A time change refreshes shadows for everyone, so the cooldown is room-wide.
      if (now < this.changeAvailableAt)
        return {
          ok: false,
          code: 'RATE_LIMITED',
          message: 'Время меняли только что. Повторите через секунду.',
          retryAfterMs: this.changeAvailableAt - now,
        };
      this.changeAvailableAt = now + TIME_COMMAND_COOLDOWN_MS;
      for (const change of changes) clock = applyDayClockAction(clock, change, now);
      this.state.dayOffsetMs = clock.offsetMs;
      this.state.dayFrozenHour = clock.frozenHour;
    }
    const hour = formatGameHour(dayClockHour(clock, now));
    return {
      ok: true,
      // Read-only /time must not acquire the ordinary chat cooldown on the client.
      retryAfterMs: changed ? TIME_COMMAND_COOLDOWN_MS : 0,
      message: changes.some((change) => change.kind === 'reset')
        ? `Часы идут по общему времени: ${hour}.`
        : clock.frozenHour >= 0
          ? `Время остановлено: ${hour}.`
          : `Время идёт: ${hour}.`,
    };
  }
}
