import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  placementCatalogIdentity,
  validatePlacementCatalog,
  validatePlacementCatalogReference,
  validateWorldPlacementAssets,
  validateWorldPlacementPolicySource,
  type PlacementCatalog,
  type WorldPlacementPolicy,
} from './placement-catalog.js';
import { canonicalJson } from './world.js';
import type { BuildingParts, WorldDefinition, WorldManifest } from './world-types.js';
import type { WorldModelCatalog } from './world-model-catalog.js';
const metadata = {
  name: 'Скамейка',
  description: 'Парковая скамейка.',
  category: 'street',
  tags: ['wood', 'bench'],
};
const bounds = { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } };
const policy: WorldPlacementPolicy = {
  formatVersion: 1,
  worldId: 'test',
  assetReleaseVersion: 'a'.repeat(64),
  assetIds: ['bench'],
};
const catalog: WorldModelCatalog = {
  formatVersion: 1,
  worldId: 'test',
  assetReleaseVersion: policy.assetReleaseVersion,
  catalogVersion: 'b'.repeat(64),
  categories: { street: { name: 'Улица' } },
  models: { bench: { assetId: 'bench', metadata, sourceKind: 'kit', runtimeAssetIds: ['bench'] } },
};
const manifest = {
  worldId: 'test',
  assets: { bench: { modelFile: 'model.glb', bounds } },
} as unknown as WorldManifest;
function fixture() {
  const definition = {
    worldId: 'test',
    buildings: [],
    buildingAssets: {
      bench: {
        assetId: 'bench',
        bounds,
        colliders: [
          {
            id: 'box',
            kind: 'box',
            position: { x: 0, y: 1, z: 0 },
            size: { x: 1, y: 2, z: 1 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            friction: 0.8,
            restitution: 0,
          },
        ],
      },
    },
  } as unknown as WorldDefinition;
  const parts: Record<string, BuildingParts> = {
    bench: {
      formatVersion: 1,
      assetId: 'bench',
      parts: [{ partId: 'body', role: 'detail', occlusionGroup: null, nodeIndex: 0 }],
    },
  };
  const placement: PlacementCatalog = {
    formatVersion: 1,
    worldId: 'test',
    assetReleaseVersion: policy.assetReleaseVersion,
    modelCatalogVersion: catalog.catalogVersion,
    placementCatalogVersion: 'c'.repeat(64),
    groundY: 0,
    yawSteps: 24,
    categories: catalog.categories,
    models: [{ assetId: 'bench', metadata: structuredClone(metadata) }],
  };
  return { definition, parts, placement };
}
const digest = (value: PlacementCatalog) =>
  createHash('sha256')
    .update(canonicalJson(placementCatalogIdentity(value)))
    .digest('hex');
describe('placement catalog', () => {
  it('accepts an explicit unique nonempty authoring list and rejects extra copies of metadata', () => {
    expect(validateWorldPlacementPolicySource({ formatVersion: 1, assetIds: ['bench'] })).toEqual({
      formatVersion: 1,
      assetIds: ['bench'],
    });
    for (const assetIds of [[], ['bench', 'bench'], ['../bench']])
      expect(() => validateWorldPlacementPolicySource({ formatVersion: 1, assetIds })).toThrow();
    expect(() =>
      validateWorldPlacementPolicySource({ formatVersion: 1, assetIds: ['bench'], name: 'fake' }),
    ).toThrow();
  });
  it('binds body, reference, world and manifest without accepting reserved or escaping URLs', () => {
    const { placement } = fixture();
    const reference = {
      assetReleaseVersion: placement.assetReleaseVersion,
      modelCatalogVersion: placement.modelCatalogVersion,
      placementCatalogVersion: placement.placementCatalogVersion,
      url: `/worlds/test/placement-catalogs/${placement.placementCatalogVersion}.json`,
    };
    expect(validatePlacementCatalog(placement, manifest, reference)).toEqual(placement);
    expect(() =>
      validatePlacementCatalog(placement, manifest, {
        ...reference,
        assetReleaseVersion: 'd'.repeat(64),
      }),
    ).toThrow('reference');
    expect(() =>
      validatePlacementCatalog(placement, { ...manifest, worldId: 'other' }, reference),
    ).toThrow('world');
    expect(() =>
      validatePlacementCatalog(
        { ...placement, models: [{ ...placement.models[0], assetId: 'missing' }] },
        manifest,
      ),
    ).toThrow('missing');
    expect(() =>
      validatePlacementCatalog(
        { ...placement, models: [...placement.models, placement.models[0]] },
        manifest,
      ),
    ).toThrow('duplicate');
    expect(() =>
      validatePlacementCatalogReference({ ...reference, url: 'https://evil.test/catalog.json' }),
    ).toThrow('URL');
    expect(() =>
      validatePlacementCatalog({ ...placement, placementCatalogVersion: '0'.repeat(64) }),
    ).toThrow('reserved');
  });
  it('canonicalizes ordering but changes identity for display data, permissions, parameters or release', () => {
    const { placement } = fixture();
    const changedOrder = structuredClone(placement);
    changedOrder.models[0].metadata.tags.reverse();
    expect(digest(changedOrder)).toBe(digest(placement));
    changedOrder.models[0].metadata.name += ' новая';
    expect(digest(changedOrder)).not.toBe(digest(placement));
    expect(digest({ ...placement, assetReleaseVersion: 'd'.repeat(64) })).not.toBe(
      digest(placement),
    );
  });
  it('validates exact release physics and visual profiles rather than inferring permission', () => {
    const { definition, parts } = fixture();
    expect(() =>
      validateWorldPlacementAssets(policy, catalog, manifest, definition, parts, []),
    ).not.toThrow();
    for (const mutate of [
      (value: WorldModelCatalog) => {
        value.models.bench.sourceKind = 'ground';
      },
      (value: WorldModelCatalog) => {
        value.models.bench.runtimeAssetIds = ['bench', 'other'];
      },
      (value: WorldModelCatalog) => {
        value.assetReleaseVersion = 'c'.repeat(64);
      },
    ]) {
      const invalid = structuredClone(catalog);
      mutate(invalid);
      expect(() =>
        validateWorldPlacementAssets(policy, invalid, manifest, definition, parts, []),
      ).toThrow();
    }
    expect(() =>
      validateWorldPlacementAssets(
        { ...policy, assetIds: ['missing'] },
        catalog,
        manifest,
        definition,
        parts,
        [],
      ),
    ).toThrow('World test, placement asset missing');
    const fixed = {
      ...definition,
      buildings: [
        {
          entityId: 'fixed',
          assetId: 'bench',
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      ],
    };
    expect(() =>
      validateWorldPlacementAssets(policy, catalog, manifest, fixed, parts, ['fixed']),
    ).toThrow('fixed layer');
    definition.buildingAssets.bench.colliders.push({
      ...definition.buildingAssets.bench.colliders[0],
      id: 'other',
    });
    expect(() =>
      validateWorldPlacementAssets(policy, catalog, manifest, definition, parts, []),
    ).toThrow('one box');
  });
});
