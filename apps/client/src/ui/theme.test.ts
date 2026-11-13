import { describe, expect, it } from 'vitest';
import { customColor, customControls, hexToHsl, hslToHex, normalizeHex } from './theme';

describe('player colour maths', () => {
  it('normalizes and tolerates bad input', () => {
    expect(normalizeHex('#6ee0c4')).toBe('#6EE0C4');
    expect(normalizeHex('nonsense')).toBe('#6EE0C4');
  });
  it('converts between HSL and hex', () => {
    expect(hslToHex(0, 100, 50)).toBe('#FF0000');
    expect(hslToHex(120, 100, 25)).toBe('#008000');
    const back = hexToHsl('#2E6FA8');
    expect(hslToHex(back.h, back.s, back.l)).toBe('#2E6FA8');
  });
  it('keeps custom colours inside the readable lightness band', () => {
    for (const tone of [0, 50, 100]) {
      const { l, s } = hexToHsl(customColor(200, tone));
      expect(l).toBeGreaterThanOrEqual(37.5);
      expect(l).toBeLessThanOrEqual(74.5);
      expect(Math.round(s)).toBeGreaterThanOrEqual(66);
    }
    expect(customColor(20, 0)).not.toBe(customColor(20, 100));
  });
  it('recovers hue and tone from a custom colour', () => {
    const color = customColor(210, 40);
    const controls = customControls(color);
    expect(Math.abs(controls.hue - 210)).toBeLessThanOrEqual(1);
    expect(Math.abs(controls.tone - 40)).toBeLessThanOrEqual(2);
    expect(customControls('#FFFFFF').tone).toBe(100);
  });
});
