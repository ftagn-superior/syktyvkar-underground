import { describe, expect, it } from 'vitest';
import { foliageGeometry, foliageOcclusion } from './foliage-shapes.js';

describe('foliage ambient occlusion', () => {
  it.each(['broadleaf', 'shrub'] as const)(
    'keeps %s exposed tips bright and darkens lobe contacts',
    (profile) => {
      const geometry = foliageGeometry(profile);
      const factors = foliageOcclusion(profile);
      expect(factors).toHaveLength(geometry.positions.length / 3);
      expect(
        factors.every((factor) => Number.isFinite(factor) && factor >= 0.66 - 1e-12 && factor <= 1),
      ).toBe(true);
      expect(factors.filter((factor) => factor === 1).length).toBeGreaterThan(50);
      const average = (predicate: (y: number) => boolean) => {
        const selected = factors.filter((_, i) => predicate(geometry.positions[i * 3 + 1]));
        return selected.reduce((sum, value) => sum + value, 0) / selected.length;
      };
      expect(average((y) => y > 0.9)).toBeGreaterThan(0.98);
      expect(average((y) => y > 0.3 && y < 0.8)).toBeLessThan(0.85);
      // Object translation/non-uniform scaling changes only geometry, never the shared AO profile.
      expect(foliageGeometry(profile, 3, 7, 4, 12, -8).positions.length).toBe(
        geometry.positions.length,
      );
      expect(foliageOcclusion(profile)).toEqual(factors);
    },
  );
});
