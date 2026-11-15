import type { ReactionDefinition, ContentCatalogVersions } from '@su/contracts';

declare const __SU_REACTION_CATALOG_VERSION__: string;

// Значение без Vite используется только изолированными unit-тестами.
export const REACTION_CATALOG_VERSION =
  typeof __SU_REACTION_CATALOG_VERSION__ === 'string'
    ? __SU_REACTION_CATALOG_VERSION__
    : 'test-reactions';
export const CLIENT_CATALOG_VERSIONS: ContentCatalogVersions = {
  reactions: REACTION_CATALOG_VERSION,
};

export function reactionAssetUrl(reaction: ReactionDefinition): string {
  return `/reactions/${encodeURIComponent(reaction.asset)}?v=${REACTION_CATALOG_VERSION}`;
}
