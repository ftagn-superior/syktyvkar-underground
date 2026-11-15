import { ANIMATION_CATALOG_VERSION, type ContentCatalogVersions } from '@su/contracts';

/** The browser sends its own compiled versions, never the server's discovery map.
 * When S-30 is integrated, add reactions here as well as to the server's map. */
export const CLIENT_CATALOG_VERSIONS: ContentCatalogVersions = {
  animations: ANIMATION_CATALOG_VERSION,
};
