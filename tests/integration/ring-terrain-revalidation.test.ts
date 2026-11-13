import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  assertRingSupportGeometryUnchanged,
  readRevalidatedRingTerrainInputs,
} from '../../tools/world-build/src/ring-terrain-revalidation.js';

describe('production source revalidation for existing terrain authoring', () => {
  it('accepts production metadata and lights while rejecting changed generated contacts', async () => {
    const result = await readRevalidatedRingTerrainInputs();
    expect(result.catalog.models).toHaveLength(222);
    expect(result.kits).toHaveLength(64);
    expect(result.anchors).toHaveLength(21);
    expect(result.evidence.physicalAcceptance).toBe('requires-new-release-verification');
    expect(
      result.evidence.models.some(
        (m) => m.currentSource.recipeSha256 !== m.historicalSource.recipeSha256,
      ),
    ).toBe(true);
    const catalog = JSON.parse(
      await readFile(
        'content/worlds/ring-block/terrain-candidate/model-classification.json',
        'utf8',
      ),
    );
    const observed = {
      catalogFile: 'content/buildings/ring-block/catalog.json',
      catalogSha256: catalog.catalogSha256,
      models: result.evidence.models.map((model) => ({
        assetId: model.assetId,
        source: model.currentSource,
        evidence: { modelInputSha256: model.modelInputSha256 },
      })),
    };
    expect(() => assertRingSupportGeometryUnchanged(catalog, observed)).not.toThrow();
    observed.models[0].evidence.modelInputSha256 = '0'.repeat(64);
    expect(() => assertRingSupportGeometryUnchanged(catalog, observed)).toThrow(
      /Generated support geometry changed/,
    );
  });
});
