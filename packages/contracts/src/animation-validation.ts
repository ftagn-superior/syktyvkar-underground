/** Shared metadata rules: no renderer, filesystem, DOM or network dependency. */
export function validateAnimationDefinitions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ['catalog: expected a nonempty array'];
  const errors: string[] = [];
  const ids = new Set<string>();
  const fields = ['id', 'label', 'category', 'cooldownMs', 'mode', 'rig', 'seated'];
  for (const [index, entry] of value.entries()) {
    const prefix = `animation ${typeof entry?.id === 'string' ? JSON.stringify(entry.id) : `#${index}`}`;
    const fail = (reason: string) => errors.push(`${prefix}: ${reason}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('expected a metadata object');
      continue;
    }
    if (
      typeof entry.id !== 'string' ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.id) ||
      entry.id.length > 48
    )
      fail(
        'id must be 1–48 lowercase ASCII letters/digits with single hyphens, starting with a letter',
      );
    if (ids.has(entry.id)) fail('duplicate id');
    ids.add(entry.id);
    for (const [field, limit] of [
      ['label', 80],
      ['category', 40],
    ] as const) {
      const text = entry[field];
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        text !== text.trim() ||
        text.length > limit ||
        /[\u0000-\u001f\u007f]/.test(text)
      )
        fail(
          `${field} must be trimmed, nonempty text (at most ${limit} characters, no control characters)`,
        );
    }
    if (typeof entry.category === 'string' && entry.category.toLocaleLowerCase('ru') === 'все')
      fail('category «Все» is reserved for the catalog filter');
    if (!Number.isInteger(entry.cooldownMs) || entry.cooldownMs < 1 || entry.cooldownMs > 30_000)
      fail('cooldownMs must be an integer in 1..30000 milliseconds');
    if (!['upperBody', 'fullBody'].includes(entry.mode)) fail('mode must be upperBody or fullBody');
    if (entry.rig !== 'humanoid-v1') fail('rig must be humanoid-v1');
    if (entry.seated !== 'preserve-seat') fail('seated must explicitly be preserve-seat');
    for (const key of Object.keys(entry))
      if (!fields.includes(key)) fail(`unknown metadata field ${key}`);
  }
  return errors;
}
