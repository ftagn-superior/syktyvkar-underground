import type { AnimationDefinition } from '@su/contracts';

export const normalizeAnimationSearch = (value: string) =>
  value.toLocaleLowerCase('ru').replace(/ё/g, 'е').trim();
export function matchesAnimationSearch(animation: AnimationDefinition, query: string): boolean {
  const haystack = normalizeAnimationSearch(
    `${animation.id} ${animation.label} ${animation.category} ${animation.mode}`,
  );
  return normalizeAnimationSearch(query)
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}
