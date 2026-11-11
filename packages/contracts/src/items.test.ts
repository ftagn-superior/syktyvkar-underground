import { describe, expect, it } from 'vitest';
import { parseItemCommand, validateItemCatalog, validPose } from './items.js';
import catalog from '../../../content/items/catalog.json';
import type { ItemCatalog } from './items.js';

describe('item command boundaries', () => {
  const pose = { position: { x: 1, y: 0.52, z: 2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
  it('rejects nonfinite coordinates, malformed quaternions, arbitrary actions and invalid counts', () => {
    const command = {
      operationId: 'operation-1',
      worldEpoch: 'epoch-1',
      action: { kind: 'place', itemId: 'item-1', pose },
    };
    expect(parseItemCommand(command)).toEqual(command);
    for (const x of [Infinity, NaN, '1', null])
      expect(validPose({ ...pose, position: { ...pose.position, x } })).toBe(false);
    for (const w of [0, 2, Infinity, NaN])
      expect(validPose({ ...pose, rotation: { ...pose.rotation, w } })).toBe(false);
    for (const count of [0, -1, 1.5, NaN])
      expect(
        parseItemCommand({ ...command, action: { kind: 'split', slotId: 'slot', count } }),
      ).toBeUndefined();
    expect(
      parseItemCommand({ ...command, action: { kind: 'create', itemId: 'item-1' } }),
    ).toBeUndefined();
    expect(
      parseItemCommand({
        ...command,
        action: { kind: 'move', slotId: 'slot', targetSlotId: 'slot' },
      }),
    ).toBeUndefined();
  });
  it('validates physical definitions and positive integral stack limits', () => {
    expect(() => validateItemCatalog(catalog as ItemCatalog)).not.toThrow();
    for (const maxStack of [0, -1, 2.5, NaN]) {
      const invalid = structuredClone(catalog);
      invalid.types['wooden-crate'].maxStack = maxStack;
      expect(() => validateItemCatalog(invalid as ItemCatalog)).toThrow('Invalid item type');
    }
  });
});
