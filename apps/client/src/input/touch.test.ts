import { describe, expect, it } from 'vitest';
import { stickAxes } from './touch';
import { screenMovement } from '../rendering/camera-controller';

describe('fixed touch stick', () => {
  it('keeps a radial dead zone and continuously remaps the remaining travel', () => {
    expect(stickAxes(0, 0, 44)).toEqual({ right: 0, forward: 0 });
    expect(stickAxes(3, 3, 44)).toEqual({ right: 0, forward: 0 });
    expect(stickAxes(22, 0, 44).right).toBeCloseTo((0.5 - 0.12) / 0.88);
    expect(stickAxes(44 * 0.120001, 0, 44).right).toBeLessThan(0.00001);
    expect(stickAxes(0, -44, 44)).toEqual({ right: 0, forward: 1 });
  });
  it('caps diagonals and travel outside the stick without changing direction', () => {
    for (const length of [44, 100, 1000]) {
      const axes = stickAxes(length, -length, 44);
      expect(Math.hypot(axes.right, axes.forward)).toBeCloseTo(1);
      expect(axes.right).toBeCloseTo(axes.forward);
    }
  });
  it('preserves analog speed and follows the actual camera angle', () => {
    const { right, forward } = stickAxes(0, -22, 44);
    for (const angle of [0, 0.39, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const input = screenMovement(right, forward, angle);
      expect(Math.hypot(input.moveX, input.moveZ)).toBeCloseTo(forward);
      expect(input.moveX).toBeCloseTo(-Math.cos(angle) * forward);
      expect(input.moveZ).toBeCloseTo(-Math.sin(angle) * forward);
    }
  });
});
