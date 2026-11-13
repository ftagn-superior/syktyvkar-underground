import { describe, expect, it } from 'vitest';
import { sunPosition } from '../rendering/environment/day-cycle';
import { autoTheme, resolveTheme, THEME_HYSTERESIS } from './ui-theme';

describe('UI theme by the game day', () => {
  it('is day at noon and night at midnight', () => {
    expect(autoTheme(sunPosition(13).y, 'night')).toBe('day');
    expect(autoTheme(sunPosition(1).y, 'day')).toBe('night');
  });
  it('holds the current theme inside the hysteresis band at the horizon', () => {
    const inside = THEME_HYSTERESIS / 2;
    expect(autoTheme(inside, 'night')).toBe('night');
    expect(autoTheme(-inside, 'day')).toBe('day');
    expect(autoTheme(THEME_HYSTERESIS * 2, 'night')).toBe('day');
    expect(autoTheme(-THEME_HYSTERESIS * 2, 'day')).toBe('night');
  });
  it('flips once while the sun crosses the horizon', () => {
    let theme: 'day' | 'night' = 'day';
    let flips = 0;
    for (let hour = 12; hour < 36; hour += 0.01) {
      const next = autoTheme(sunPosition(hour % 24).y, theme);
      if (next !== theme) flips++;
      theme = next;
    }
    expect(flips).toBe(2);
  });
  it('lets a forced setting override the clock', () => {
    expect(resolveTheme('night', 1, 'day')).toBe('night');
    expect(resolveTheme('day', -1, 'night')).toBe('day');
    expect(resolveTheme('auto', -1, 'day')).toBe('night');
  });
});
