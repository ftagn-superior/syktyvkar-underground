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
    if (!['humanoid-v1', 'humanoid-v2'].includes(entry.rig))
      fail('rig must be humanoid-v1 or humanoid-v2');
    const v2 = entry.rig === 'humanoid-v2';
    const v2Fields = ['support', 'seatedMessage', 'reducedMotion', 'reducedMotionLabel'];
    if (!v2 && entry.seated !== 'preserve-seat') fail('seated must explicitly be preserve-seat');
    if (v2) {
      if (!['capsule', 'ground'].includes(entry.support))
        fail('v2 support must be capsule or ground');
      if (!['preserve-seat', 'variant', 'unavailable'].includes(entry.seated))
        fail('v2 seated must be preserve-seat, variant or unavailable');
      if (entry.support === 'ground' && entry.mode !== 'fullBody')
        fail('ground support requires fullBody mode');
      if (entry.support === 'ground' && entry.seated === 'preserve-seat')
        fail('ground support requires an explicit seated variant or unavailable policy');
      if (!['scaled', 'static'].includes(entry.reducedMotion))
        fail('v2 reducedMotion must be scaled or static');
      if (entry.support === 'ground' && entry.reducedMotion !== 'static')
        fail('ground support requires a static reduced-motion alternative');
      for (const field of ['seatedMessage', 'reducedMotionLabel']) {
        const required =
          field === 'seatedMessage'
            ? entry.seated !== 'preserve-seat'
            : entry.reducedMotion === 'static';
        const text = entry[field];
        if (
          (required || text !== undefined) &&
          (typeof text !== 'string' ||
            !text.trim() ||
            text !== text.trim() ||
            text.length > 160 ||
            /[\u0000-\u001f\u007f]/.test(text))
        )
          fail(`${field} must explain the alternative (trimmed text, 1..160 characters)`);
        if (!required && text !== undefined)
          fail(`${field} is incompatible with the selected policy`);
      }
    }
    for (const key of Object.keys(entry))
      if (!fields.includes(key) && !(v2 && v2Fields.includes(key)))
        fail(`unknown metadata field ${key}`);
  }
  return errors;
}
