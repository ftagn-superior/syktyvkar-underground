import { describe, expect, it } from 'vitest';
import {
  curveAt,
  darkness,
  lampLevel,
  litShare,
  nightLevels,
  LAMP_SCHEDULE,
} from './night-schedule';

const share = (hour: number, kind: 'window' | 'office' | 'shop' | 'sign') =>
  litShare(nightLevels(hour)[kind]);

describe('night light schedule', () => {
  it('interpolates closed daily curves smoothly across midnight', () => {
    const curve = [
      [22, 1],
      [2, 0],
    ] as const;
    expect(curveAt(curve, 22)).toBeCloseTo(1);
    expect(curveAt(curve, 0)).toBeCloseTo(0.5);
    expect(curveAt(curve, 2)).toBeCloseTo(0);
    expect(curveAt(curve, 12)).toBeCloseTo(0.5);
    expect(curveAt(curve, 24 + 22)).toBeCloseTo(1);
    expect(curveAt([[0, 0.3]], 7)).toBe(0.3);
  });

  it('lights a few windows at sunset, more as it gets dark and leaves a handful late at night', () => {
    expect(share(13, 'window')).toBe(0);
    const sunset = share(19, 'window');
    expect(sunset).toBeGreaterThan(0.05);
    expect(sunset).toBeLessThan(0.25);
    expect(share(20, 'window')).toBeGreaterThan(sunset);
    const peak = share(22, 'window');
    expect(peak).toBeGreaterThan(0.6);
    expect(share(0, 'window')).toBeLessThan(peak);
    expect(share(3, 'window')).toBeLessThan(0.1);
    expect(share(3, 'window')).toBeGreaterThan(0);
    // Утром перед рассветом часть жильцов встаёт.
    expect(share(7, 'window')).toBeGreaterThan(share(4.5, 'window'));
    expect(share(10, 'window')).toBe(0);
  });

  it('keeps stores and signs lit after the houses fall asleep', () => {
    for (const hour of [1, 3, 5]) {
      expect(share(hour, 'shop')).toBeGreaterThan(share(hour, 'window'));
      expect(share(hour, 'sign')).toBeGreaterThan(share(hour, 'shop'));
      expect(share(hour, 'sign')).toBeLessThan(1);
    }
    expect(share(20, 'shop')).toBe(1);
    expect(share(20, 'sign')).toBe(1);
    expect(share(14, 'sign')).toBe(0);
    // Учреждения пустеют к ночи сильнее жилых домов.
    expect(share(19, 'office')).toBeGreaterThan(0.5);
    expect(share(23.5, 'office')).toBeLessThan(0.1);
  });

  it('switches every street lamp on and off by the city schedule, with a short warm-up', () => {
    expect(lampLevel(12)).toBe(0);
    expect(lampLevel(LAMP_SCHEDULE.on - 0.01)).toBe(0);
    const warming = lampLevel(LAMP_SCHEDULE.on + LAMP_SCHEDULE.warmUp / 2);
    expect(warming).toBeGreaterThan(0);
    expect(warming).toBeLessThan(1);
    expect(lampLevel(LAMP_SCHEDULE.on + LAMP_SCHEDULE.warmUp)).toBe(1);
    expect(lampLevel(0)).toBe(1);
    expect(lampLevel(LAMP_SCHEDULE.off - 0.1)).toBe(1);
    expect(lampLevel(LAMP_SCHEDULE.off + 0.01)).toBe(0);
    expect(nightLevels(1).lamp.brightness).toBeGreaterThan(nightLevels(19).lamp.brightness);
  });

  it('dims all glow in daylight so it only reads at dusk and night', () => {
    expect(darkness(13)).toBe(0);
    expect(darkness(1)).toBe(1);
    expect(nightLevels(13).window.brightness).toBeLessThan(0.2);
    expect(nightLevels(23).window.brightness).toBe(1);
    for (let hour = 0; hour < 24; hour += 0.25) {
      const step = Math.abs(share(hour + 0.25, 'window') - share(hour, 'window'));
      expect(step, `${hour}`).toBeLessThan(0.12);
    }
  });
});
