import {
  canonicalJson,
  placementCatalogIdentity,
  validatePlacementCatalog,
  validatePlacementCatalogReference,
  type PlacementCatalog,
  type PlacementCatalogReference,
  type WorldInfo,
  type WorldManifest,
} from '@su/contracts';

/** Only a missing process snapshot or a changed publication warrants discovery refresh. */
export class PlacementCatalogChanged extends Error {}

export async function readPlacementCatalog(
  reference: PlacementCatalogReference,
  info: WorldInfo,
  manifest: WorldManifest,
  signal?: AbortSignal,
): Promise<PlacementCatalog> {
  validatePlacementCatalogReference(reference);
  if (reference.assetReleaseVersion !== info.assetReleaseVersion)
    throw new PlacementCatalogChanged('Каталог относится к другому выпуску мира.');
  const expected = `/worlds/${manifest.worldId}/placement-catalogs/${reference.placementCatalogVersion}.json`;
  const url = new URL(reference.url, location.href);
  if (url.origin !== location.origin || url.pathname !== expected || url.search || url.hash)
    throw new Error('Некорректная ссылка каталога.');
  const response = await fetch(url.href, {
    cache: 'default',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
  });
  if (response.status === 404) throw new PlacementCatalogChanged('Каталог обновлён.');
  if (!response.ok) throw new Error(`Не удалось загрузить каталог: ${response.status}`);
  const catalog = validatePlacementCatalog(await response.json(), manifest, reference);
  const bytes = new TextEncoder().encode(canonicalJson(placementCatalogIdentity(catalog)));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (hash !== reference.placementCatalogVersion)
    throw new Error('Не удалось проверить содержимое каталога.');
  if (signal?.aborted) throw new DOMException('Загрузка отменена', 'AbortError');
  return catalog;
}
