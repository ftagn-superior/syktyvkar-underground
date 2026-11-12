import { describe, expect, it } from 'vitest';
import { parseItemCommand, validateItemCatalog, validPose } from './items.js';
import catalog from '../../../content/items/catalog.json';
import type { ItemCatalog } from './items.js';
import { itemPhysicsDefinition, itemSupportDistance } from './item-shapes.js';

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
  it('keeps saved crate physics compatible while recording geometry for the new models', () => {
    const types = (catalog as ItemCatalog).types;
    expect(itemPhysicsDefinition(types['wooden-crate'])).toEqual({
      model: 'box',
      size: { x: 1, y: 1, z: 1 },
      mass: 10,
      friction: 0.6,
      restitution: 0.05,
    });
    const monument = itemPhysicsDefinition(types['confidence-monument']);
    expect(monument.parts?.map((part) => part.kind)).toContain('capsule');
    const recolored = {
      ...types['confidence-monument'],
      color: '#ff00ff',
      name: 'Другое название',
    };
    expect(itemPhysicsDefinition(recolored)).toEqual(monument);
  });
  it('rejects unknown models and dimensions incompatible with their physical shape', () => {
    for (const change of [
      { model: 'missing' },
      { model: 'watermelon', size: { x: 1, y: 2, z: 1 } },
      { model: 'monument', size: { x: 1, y: 4, z: 2 } },
    ]) {
      const invalid = structuredClone(catalog);
      Object.assign(invalid.types['wooden-crate'], change);
      expect(() => validateItemCatalog(invalid as ItemCatalog)).toThrow('Invalid item type');
    }
  });
  it('uses spherical support at every rotation and the actual compound silhouette', () => {
    const types = (catalog as ItemCatalog).types;
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const tilted = { x: Math.sin(Math.PI / 8), y: 0, z: 0, w: Math.cos(Math.PI / 8) };
    const ball = types['watermelon-ball'];
    expect(itemSupportDistance(ball, tilted, { x: 0, y: -1, z: 0 })).toBeCloseTo(0.6);
    const monument = types['confidence-monument'];
    expect(itemSupportDistance(monument, identity, { x: 0, y: 1, z: 0 })).toBeCloseTo(2);
    expect(itemSupportDistance(monument, identity, { x: 0, y: -1, z: 0 })).toBeCloseTo(2);
    // The rounded tip does not occupy the empty corners of the four-metre bounding box.
    expect(itemSupportDistance(monument, tilted, { x: 0, y: 1, z: 0 })).toBeLessThan(
      ((monument.size.y + monument.size.z) * Math.SQRT1_2) / 2,
    );
  });
});
