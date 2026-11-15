import { describe, expect, it } from 'vitest';
import { REACTIONS, findReaction } from './reactions.js';
import { validateReactionDefinitions } from './reaction-validation.js';
import { matchingCatalogVersions } from './content-catalogs.js';

describe('reaction content contract', () => {
  it('keeps the existing collection and stable lookups intact', () => {
    expect(REACTIONS.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'hello',
        'like',
        'laugh',
        'love',
        'question',
        'work',
        'sleep',
        'eat',
        'coffee',
        'away',
        'busy',
        'music',
        'game',
        'read',
        'think',
        'sad',
        'angry',
        'surprise',
        'celebrate',
        'thanks',
      ]),
    );
    expect(() => validateReactionDefinitions(REACTIONS)).not.toThrow();
    for (const reaction of REACTIONS) expect(findReaction(reaction.id)).toBe(reaction);
    expect(findReaction('__proto__')).toBeUndefined();
  });
  it.each([
    { id: '' },
    { id: '../escape' },
    { id: 'Hello' },
    { id: 'a'.repeat(49) },
    { label: '' },
    { label: ' пробел' },
    { label: 'строка\nещё' },
    { label: 'а'.repeat(49) },
    { category: 'Все' },
    { category: 'Опечатка' },
    { asset: 'Hello.svg' },
    { asset: '../hello.svg' },
    { effect: 'new-mechanic' },
  ])('rejects invalid metadata with an actionable identity: %j', (patch) => {
    expect(() => validateReactionDefinitions([{ ...REACTIONS[0], ...patch }])).toThrow('Реакция');
  });
  it('refuses duplicate ids instead of choosing the first or last record', () => {
    expect(() => validateReactionDefinitions([REACTIONS[0], REACTIONS[0]])).toThrow(
      /hello.*повторный id/,
    );
  });
  it('requires the same named catalogs on both sides, including absent versions', () => {
    const versions = { reactions: 'a', animations: 'b' };
    expect(matchingCatalogVersions(versions, { animations: 'b', reactions: 'a' })).toBe(true);
    for (const other of [
      undefined,
      null,
      [],
      {},
      { reactions: 'a' },
      { reactions: 'a', animations: 'old' },
      { ...versions, other: 'x' },
    ])
      expect(matchingCatalogVersions(versions, other)).toBe(false);
  });
});
