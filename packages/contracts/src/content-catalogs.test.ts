import { describe, expect, it } from 'vitest';
import { matchingCatalogVersions } from './content-catalogs.js';

describe('independent catalog release compatibility', () => {
  const expected = { reactions: 'reaction-release', animations: 'animation-release' };

  it('matches every collection independently of key order', () => {
    expect(
      matchingCatalogVersions(expected, {
        animations: 'animation-release',
        reactions: 'reaction-release',
      }),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    [],
    'animation-release',
    {},
    { animations: 'animation-release' },
    { reactions: 'reaction-release' },
    { ...expected, animations: 'old-animations' },
    { ...expected, reactions: 'old-reactions' },
    { ...expected, items: 'unknown-items' },
    Object.create(expected),
  ])('rejects a missing, changed or unsupported collection: %j', (received) => {
    expect(matchingCatalogVersions(expected, received)).toBe(false);
  });
});
