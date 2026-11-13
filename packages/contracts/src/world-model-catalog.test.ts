import { describe, expect, it } from 'vitest';
import {
  validateWorldModelCategories,
  validateWorldModelMetadata,
  validateWorldModelDescriptor,
  validateWorldModelCatalog,
  type WorldModelCatalog,
} from './world-model-catalog.js';
import type { WorldManifest } from './world-types.js';

const categories = { buildings: { name: 'Здания' }, ground: { name: 'Основание' } };
const metadata = {
  name: 'Дом',
  description: 'Светлый дом со скатной крышей.',
  category: 'buildings',
  tags: ['house'],
};
const descriptor = {
  formatVersion: 1,
  assetId: 'house',
  metadata,
  source: { kind: 'house', file: 'source.json' },
};
function fixture(): WorldModelCatalog {
  return {
    formatVersion: 1,
    worldId: 'test',
    assetReleaseVersion: 'a'.repeat(64),
    catalogVersion: 'b'.repeat(64),
    categories,
    models: {
      house: {
        assetId: 'house',
        metadata: structuredClone(metadata),
        sourceKind: 'house',
        runtimeAssetIds: ['house'],
      },
      terrain: {
        assetId: 'terrain',
        metadata: { ...metadata, category: 'ground' },
        sourceKind: 'ground',
        runtimeAssetIds: ['terrain-0-0', 'terrain-0-1'],
      },
    },
  };
}
const manifest = {
  worldId: 'test',
  assets: { house: {}, 'terrain-0-0': {}, 'terrain-0-1': {} },
} as unknown as WorldManifest;

describe('world model catalog contracts', () => {
  it('explicitly accounts for generated terrain resources without hiding missing or duplicated cards', () => {
    const value = fixture();
    const extra = {
      ...manifest,
      assets: { ...manifest.assets, 'generated-support': {} },
    } as unknown as WorldManifest;
    expect(() => validateWorldModelCatalog(value, extra)).toThrow('unmapped');
    value.generatedAssetIds = ['generated-support'];
    expect(validateWorldModelCatalog(value, extra)).toEqual(value);
    value.generatedAssetIds.push('house');
    expect(() => validateWorldModelCatalog(value, extra)).toThrow('duplicate');
    value.generatedAssetIds = ['missing'];
    expect(() => validateWorldModelCatalog(value, extra)).toThrow('missing generated');
  });
  it('accepts complete cards, repeated display names and a shared category vocabulary', () => {
    expect(validateWorldModelCategories({ formatVersion: 1, categories }).categories).toEqual(
      categories,
    );
    expect(validateWorldModelDescriptor(descriptor, 'house', categories)).toEqual(descriptor);
    expect(
      validateWorldModelDescriptor(
        { ...descriptor, source: { kind: 'house', file: 'модели/дом с крышей.json' } },
        'house',
        categories,
      ).source.file,
    ).toBe('модели/дом с крышей.json');
    expect(
      validateWorldModelCatalog(fixture(), manifest).models.terrain.runtimeAssetIds,
    ).toHaveLength(2);
  });
  it.each([
    ['missing name', { ...metadata, name: undefined }],
    ['blank description', { ...metadata, description: ' ' }],
    ['untrimmed name', { ...metadata, name: ' Дом' }],
    ['long name', { ...metadata, name: 'я'.repeat(121) }],
    ['unknown category', { ...metadata, category: 'unknown' }],
    ['duplicate tags', { ...metadata, tags: ['house', 'house'] }],
    ['uncontrolled tag syntax', { ...metadata, tags: ['Дом с крышей'] }],
    ['misspelled field', { ...metadata, title: 'Дом' }],
  ])('rejects %s', (_name, value) => {
    expect(() => validateWorldModelMetadata(value, categories)).toThrow(
      'Invalid world model catalog',
    );
  });
  it('rejects descriptors without metadata, mismatched IDs and escaping source paths', () => {
    expect(() =>
      validateWorldModelDescriptor({ ...descriptor, metadata: undefined }, 'house', categories),
    ).toThrow('metadata');
    expect(() => validateWorldModelDescriptor(descriptor, 'other', categories)).toThrow(
      'descriptor',
    );
    expect(() =>
      validateWorldModelDescriptor(
        { ...descriptor, source: { kind: 'house', file: '../source.json' } },
        'house',
        categories,
      ),
    ).toThrow('source');
  });
  it('requires embedded GLB collision references and a supported source kind', () => {
    expect(() =>
      validateWorldModelDescriptor(
        { ...descriptor, source: { kind: 'glb', file: 'model.glb' } },
        'house',
        categories,
      ),
    ).toThrow('collisionFile');
    expect(() =>
      validateWorldModelDescriptor(
        { ...descriptor, source: { kind: 'unknown', file: 'source.json' } },
        'house',
        categories,
      ),
    ).toThrow('source');
  });
  it('rejects duplicate, absent and unmapped runtime models', () => {
    const duplicate = fixture();
    duplicate.models.terrain.runtimeAssetIds.push('house');
    expect(() => validateWorldModelCatalog(duplicate, manifest)).toThrow('duplicate');
    const missing = fixture();
    missing.models.terrain.runtimeAssetIds.push('terrain-0-2');
    expect(() => validateWorldModelCatalog(missing, manifest)).toThrow('missing runtime');
    const unmapped = fixture();
    unmapped.models.terrain.runtimeAssetIds.pop();
    expect(() => validateWorldModelCatalog(unmapped, manifest)).toThrow('unmapped');
  });
  it('only permits ground sources to have zero or multiple compiled resources', () => {
    const catalog = fixture();
    catalog.models.house.runtimeAssetIds = [];
    expect(() => validateWorldModelCatalog(catalog)).toThrow('runtime identity');
    catalog.models.house.runtimeAssetIds = ['house'];
    catalog.models.terrain.runtimeAssetIds = [];
    expect(validateWorldModelCatalog(catalog)).toEqual(catalog);
  });
  it('rejects a catalog from a different world', () => {
    expect(() => validateWorldModelCatalog(fixture(), { ...manifest, worldId: 'other' })).toThrow(
      'world mismatch',
    );
  });
});
