import { describe, expect, it } from 'vitest';
import {
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
});
