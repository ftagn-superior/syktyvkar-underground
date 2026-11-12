import { describe, expect, it } from 'vitest';
import { accentVars, luminance, mixHex, normalizeHex } from './theme';

describe('accent maths', () => {
  it('derives readable ink and text colours from luminance', () => {
    const light = accentVars('#6EE0C4');
    expect(light['--accent-ink']).toBe('#0c1412');
    expect(light['--accent-text']).toBe('#6EE0C4');
    const dark = accentVars('#1b2a6b');
    expect(dark['--accent-ink']).toBe('#f4f7f6');
    expect(luminance(dark['--accent-text'])).toBeGreaterThan(luminance('#1b2a6b'));
    expect(luminance(dark['--accent-text'])).toBeGreaterThanOrEqual(0.4);
  });
  it('emits translucent variants and tolerates bad input', () => {
    expect(accentVars('#ff0000')['--accent-soft']).toBe('rgba(255,0,0,.16)');
    expect(accentVars('#ff0000')['--accent-line']).toBe('rgba(255,0,0,.55)');
    expect(normalizeHex('nonsense')).toBe('#6EE0C4');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});
