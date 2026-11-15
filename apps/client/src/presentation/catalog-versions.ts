import { ANIMATION_CATALOG_VERSION, type ContentCatalogVersions } from '@su/contracts';
import { REACTION_CATALOG_VERSION } from './reaction-release';

/** Complete compiled catalog map; never copy the server's discovery versions. */
export const CLIENT_CATALOG_VERSIONS: ContentCatalogVersions = {
  reactions: REACTION_CATALOG_VERSION,
  animations: ANIMATION_CATALOG_VERSION,
};
