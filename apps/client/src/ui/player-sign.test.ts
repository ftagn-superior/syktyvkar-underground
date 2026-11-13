import { describe, expect, it } from 'vitest';
import { SIGN_COUNT, signIndex, signMarkup } from './player-sign';

describe('player sign', () => {
  it('is stable for the same name and colour', () => {
    expect(signIndex('Аня', '#E8A33A')).toBe(signIndex('Аня', '#E8A33A'));
    expect(signIndex('Аня', '#e8a33a')).toBe(signIndex('Аня', '#E8A33A'));
    expect(signIndex(' Аня ', '#E8A33A')).toBe(signIndex('Аня', '#E8A33A'));
  });
  it('always lands on one of the nine shapes and uses all of them', () => {
    expect(SIGN_COUNT).toBe(9);
    const seen = new Set<number>();
    for (let index = 0; index < 400; index++) {
      const sign = signIndex(`Гость ${index}`, '#6EE0C4');
      expect(sign).toBeGreaterThanOrEqual(0);
      expect(sign).toBeLessThan(SIGN_COUNT);
      seen.add(sign);
    }
    expect(seen.size).toBe(SIGN_COUNT);
  });
  it('accepts only hex colours in the markup', () => {
    expect(signMarkup(0, '#112233')).toContain('fill="#112233"');
    expect(signMarkup(0, 'red" onload="x')).not.toContain('onload');
    expect(signMarkup(-1, '#112233')).toContain('<path d="M5 20.5');
  });
});
