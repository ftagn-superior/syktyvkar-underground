import { describe, expect, it } from 'vitest';
import { ANIMATIONS } from '@su/contracts';
import { matchesAnimationSearch } from './animation-search';
const catalog = ANIMATIONS.filter((a) => ['robot', 'shrug', 'wave'].includes(a.id));

describe('animation discovery', () => {
  it('searches all words across ID, Russian label, category and mode without reordering', () => {
    expect(
      catalog.filter((a) => matchesAnimationSearch(a, ' ТАНЦЫ robot ')).map((a) => a.id),
    ).toEqual(['robot']);
    expect(
      catalog.filter((a) => matchesAnimationSearch(a, ' ПОЖАТЬ ПЛЕЧАМИ ')).map((a) => a.id),
    ).toEqual(['shrug']);
    expect(catalog.filter((a) => matchesAnimationSearch(a, 'upperBody'))).toHaveLength(2);
    expect(catalog.filter((a) => matchesAnimationSearch(a, 'nothing-found'))).toEqual([]);
    expect(catalog.filter((a) => matchesAnimationSearch(a, ''))).toEqual(catalog);
  });
});
