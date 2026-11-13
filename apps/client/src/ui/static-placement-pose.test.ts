import { describe, expect, it, vi } from 'vitest';
import {
  staticPlacementRotation,
  type PlacementCatalog,
  type PlacementModelSupport,
} from '@su/contracts';
import { staticPlacementPreviewPose, type PlacementSurfaceRay } from './static-placement-pose';

const bounds = { min: { x: -100, y: -50, z: -100 }, max: { x: 100, y: 100, z: 100 } };
const ray = { from: { x: 2, y: 50, z: 3 }, to: { x: 2, y: -50, z: 3 } };
function catalog(placement?: PlacementModelSupport): PlacementCatalog {
  return {
    formatVersion: 1,
    worldId: 'test',
    assetReleaseVersion: 'a'.repeat(64),
    modelCatalogVersion: 'b'.repeat(64),
    placementCatalogVersion: 'c'.repeat(64),
    groundY: placement ? null : 0,
    ...(placement ? { terrain: { groundEntityIds: ['terrain-tile'] } } : {}),
    yawSteps: 24,
    categories: { street: { name: 'Улица' } },
    models: [
      {
        assetId: 'bench',
        metadata: {
          name: 'Скамейка',
          description: 'Тестовая модель',
          category: 'street',
          tags: [],
        },
        ...(placement ? { placement } : {}),
      },
    ],
  };
}
const slope: PlacementSurfaceRay = (from) => ({
  entityId: 'terrain-tile',
  point: { x: from.x, y: 10 + from.x + from.z * 0.5, z: from.z },
  normal: { x: -1, y: 1, z: -0.5 },
});
const preview = (value: PlacementCatalog, surface = slope, yawStep = 0) =>
  staticPlacementPreviewPose(
    value,
    'bench',
    ray,
    staticPlacementRotation(yawStep),
    bounds,
    surface,
  );
const anchor = {
  kind: 'ground-anchor',
  anchor: { x: 1, y: 2, z: 0 },
  contactRadius: 0.1,
  contactDatum: 'minimum',
  maximumTerrainReliefMetres: 0.31,
} as const;

describe('terrain-aware static placement preview', () => {
  it('retains the flat catalog without querying terrain', () => {
    const surface = vi.fn(slope);
    expect(preview(catalog(), surface)?.position).toEqual({ x: 2, y: 0, z: 3 });
    expect(surface).not.toHaveBeenCalled();
  });
  it('uses the minimum world-axis contact square around the rotated local anchor', () => {
    expect(preview(catalog(anchor), slope, 6)?.position.y).toBeCloseTo(10.85, 8);
    expect(
      preview(catalog({ ...anchor, contactDatum: 'anchor' }), slope, 6)?.position.y,
    ).toBeCloseTo(11, 8);
  });
  it('includes all supplied foundation/approach height constraints above nonzero terrain', () => {
    expect(
      preview(
        catalog({
          kind: 'foundation',
          heightSamples: [
            { x: 0, z: 0, offsetY: -0.2 },
            { x: 4, z: 0, offsetY: 0.4 },
          ],
        }),
      )?.position,
    ).toEqual({ x: 2, y: 17.9, z: 3 });
  });
  it('does not treat roofs, side walls, or unloaded ground as terrain', () => {
    const value = catalog(anchor);
    expect(
      preview(value, (from, to) => ({ ...slope(from, to)!, entityId: 'roof' })),
    ).toBeUndefined();
    expect(
      preview(value, (from, to) => ({ ...slope(from, to)!, normal: { x: 1, y: 0, z: 0 } })),
    ).toBeUndefined();
    expect(preview(value, () => undefined)).toBeUndefined();
    let calls = 0;
    expect(
      preview(value, (from, to) => (++calls === 1 ? slope(from, to) : undefined)),
    ).toBeUndefined();
  });
  it('rejects visible excessive anchor relief and never falls back to Y zero', () => {
    expect(preview(catalog({ ...anchor, maximumTerrainReliefMetres: 0.1 }))).toBeUndefined();
  });
});
