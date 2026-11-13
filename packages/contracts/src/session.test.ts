import { describe, expect, it } from 'vitest';
import { parseAreaFailed } from './session.js';

describe('area failure identity', () => {
  const failure = {
    prepareId: 'prepare-1',
    layoutRevision: 1,
    worldEpoch: 'epoch',
    mapVersion: 'map',
    code: 'RESOURCE_UNAVAILABLE',
  };
  it('accepts only a bounded plan identity and the local resource failure code', () => {
    expect(parseAreaFailed(failure)).toEqual(failure);
    for (const value of [
      null,
      [],
      { ...failure, position: { x: 0, y: 0, z: 0 } },
      { ...failure, spawnSource: 'default' },
      { ...failure, code: 'BLOCKED' },
      { ...failure, layoutRevision: NaN },
      { ...failure, layoutRevision: 0 },
      { ...failure, prepareId: '' },
      { ...failure, worldEpoch: 'a'.repeat(129) },
      { ...failure, mapVersion: 2 },
    ])
      expect(parseAreaFailed(value)).toBeUndefined();
  });
});
