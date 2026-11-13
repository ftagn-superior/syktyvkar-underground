import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  placementCatalogIdentity,
  type PlacementCatalog,
  type PlacementCatalogReference,
  type WorldInfo,
  type WorldManifest,
} from '@su/contracts';
import { readPlacementCatalog, PlacementCatalogChanged } from './placement-catalog';

let catalog: PlacementCatalog;
let reference: PlacementCatalogReference;
const manifest = { worldId: 'test', assets: { 'tree-small': {} } } as unknown as WorldManifest;
const info = { assetReleaseVersion: 'a'.repeat(64) } as WorldInfo;
beforeEach(() => {
  vi.stubGlobal('location', new URL('https://game.example/'));
  catalog = {
    formatVersion: 1,
    worldId: 'test',
    assetReleaseVersion: info.assetReleaseVersion!,
    modelCatalogVersion: 'b'.repeat(64),
    placementCatalogVersion: '',
    groundY: 0,
    yawSteps: 24,
    categories: { vegetation: { name: 'Растительность' } },
    models: [
      {
        assetId: 'tree-small',
        metadata: {
          name: 'Берёза',
          description: 'Маленькое дерево',
          category: 'vegetation',
          tags: ['tree'],
        },
      },
    ],
  };
  catalog.placementCatalogVersion = createHash('sha256')
    .update(canonicalJson(placementCatalogIdentity(catalog)))
    .digest('hex');
  reference = {
    assetReleaseVersion: catalog.assetReleaseVersion,
    modelCatalogVersion: catalog.modelCatalogVersion,
    placementCatalogVersion: catalog.placementCatalogVersion,
    url: `/worlds/test/placement-catalogs/${catalog.placementCatalogVersion}.json`,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(catalog)),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('verified placement catalog download', () => {
  it('accepts only the catalog bound to the reference and active release', async () => {
    expect(await readPlacementCatalog(reference, info, manifest)).toEqual(catalog);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects corrupted metadata even when JSON and all version fields are valid', async () => {
    catalog.models[0].metadata.name = 'Подмена';
    await expect(readPlacementCatalog(reference, info, manifest)).rejects.toThrow('содержимое');
  });
  it('rejects a reference/body mismatch, another world and missing manifest assets', async () => {
    catalog.modelCatalogVersion = 'c'.repeat(64);
    await expect(readPlacementCatalog(reference, info, manifest)).rejects.toThrow('reference');
    catalog.modelCatalogVersion = reference.modelCatalogVersion;
    catalog.worldId = 'another-world';
    await expect(readPlacementCatalog(reference, info, manifest)).rejects.toThrow('world');
    catalog.worldId = 'test';
    catalog.models[0].assetId = 'unlisted';
    await expect(readPlacementCatalog(reference, info, manifest)).rejects.toThrow('manifest');
  });
  it('allows one discovery refresh for a vanished process snapshot or changed release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(readPlacementCatalog(reference, info, manifest)).rejects.toBeInstanceOf(
      PlacementCatalogChanged,
    );
    await expect(
      readPlacementCatalog(reference, { ...info, assetReleaseVersion: 'd'.repeat(64) }, manifest),
    ).rejects.toBeInstanceOf(PlacementCatalogChanged);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not follow a forged catalog URL', async () => {
    await expect(
      readPlacementCatalog(
        { ...reference, url: 'https://other.example/catalog.json' },
        info,
        manifest,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
