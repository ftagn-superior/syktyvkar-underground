/** Identity embedded when an artifact is bundled; never inferred from a runtime checkout. */
export interface BuildIdentity {
  version: string;
  builtAt: string;
  buildId: string | null;
  commit: string | null;
  dirty: boolean | null;
  source: 'environment' | 'git' | 'unavailable';
}
export function readBuildIdentity(value: unknown): BuildIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.version !== 'string' ||
    v.version.length > 64 ||
    typeof v.builtAt !== 'string' ||
    !Number.isFinite(Date.parse(v.builtAt)) ||
    !(v.commit === null || (typeof v.commit === 'string' && /^[0-9a-f]{40}$/i.test(v.commit))) ||
    !(
      v.buildId === null ||
      (typeof v.buildId === 'string' && /^[A-Za-z0-9._:@+-]{1,160}$/.test(v.buildId))
    ) ||
    !(v.dirty === null || typeof v.dirty === 'boolean') ||
    !['environment', 'git', 'unavailable'].includes(v.source as string)
  )
    return null;
  return {
    version: v.version,
    builtAt: v.builtAt,
    buildId: v.buildId as string | null,
    commit: v.commit as string | null,
    dirty: v.dirty as boolean | null,
    source: v.source as BuildIdentity['source'],
  };
}
