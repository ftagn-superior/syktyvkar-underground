import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { validateWorld, canonicalJson, normalizeInput } from './index.js';
const source = {
  ...JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8')),
  buildings: [],
  buildingAssets: {},
};
describe('world contract', () => {
  it('accepts the shipped scene and rejects identity collisions', () => {
    expect(validateWorld(source).spawnPoints).toHaveLength(8);
    const duplicate = structuredClone(source);
    duplicate.entities.push(duplicate.entities[0]);
    expect(() => validateWorld(duplicate)).toThrow('duplicate ID');
  });
  it('rejects unsafe spawn geometry and invalid physics', () => {
    const invalid = structuredClone(source);
    invalid.spawnPoints[0] = invalid.entities.find(
      (e: { entityId: string }) => e.entityId === 'corner-west',
    ).position;
    expect(() => validateWorld(invalid)).toThrow('spawn intersects');
    const bad = structuredClone(source);
    bad.simulation.character.speed = Infinity;
    expect(() => validateWorld(bad)).toThrow('character.speed');
  });
  it('normalizes diagonal movement and rejects non-finite commands', () => {
    expect(Math.hypot(...Object.values(normalizeInput({ moveX: 1, moveZ: 1 })!))).toBeCloseTo(1);
    for (const moveX of [NaN, Infinity, '1', null, 1000])
      expect(normalizeInput({ moveX, moveZ: 0 })).toBeUndefined();
  });
  it('canonicalizes object keys without reordering geometry arrays', () => {
    expect(canonicalJson({ b: 2, a: [3, 1] })).toBe(canonicalJson({ a: [3, 1], b: 2 }));
    expect(canonicalJson({ a: [3, 1] })).not.toBe(canonicalJson({ a: [1, 3] }));
  });
});
