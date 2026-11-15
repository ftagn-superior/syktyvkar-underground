import { describe, expect, it } from 'vitest';
import { REACTIONS } from '@su/contracts';
import {
  matchesReactionSearch,
  normalizeReactionSearch,
  reactionSearchText,
  rememberRecent,
} from './reactions';

describe('reaction discovery', () => {
  it('matches every normalized word in the name, id or category', () => {
    expect(normalizeReactionSearch('  ОТОШЁЛ   Статус  ')).toBe('отошел статус');
    const away = reactionSearchText(REACTIONS.find((r) => r.id === 'away')!);
    expect(matchesReactionSearch(away, 'ОТОШЕЛ статус')).toBe(true);
    expect(matchesReactionSearch(away, 'AWAY')).toBe(true);
    expect(matchesReactionSearch(away, 'статус кофе')).toBe(false);
    expect(matchesReactionSearch(away, '')).toBe(true);
  });
  it('keeps four unique known recents while catalog order remains unchanged', () => {
    expect(rememberRecent(['hello', 'like', 'love', 'work', 'removed'], 'love')).toEqual([
      'love',
      'hello',
      'like',
      'work',
    ]);
    expect(REACTIONS[0].id).toBe('hello');
  });
});
