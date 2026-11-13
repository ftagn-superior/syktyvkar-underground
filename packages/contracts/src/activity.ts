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
