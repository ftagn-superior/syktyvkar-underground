import { describe, expect, it } from 'vitest';
import {
  parsePlaceStaticRequest,
  parseStoredPlaceStaticRequest,
  LEGACY_PLACEMENT_CATALOG_VERSION,
  placedStaticInstance,
  STATIC_PLACEMENT_ASSET_ID,
} from './static-placement.js';
import { parseChatCommand } from '../../../apps/server/src/chat-commands.js';
const valid = () => ({
  assetId: STATIC_PLACEMENT_ASSET_ID,
  placementCatalogVersion: 'b'.repeat(64),
  operationId: '12345678-1234-4567-8123-123456789abc',
  worldEpoch: 'epoch',
  assetReleaseVersion: 'a'.repeat(64),
  expectedLayoutRevision: 1,
  position: { x: 50, z: -90 },
  yawStep: 23,
});
describe('static creation contract', () => {
  it('accepts only finite coordinates, a canonical UUID and one integer yaw step', () => {
    expect(parsePlaceStaticRequest(valid())).toEqual(valid());
    for (const patch of [
      { operationId: '123' },
      { operationId: valid().operationId.toUpperCase() },
      { yawStep: 24 },
      { yawStep: -1 },
      { yawStep: 0.2 },
      { position: { x: Infinity, z: 0 } },
      { position: { x: NaN, z: 0 } },
      { position: { x: 0, z: 0, y: 0 } },
      { assetId: '../arbitrary' },
      { placementCatalogVersion: 'invalid' },
      { rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { enabled: true },
      { entityId: 'mine' },
      { expectedLayoutRevision: 0 },
    ])
      expect(parsePlaceStaticRequest({ ...valid(), ...patch })).toBeUndefined();
  });
  it('derives identity, ground plane, asset and normalized Y-only rotation', () => {
    const i = placedStaticInstance(valid());
    expect(i).toMatchObject({
      entityId: `placed_${valid().operationId}`,
      assetId: STATIC_PLACEMENT_ASSET_ID,
      position: { x: 50, y: 0, z: -90 },
      instanceRevision: 1,
      enabled: true,
    });
    expect(i.rotation.x).toBe(0);
    expect(i.rotation.z).toBe(0);
    expect(Math.hypot(i.rotation.y, i.rotation.w)).toBeCloseTo(1, 12);
    expect(i).not.toHaveProperty('sourceRef');
  });
  it('migrates only exact persisted v13 requests without authorizing a new placement', () => {
    const { assetId: _asset, placementCatalogVersion: _catalog, ...legacy } = valid();
    expect(parsePlaceStaticRequest(legacy)).toBeUndefined();
    expect(parseStoredPlaceStaticRequest(legacy)).toEqual({
      ...legacy,
      assetId: STATIC_PLACEMENT_ASSET_ID,
      placementCatalogVersion: LEGACY_PLACEMENT_CATALOG_VERSION,
    });
    expect(parseStoredPlaceStaticRequest(valid())).toEqual(valid());
    expect(parseStoredPlaceStaticRequest({ ...legacy, unknown: true })).toBeUndefined();
    expect(
      parseStoredPlaceStaticRequest({ ...legacy, position: { x: NaN, z: 1 } }),
    ).toBeUndefined();
    expect(placedStaticInstance({ ...valid(), assetId: 'tree-birch-small' }).assetId).toBe(
      'tree-birch-small',
    );
  });
  it('opens only the argument-free private command', () => {
    expect(parseChatCommand('/motherlode')).toEqual({ kind: 'staticPlacement' });
    expect(parseChatCommand('/motherlode bench')).toMatchObject({
      kind: 'invalid',
      code: 'INVALID_INPUT',
    });
  });
});
