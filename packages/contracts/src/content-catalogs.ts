/** Версии независимых коллекций. Новые коллекции добавляют свой ключ в обе сборки. */
export type ContentCatalogVersions = Readonly<Record<string, string>>;

export function matchingCatalogVersions(
  expected: ContentCatalogVersions,
  received: unknown,
): boolean {
  if (!received || typeof received !== 'object' || Array.isArray(received)) return false;
  const values = received as Record<string, unknown>;
  return (
    Object.keys(expected).length === Object.keys(values).length &&
    Object.entries(expected).every(
      ([key, version]) => Object.hasOwn(values, key) && values[key] === version,
    )
  );
}
