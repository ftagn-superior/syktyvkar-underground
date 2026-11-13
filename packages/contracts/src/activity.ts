import { TICK_RATE, type Vec3 } from './simulation.js';

/** Chat, reactions and animations expire this long after the author's first movement. */
export const WORLD_ACTIVITY_MOVE_DURATION_MS = 5000;

/** Ignore the controller's small resting drift when starting activity expiry. */
export function isPlayerMoving(velocity: Pick<Vec3, 'x' | 'z'>): boolean {
  return Math.hypot(velocity.x, velocity.z) > 0.08;
}

/** A duration must elapse completely before a server action becomes available. */
export function millisecondsToTicks(milliseconds: number): number {
  return Math.ceil((milliseconds * TICK_RATE) / 1000);
}

/** Whole milliseconds remaining for an action result; elapsed deadlines report zero. */
export function ticksToMilliseconds(ticks: number): number {
  return Math.max(0, Math.ceil((ticks * 1000) / TICK_RATE));
}

/**
 * Защита от флуда для чата, реакций и анимаций (у каждого вида своя). Каждое принятое действие
 * добавляет единицу «нагрева», который остывает на единицу за `ACTIVITY_FLOOD_DECAY_MS`. Первые
 * `ACTIVITY_FLOOD_FREE_BURST` быстрых действий идут с базовой паузой, дальше пауза удваивается на
 * каждую единицу сверх порога, но не дольше `ACTIVITY_FLOOD_MAX_COOLDOWN_MS`. При непрерывном
 * спаме пауза устанавливается около `ACTIVITY_FLOOD_DECAY_MS`.
 */
export const ACTIVITY_FLOOD_FREE_BURST = 4;
export const ACTIVITY_FLOOD_DECAY_MS = 4000;
export const ACTIVITY_FLOOD_MAX_COOLDOWN_MS = 30_000;

export interface FloodHeat {
  heat: number;
  atMs: number;
}
export const COLD_FLOOD_HEAT: FloodHeat = { heat: 0, atMs: 0 };

/** Pure rule for one accepted action: the new heat and the cooldown before the next one. */
export function floodCooldown(
  previous: FloodHeat,
  nowMs: number,
  baseMs: number,
): { heat: FloodHeat; cooldownMs: number } {
  const cooled = previous.heat - Math.max(0, nowMs - previous.atMs) / ACTIVITY_FLOOD_DECAY_MS;
  const heat = Math.max(0, cooled) + 1;
  const cooldownMs = Math.min(
    ACTIVITY_FLOOD_MAX_COOLDOWN_MS,
    Math.ceil(baseMs * 2 ** Math.max(0, heat - ACTIVITY_FLOOD_FREE_BURST)),
  );
  return { heat: { heat, atMs: nowMs }, cooldownMs };
}
