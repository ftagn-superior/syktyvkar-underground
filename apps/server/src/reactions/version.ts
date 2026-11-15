import { createHash } from 'node:crypto';
import type { ReactionDefinition } from '@su/contracts';

/** Одинаковый отпечаток используется сборщиком, валидатором и сервером. */
export function reactionReleaseVersion(
  definitions: readonly ReactionDefinition[],
  assets: ReadonlyMap<string, Uint8Array>,
): string {
  const digest = createHash('sha256');
  digest.update(
    JSON.stringify(
      definitions.map(({ id, label, category, asset }) => ({ id, label, category, asset })),
    ),
  );
  for (const { asset } of definitions) {
    const bytes = assets.get(asset);
    if (!bytes) throw new Error(`Реакции: отсутствует ${asset}`);
    digest.update('\0').update(asset).update('\0').update(bytes);
  }
  return digest.digest('hex');
}
