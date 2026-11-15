import type { ReactionDefinition } from './reactions.js';

export const REACTION_CATEGORIES = ['Общение', 'Эмоции', 'Занятия', 'Статус'] as const;
export const REACTION_SVG_MAX_BYTES = 64 * 1024;
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const controls = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u;

/** Общие правила не зависят от файловой системы, DOM или игрового движка. */
export function validateReactionDefinitions(value: unknown): asserts value is ReactionDefinition[] {
  if (!Array.isArray(value) || !value.length)
    throw new Error('REACTIONS: каталог не должен быть пустым');
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const name = entry && typeof entry === 'object' ? entry.id : undefined;
    const fail = (reason: string): never => {
      throw new Error(`Реакция ${JSON.stringify(name ?? `#${index + 1}`)}: ${reason}`);
    };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('ожидается объект');
    if (Object.keys(entry).some((key) => !['id', 'label', 'category', 'asset'].includes(key)))
      fail('неизвестное поле; допустимы id, label, category, asset');
    if (typeof name !== 'string' || name.length > 48 || !idPattern.test(name))
      fail('id: 1–48 символов, строчные латинские буквы, цифры и одиночные дефисы; начало — буква');
    if (ids.has(name)) fail('повторный id');
    ids.add(name);
    if (
      typeof entry.label !== 'string' ||
      entry.label !== entry.label.trim() ||
      [...entry.label].length < 1 ||
      [...entry.label].length > 48 ||
      controls.test(entry.label)
    )
      fail('label: 1–48 видимых символов, без крайних пробелов и управляющих символов');
    if (!REACTION_CATEGORIES.includes(entry.category))
      fail(`category: выберите ${REACTION_CATEGORIES.join(', ')}`);
    if (entry.asset !== `${name}.svg`) fail(`asset: ожидается ${name}.svg (имя и регистр точные)`);
  }
}
