import type { BuildingParts, WorldDefinition, WorldManifest } from './world-types.js';
import {
  validateWorldModelCategories,
  validateWorldModelMetadata,
  type WorldModelCatalog,
  type WorldModelMetadata,
} from './world-model-catalog.js';
import { validateBuildingParts, validateBuildingPhysicsAsset } from './world-bundle.js';
import type { Vec3 } from './simulation.js';

/** Preview data only. The server computes the accepted pose from its private terrain grid. */
export type PlacementModelSupport =
  | {
      kind: 'ground-anchor';
      anchor: Vec3;
      contactRadius: number;
      contactDatum: 'minimum' | 'anchor';
      maximumTerrainReliefMetres: number;
    }
  | {
      kind: 'foundation';
      /** Local support/approach samples; owner Y is at least terrain Y + offsetY. */
      heightSamples: Array<{ x: number; z: number; offsetY: number }>;
    };

export interface WorldPlacementPolicySource {
  formatVersion: 1;
  assetIds: string[];
}
export interface WorldPlacementPolicy extends WorldPlacementPolicySource {
  worldId: string;
  assetReleaseVersion: string;
}
export interface PlacementCatalogReference {
  assetReleaseVersion: string;
  modelCatalogVersion: string;
  placementCatalogVersion: string;
  url: string;
}
export interface PlacementCatalog {
  formatVersion: 1;
  worldId: string;
  assetReleaseVersion: string;
  modelCatalogVersion: string;
  placementCatalogVersion: string;
  /** null selects the explicit terrain bodies and per-model preview policies. */
  groundY: 0 | null;
  terrain?: { groundEntityIds: string[] };
  yawSteps: 24;
  categories: Record<string, { name: string }>;
  models: Array<{
    assetId: string;
    metadata: WorldModelMetadata;
    placement?: PlacementModelSupport;
  }>;
}
const id = /^[a-z0-9][a-z0-9-]{0,79}$/;
const hash = /^[a-f0-9]{64}$/;
const zeroVersion = '0'.repeat(64);
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid placement catalog: ${message}`);
}
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, names: string[]): asserts value is Record<string, any> {
  requireValue(
    object(value) && Object.keys(value).sort().join(',') === names.sort().join(','),
    'fields',
  );
}
export function validatePlacementModelSupport(value: unknown): PlacementModelSupport {
  requireValue(object(value), 'placement support');
  const finite = (n: unknown) =>
    typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100_000;
  if (value.kind === 'ground-anchor') {
    fields(value, [
      'kind',
      'anchor',
      'contactRadius',
      'contactDatum',
      'maximumTerrainReliefMetres',
    ]);
    fields(value.anchor, ['x', 'y', 'z']);
    requireValue(Object.values(value.anchor).every(finite), 'placement anchor');
    requireValue(finite(value.contactRadius) && value.contactRadius > 0, 'contact radius');
    requireValue(['minimum', 'anchor'].includes(value.contactDatum), 'contact datum');
    requireValue(
      finite(value.maximumTerrainReliefMetres) && value.maximumTerrainReliefMetres > 0,
      'terrain relief',
    );
  } else {
    fields(value, ['kind', 'heightSamples']);
    requireValue(value.kind === 'foundation', 'placement support kind');
    requireValue(
      Array.isArray(value.heightSamples) &&
        value.heightSamples.length > 0 &&
        value.heightSamples.length <= 16_384,
      'foundation height samples',
    );
    for (const sample of value.heightSamples) {
      fields(sample, ['x', 'z', 'offsetY']);
      requireValue(Object.values(sample).every(finite), 'foundation height sample');
    }
  }
  return value as PlacementModelSupport;
}
function checkPolicyIds(value: Record<string, any>) {
  requireValue(value.formatVersion === 1, 'policy format');
  requireValue(
    Array.isArray(value.assetIds) && value.assetIds.length > 0 && value.assetIds.length <= 10_000,
    'policy assetIds',
  );
  const seen = new Set<string>();
  for (const assetId of value.assetIds) {
    requireValue(typeof assetId === 'string' && id.test(assetId), `policy asset ID ${assetId}`);
    requireValue(!seen.has(assetId), `duplicate policy asset ${assetId}`);
    seen.add(assetId);
  }
}
export function validateWorldPlacementPolicySource(value: unknown): WorldPlacementPolicySource {
  fields(value, ['formatVersion', 'assetIds']);
  checkPolicyIds(value);
  return value as WorldPlacementPolicySource;
}
export function validateWorldPlacementPolicy(value: unknown): WorldPlacementPolicy {
  fields(value, ['formatVersion', 'assetIds', 'worldId', 'assetReleaseVersion']);
  checkPolicyIds(value);
  requireValue(typeof value.worldId === 'string' && id.test(value.worldId), 'policy worldId');
  requireValue(
    typeof value.assetReleaseVersion === 'string' && hash.test(value.assetReleaseVersion),
    'policy release',
  );
  return value as WorldPlacementPolicy;
}
export function validatePlacementCatalogReference(value: unknown): PlacementCatalogReference {
  fields(value, ['assetReleaseVersion', 'modelCatalogVersion', 'placementCatalogVersion', 'url']);
  for (const key of ['assetReleaseVersion', 'modelCatalogVersion', 'placementCatalogVersion'])
    requireValue(typeof value[key] === 'string' && hash.test(value[key]), key);
  requireValue(value.placementCatalogVersion !== zeroVersion, 'reserved reconciliation version');
  requireValue(
    typeof value.url === 'string' &&
      /^\/worlds\/[a-z0-9][a-z0-9-]{0,79}\/placement-catalogs\/[a-f0-9]{64}\.json$/.test(value.url),
    'catalog URL',
  );
  requireValue(value.url.endsWith(`/${value.placementCatalogVersion}.json`), 'catalog URL version');
  return value as PlacementCatalogReference;
}
export function validatePlacementCatalog(
  value: unknown,
  manifest?: WorldManifest,
  reference?: PlacementCatalogReference,
): PlacementCatalog {
  fields(value, [
    'formatVersion',
    'worldId',
    'assetReleaseVersion',
    'modelCatalogVersion',
    'placementCatalogVersion',
    'groundY',
    'yawSteps',
    'categories',
    'models',
    ...(object(value) && value.terrain !== undefined ? ['terrain'] : []),
  ]);
  requireValue(
    value.formatVersion === 1 &&
      (value.groundY === 0 || value.groundY === null) &&
      value.yawSteps === 24,
    'format/placement parameters',
  );
  if (value.groundY === null) {
    fields(value.terrain, ['groundEntityIds']);
    const ids = value.terrain.groundEntityIds;
    requireValue(
      Array.isArray(ids) &&
        ids.length > 0 &&
        ids.length <= 100_000 &&
        ids.every(
          (entry: unknown) => typeof entry === 'string' && entry.length > 0 && entry.length <= 128,
        ) &&
        new Set(ids).size === ids.length,
      'terrain ground IDs',
    );
  } else requireValue(value.terrain === undefined, 'terrain requires null groundY');
  requireValue(typeof value.worldId === 'string' && id.test(value.worldId), 'worldId');
  for (const key of ['assetReleaseVersion', 'modelCatalogVersion', 'placementCatalogVersion'])
    requireValue(typeof value[key] === 'string' && hash.test(value[key]), key);
  requireValue(value.placementCatalogVersion !== zeroVersion, 'reserved reconciliation version');
  const categories = validateWorldModelCategories({
    formatVersion: 1,
    categories: value.categories,
  }).categories;
  requireValue(
    Array.isArray(value.models) && value.models.length > 0 && value.models.length <= 10_000,
    'models',
  );
  const seen = new Set<string>(),
    usedCategories = new Set<string>();
  for (const model of value.models) {
    fields(model, [
      'assetId',
      'metadata',
      ...(object(model) && model.placement !== undefined ? ['placement'] : []),
    ]);
    if (value.groundY === null || model.placement !== undefined)
      validatePlacementModelSupport(model.placement);
    requireValue(
      typeof model.assetId === 'string' && id.test(model.assetId) && !seen.has(model.assetId),
      `duplicate/invalid model ${model.assetId}`,
    );
    validateWorldModelMetadata(model.metadata, categories);
    if (manifest)
      requireValue(
        Object.hasOwn(manifest.assets, model.assetId),
        `missing manifest asset ${model.assetId}`,
      );
    seen.add(model.assetId);
    usedCategories.add(model.metadata.category);
  }
  requireValue(
    Object.keys(categories).every((category) => usedCategories.has(category)),
    'unused category',
  );
  if (manifest) requireValue(value.worldId === manifest.worldId, 'world mismatch');
  if (reference) {
    validatePlacementCatalogReference(reference);
    for (const key of [
      'assetReleaseVersion',
      'modelCatalogVersion',
      'placementCatalogVersion',
    ] as const)
      requireValue(value[key] === reference[key], `reference ${key}`);
    requireValue(
      reference.url ===
        `/worlds/${value.worldId}/placement-catalogs/${value.placementCatalogVersion}.json`,
      'reference world',
    );
  }
  return value as PlacementCatalog;
}
/** SHA-256 is supplied by the Node/browser consumer, never by contracts. */
export function placementCatalogIdentity(catalog: PlacementCatalog) {
  const { placementCatalogVersion: _version, ...identity } = catalog;
  return {
    ...identity,
    categories: Object.fromEntries(
      Object.entries(catalog.categories).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    models: catalog.models
      .map((model) => ({
        ...model,
        metadata: { ...model.metadata, tags: [...model.metadata.tags].sort() },
      }))
      .sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0)),
  };
}
/** Validate the explicit policy against one accepted immutable asset release. */
export function validateWorldPlacementAssets(
  policy: WorldPlacementPolicy,
  catalog: WorldModelCatalog,
  manifest: WorldManifest,
  definition: WorldDefinition,
  parts: Record<string, BuildingParts>,
  fixedInstanceIds: readonly string[],
): void {
  validateWorldPlacementPolicy(policy);
  requireValue(
    policy.worldId === manifest.worldId &&
      policy.worldId === catalog.worldId &&
      policy.worldId === definition.worldId,
    'policy world mismatch',
  );
  requireValue(
    policy.assetReleaseVersion === catalog.assetReleaseVersion,
    'policy asset release mismatch',
  );
  const fixedIds = new Set(fixedInstanceIds);
  const fixedAssets = new Set(
    definition.buildings
      .filter((instance) => fixedIds.has(instance.entityId))
      .map((instance) => instance.assetId),
  );
  for (const assetId of policy.assetIds) {
    try {
      const model = catalog.models[assetId];
      requireValue(model && model.assetId === assetId, 'model is not registered');
      requireValue(model.sourceKind !== 'ground', 'ground cannot be placed');
      requireValue(
        model.runtimeAssetIds.length === 1 && model.runtimeAssetIds[0] === assetId,
        'model must map to its single runtime ID',
      );
      requireValue(Object.hasOwn(manifest.assets, assetId), 'asset missing from manifest');
      requireValue(!fixedAssets.has(assetId), 'asset belongs to fixed layer');
      const physics = validateBuildingPhysicsAsset(definition.buildingAssets[assetId]);
      requireValue(physics.assetId === assetId, 'physics asset ID mismatch');
      requireValue(
        physics.colliders.length === 1 && physics.colliders[0].kind === 'box',
        'requires exactly one box collider',
      );
      const visual = validateBuildingParts(parts[assetId]);
      requireValue(visual.assetId === assetId, 'parts asset ID mismatch');
      const resource = manifest.assets[assetId];
      requireValue(
        resource.modelFile ? !visual.tree : !!visual.tree,
        'requires a static GLB or current tree profile',
      );
    } catch (error) {
      throw new Error(
        `World ${policy.worldId}, placement asset ${assetId}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
}
