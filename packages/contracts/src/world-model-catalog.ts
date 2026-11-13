import type { WorldManifest } from './world-types.js';

/** Human-authored information; never part of geometry or physics identity. */
export interface WorldModelMetadata {
  name: string;
  description: string;
  category: string;
  tags: string[];
}
export interface WorldModelCategories {
  formatVersion: 1;
  categories: Record<string, { name: string }>;
}
export type WorldModelSourceKind = 'house' | 'footprint' | 'kit' | 'ground' | 'glb';
export interface WorldModelDescriptor {
  formatVersion: 1;
  assetId: string;
  metadata: WorldModelMetadata;
  renderMode?: 'thin-instance';
  source: { kind: WorldModelSourceKind; file: string; collisionFile?: string };
}
export interface WorldModelCatalogEntry {
  assetId: string;
  metadata: WorldModelMetadata;
  sourceKind: WorldModelSourceKind;
  /** One authoring model may produce several fixed ground tiles, or none if unused. */
  runtimeAssetIds: string[];
}
export interface WorldModelCatalog {
  formatVersion: 1;
  worldId: string;
  assetReleaseVersion: string;
  catalogVersion: string;
  categories: WorldModelCategories['categories'];
  models: Record<string, WorldModelCatalogEntry>;
  /** Explicit compiler-generated terrain/support resources without an authoring model card. */
  generatedAssetIds?: string[];
}
export interface WorldModelCatalogIndex {
  formatVersion: 1;
  /** Enables strict loading of the separate policy artifact. */
  placementPolicy?: true;
  worldId: string;
  assetReleaseVersion: string;
  catalogVersion: string;
}

const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const sourceKinds = new Set(['house', 'footprint', 'kit', 'ground', 'glb']);
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid world model catalog: ${message}`);
}
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function id(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}
function relativeFile(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.includes('\\') &&
    value.split('/').every((p) => p !== '' && p !== '.' && p !== '..')
  );
}
export function validateWorldModelCategories(value: unknown): WorldModelCategories {
  requireValue(
    object(value) && value.formatVersion === 1 && object(value.categories),
    'categories',
  );
  const entries = Object.entries(value.categories);
  requireValue(entries.length > 0 && entries.length <= 100, 'category count');
  for (const [key, category] of entries)
    requireValue(id(key) && object(category) && text(category.name, 120), `category ${key}`);
  return value as WorldModelCategories;
}
export function validateWorldModelMetadata(
  value: unknown,
  categories: WorldModelCategories['categories'],
): WorldModelMetadata {
  requireValue(object(value), 'metadata');
  requireValue(
    Object.keys(value).sort().join(',') === 'category,description,name,tags',
    'metadata fields',
  );
  requireValue(text(value.name, 120), 'metadata.name');
  requireValue(text(value.description, 1600), 'metadata.description');
  requireValue(
    id(value.category) && Object.hasOwn(categories, value.category),
    'metadata.category',
  );
  requireValue(
    Array.isArray(value.tags) &&
      value.tags.length <= 24 &&
      value.tags.every((tag: unknown) => id(tag) && tag.length <= 40) &&
      new Set(value.tags).size === value.tags.length,
    'metadata.tags',
  );
  return value as WorldModelMetadata;
}
export function validateWorldModelDescriptor(
  value: unknown,
  assetId: string,
  categories: WorldModelCategories['categories'],
): WorldModelDescriptor {
  requireValue(
    object(value) && value.formatVersion === 1 && id(assetId) && value.assetId === assetId,
    `descriptor ${assetId}`,
  );
  requireValue(
    value.renderMode === undefined || value.renderMode === 'thin-instance',
    `renderMode ${assetId}`,
  );
  requireValue(
    object(value.source) && sourceKinds.has(value.source.kind) && relativeFile(value.source.file),
    `source ${assetId}`,
  );
  if (value.source.kind === 'glb')
    requireValue(relativeFile(value.source.collisionFile), `collisionFile ${assetId}`);
  validateWorldModelMetadata(value.metadata, categories);
  return value as WorldModelDescriptor;
}
export function validateWorldModelCatalogIndex(value: unknown): WorldModelCatalogIndex {
  requireValue(object(value) && value.formatVersion === 1 && id(value.worldId), 'index identity');
  requireValue(
    typeof value.assetReleaseVersion === 'string' && hashPattern.test(value.assetReleaseVersion),
    'assetReleaseVersion',
  );
  requireValue(
    typeof value.catalogVersion === 'string' && hashPattern.test(value.catalogVersion),
    'catalogVersion',
  );
  requireValue(
    value.placementPolicy === undefined || value.placementPolicy === true,
    'placementPolicy marker',
  );
  return value as WorldModelCatalogIndex;
}
export function validateWorldModelCatalog(
  value: unknown,
  manifest?: WorldManifest,
): WorldModelCatalog {
  const index = validateWorldModelCatalogIndex(value);
  requireValue(object(value) && object(value.models), 'models');
  const categories = validateWorldModelCategories({
    formatVersion: 1,
    categories: value.categories,
  }).categories;
  const entries = Object.entries(value.models);
  requireValue(entries.length > 0 && entries.length <= 10_000, 'model count');
  if (manifest) requireValue(index.worldId === manifest.worldId, 'world mismatch');
  const runtimeIds = new Set<string>();
  for (const [key, model] of entries) {
    requireValue(
      id(key) && object(model) && model.assetId === key && sourceKinds.has(model.sourceKind),
      `model ${key}`,
    );
    validateWorldModelMetadata(model.metadata, categories);
    requireValue(
      Array.isArray(model.runtimeAssetIds) && model.runtimeAssetIds.length <= 10_000,
      `runtime assets ${key}`,
    );
    if (model.sourceKind !== 'ground')
      requireValue(
        model.runtimeAssetIds.length === 1 && model.runtimeAssetIds[0] === key,
        `runtime identity ${key}`,
      );
    for (const assetId of model.runtimeAssetIds) {
      requireValue(
        id(assetId) && !runtimeIds.has(assetId),
        `duplicate/invalid runtime asset ${assetId}`,
      );
      if (manifest)
        requireValue(Object.hasOwn(manifest.assets, assetId), `missing runtime asset ${assetId}`);
      runtimeIds.add(assetId);
    }
  }
  if (value.generatedAssetIds !== undefined) {
    requireValue(
      Array.isArray(value.generatedAssetIds) && value.generatedAssetIds.length <= 100_000,
      'generated assets',
    );
    for (const assetId of value.generatedAssetIds) {
      requireValue(
        id(assetId) && !runtimeIds.has(assetId),
        `duplicate/invalid generated asset ${assetId}`,
      );
      if (manifest)
        requireValue(Object.hasOwn(manifest.assets, assetId), `missing generated asset ${assetId}`);
      runtimeIds.add(assetId);
    }
  }
  if (manifest)
    requireValue(
      Object.keys(manifest.assets).every((assetId) => runtimeIds.has(assetId)),
      'unmapped runtime assets',
    );
  return value as WorldModelCatalog;
}
/** Hash this canonical projection outside contracts, using the producer/consumer SHA-256. */
export function worldModelCatalogIdentity(catalog: WorldModelCatalog) {
  const { catalogVersion: _version, ...identity } = catalog;
  return identity;
}
