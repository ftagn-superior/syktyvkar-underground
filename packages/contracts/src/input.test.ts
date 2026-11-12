import { describe, expect, it } from 'vitest';
import { normalizeInput, NEUTRAL_INPUT } from './index.js';

describe('optional world facing', () => {
  it('distinguishes absence from zero and ignores invalid orientation without losing movement', () => {
    expect(normalizeInput(NEUTRAL_INPUT)).not.toHaveProperty('facingYaw');
    expect(normalizeInput({ ...NEUTRAL_INPUT, facingYaw: 0 })?.facingYaw).toBe(0);
    for (const facingYaw of [NaN, Infinity, -Infinity, '0', null]) {
      expect(normalizeInput({ moveX: 1, moveZ: 0, facingYaw })).toEqual({
        moveX: 1,
        moveZ: 0,
        sprint: false,
      });
    }
  });
  it('normalizes axes and every finite angle into the canonical half-open range', () => {
    for (const facingYaw of [Math.PI, -Math.PI, 19, -19, 1e300, -1e300]) {
      const input = normalizeInput({ moveX: 1, moveZ: 1, facingYaw })!;
      expect(Math.hypot(input.moveX, input.moveZ)).toBeCloseTo(1);
      expect(input.facingYaw).toBeGreaterThanOrEqual(-Math.PI);
      expect(input.facingYaw).toBeLessThan(Math.PI);
    }
    expect(normalizeInput({ ...NEUTRAL_INPUT, facingYaw: Math.PI })?.facingYaw).toBe(-Math.PI);
  });
});
