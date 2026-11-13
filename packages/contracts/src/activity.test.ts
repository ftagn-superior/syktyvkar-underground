import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FLOOD_DECAY_MS,
  ACTIVITY_FLOOD_MAX_COOLDOWN_MS,
  COLD_FLOOD_HEAT,
  floodCooldown,
  isPlayerMoving,
  millisecondsToTicks,
  ticksToMilliseconds,
  WORLD_ACTIVITY_MOVE_DURATION_MS,
} from './activity.js';

describe('shared player activity timing', () => {
  it('ignores resting drift and detects diagonal movement consistently', () => {
    expect(isPlayerMoving({ x: 0, z: 0 })).toBe(false);
    expect(isPlayerMoving({ x: 0.08, z: 0 })).toBe(false);
    expect(isPlayerMoving({ x: -0.081, z: 0 })).toBe(true);
    expect(isPlayerMoving({ x: 0.06, z: 0.06 })).toBe(true);
  });

  it('does not finish cooldowns before the final simulation tick', () => {
    expect(millisecondsToTicks(WORLD_ACTIVITY_MOVE_DURATION_MS)).toBe(300);
    expect(millisecondsToTicks(1)).toBe(1);
    expect(millisecondsToTicks(1001)).toBe(61);
    expect(ticksToMilliseconds(1)).toBe(17);
    expect(ticksToMilliseconds(60)).toBe(1000);
    expect(ticksToMilliseconds(0)).toBe(0);
    expect(ticksToMilliseconds(-1)).toBe(0);
  });

  it('lets a short burst through at the base cooldown, then grows it for sustained spam', () => {
    let heat = COLD_FLOOD_HEAT;
    let now = 10_000;
    const cooldowns: number[] = [];
    for (let i = 0; i < 20; i++) {
      const next = floodCooldown(heat, now, 1000);
      heat = next.heat;
      cooldowns.push(next.cooldownMs);
      now += next.cooldownMs;
    }
    expect(cooldowns.slice(0, 5)).toEqual([1000, 1000, 1000, 1000, 1000]);
    for (let i = 1; i < cooldowns.length; i++)
      expect(cooldowns[i]).toBeGreaterThanOrEqual(cooldowns[i - 1]);
    // Sending as fast as allowed settles at about one action per decay period.
    expect(cooldowns.at(-1)).toBeGreaterThan(ACTIVITY_FLOOD_DECAY_MS * 0.8);
    expect(cooldowns.at(-1)).toBeLessThanOrEqual(ACTIVITY_FLOOD_DECAY_MS * 1.2);
    expect(floodCooldown(heat, now + 60_000, 1000).cooldownMs).toBe(1000);
  });

  it('caps the cooldown for a burst of accepted actions at the same moment', () => {
    let heat = COLD_FLOOD_HEAT;
    let cooldownMs = 0;
    for (let i = 0; i < 12; i++) ({ heat, cooldownMs } = floodCooldown(heat, 0, 1000));
    expect(cooldownMs).toBe(ACTIVITY_FLOOD_MAX_COOLDOWN_MS);
  });
});
