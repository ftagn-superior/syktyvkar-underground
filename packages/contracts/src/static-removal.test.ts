import { describe, expect, it } from 'vitest';
import { parseRemoveStaticRequest } from './static-removal.js';

const valid = {
  operationId: '12345678-1234-4567-8123-123456789abc',
  worldEpoch: 'epoch',
  assetReleaseVersion: 'a'.repeat(64),
  expectedLayoutRevision: 3707,
  entityId: 'osm_way-123',
};
describe('whole static removal contract', () => {
  it('accepts original instance IDs without creation or account ownership fields', () => {
    expect(parseRemoveStaticRequest(valid)).toEqual(valid);
    expect(parseRemoveStaticRequest({ ...valid, entityId: 'placed_123' })).toBeDefined();
  });
  it('rejects malformed identity, revisions and client-controlled authority or state', () => {
    for (const patch of [
      { operationId: 'invalid' },
      { worldEpoch: '' },
      { assetReleaseVersion: 'invalid' },
      { entityId: '../house' },
      { entityId: '' },
      { expectedLayoutRevision: 0 },
      { expectedLayoutRevision: 1.1 },
      { expectedLayoutRevision: 2147483648 },
      { expectedLayoutRevision: Infinity },
      { accountId: 'owner' },
      { enabled: false },
      { position: { x: 0, y: 0, z: 0 } },
    ])
      expect(parseRemoveStaticRequest({ ...valid, ...patch })).toBeUndefined();
    expect(parseRemoveStaticRequest(null)).toBeUndefined();
    expect(parseRemoveStaticRequest([])).toBeUndefined();
    const { entityId: _entityId, ...missing } = valid;
    expect(parseRemoveStaticRequest(missing)).toBeUndefined();
  });
});
