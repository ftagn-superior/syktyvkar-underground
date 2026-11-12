import { describe, expect, it } from 'vitest';
import { bakeLocalAo } from '../../tools/world-build/src/ambient-occlusion.js';
import { addBox, addFace, meshPart } from '../../tools/world-build/src/house.js';
import { linear, mergeParts } from '../../tools/world-build/src/merge.js';
import { encodeStaticGlb } from '../../tools/world-build/src/glb.js';
import { glbTriangles } from '../helpers/static-extraction.js';

function corner(size = 1) {
  const floor = meshPart('floor', 'detail', '#b6a27c');
  addFace(floor, [
    [0, 0, 0],
    [0, 0, size],
    [size, 0, size],
    [size, 0, 0],
  ]);
  const wall = meshPart('wall', 'wall', '#ffffff');
  addFace(wall, [
    [0, 0, 0],
    [0, 1, 0],
    [0, 1, size],
    [0, 0, size],
  ]);
  return [floor, wall];
}

describe('asset-local vertex AO', () => {
  it('darkens a nearby concave joint, leaves open vertices clear, preserves geometry and hue', () => {
    const parts = corner();
    const before = structuredClone(parts);
    bakeLocalAo(parts);
    expect(parts[0].colors![0]).toBeLessThan(0.95);
    expect(parts[0].colors![6]).toBe(1);
    for (const [index, part] of parts.entries()) {
      expect({ ...part, colors: undefined }).toEqual({ ...before[index], colors: undefined });
      for (let i = 0; i < part.positions.length; i += 3) {
        const rgb = part.colors?.slice(i, i + 3) ?? [1, 1, 1];
        expect(rgb[0]).toBeGreaterThanOrEqual(0.7);
        expect(rgb[0]).toBeLessThanOrEqual(1);
        expect(rgb).toEqual([rgb[0], rgb[0], rgb[0]]);
      }
    }
    const repeat = corner();
    bakeLocalAo(repeat);
    expect(encodeStaticGlb(repeat)).toEqual(encodeStaticGlb(parts));
  });

  it('does not bake another fade group, a remote surface, or a fictitious ground plane', () => {
    const independent = corner();
    independent[1].occlusionGroup = null;
    bakeLocalAo(independent);
    expect(independent.every((part) => part.colors === undefined)).toBe(true);

    const remote = corner();
    remote[1].positions = remote[1].positions.map((n, i) => (i % 3 === 0 ? n - 2 : n));
    bakeLocalAo(remote);
    expect(remote[0].colors).toBeUndefined();

    const box = meshPart('isolated', 'detail', '#ffffff');
    addBox(box, { x: 0, y: 0.5, z: 0 }, { x: 1, y: 1, z: 1 });
    bakeLocalAo([box]);
    expect(box.colors).toBeUndefined();
  });

  it('limits interpolated shading on sparse large faces', () => {
    const small = corner(),
      large = corner(30);
    bakeLocalAo(small);
    bakeLocalAo(large);
    expect(large[0].colors![0]).toBeGreaterThan(small[0].colors![0]);
    expect(Math.min(...large[0].colors!)).toBeGreaterThan(0.94);
  });

  it.each([false, true])(
    'keeps unequal coplanar roof triangles seamless across duplicated vertices (separate materials: %s)',
    (separateMaterials) => {
      const first = meshPart('roof-a', 'roof', '#b6a27c');
      const second = separateMaterials ? meshPart('roof-b', 'roof', '#708391') : first;
      addFace(first, [
        [0, 0, 0],
        [0, 0, 1],
        [1, 0, 0],
      ]);
      addFace(second, [
        [0, 0, 0],
        [1, 0, 0],
        [3, 0, -4],
      ]);
      const parapet = meshPart('parapet', 'wall', '#ffffff');
      addFace(parapet, [
        [0, 0, -4],
        [0, 1, -4],
        [0, 1, 1],
        [0, 0, 1],
      ]);
      const parts = [...new Set([first, second]), parapet];
      const before = structuredClone(parts);
      bakeLocalAo(parts);
      const offset = separateMaterials ? 0 : 9;
      // The common corner is occluded, so equality cannot pass by skipping AO.
      expect(first.colors![0]).toBeLessThan(0.98);
      expect(first.colors!.slice(0, 3)).toEqual(second.colors!.slice(offset, offset + 3));
      expect(first.colors!.slice(6, 9)).toEqual(second.colors!.slice(offset + 3, offset + 6));
      for (const [i, part] of parts.entries())
        expect({ ...part, colors: undefined }).toEqual({ ...before[i], colors: undefined });
    },
  );

  it('multiplies existing linear vertex colors and retains them across repeated merges and GLB encoding', () => {
    const parts = corner();
    parts[0].colors = Array(parts[0].positions.length / 3)
      .fill([0.8, 0.6, 0.4])
      .flat();
    const original = [...parts[0].colors];
    bakeLocalAo(parts);
    const material = linear(parts[0].color);
    const baked = parts[0].colors!;
    for (let i = 0; i < baked.length; i += 3) {
      expect(baked[i] / original[i]).toBeCloseTo(baked[i + 1] / original[i + 1], 12);
      expect(baked[i] / original[i]).toBeCloseTo(baked[i + 2] / original[i + 2], 12);
    }
    const merged = mergeParts(parts);
    expect(merged).toHaveLength(1);
    expect(merged[0].color).toBe('#ffffff');
    for (let i = 0; i < baked.length; i++)
      expect(merged[0].colors![i]).toBeCloseTo(baked[i] * material[i % 3], 12);
    expect(mergeParts(merged)).toEqual(merged);

    const placement = {
      assetId: 'ao',
      entityId: 'ao',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    const unmergedTriangles = glbTriangles(encodeStaticGlb(parts), placement);
    const mergedTriangles = glbTriangles(encodeStaticGlb(merged), placement);
    expect(mergedTriangles).toHaveLength(unmergedTriangles.length);
    for (const [i, triangle] of mergedTriangles.entries())
      for (const [j, vertex] of triangle.vertices.entries())
        for (let k = 0; k < vertex.length; k++)
          expect(vertex[k]).toBeCloseTo(unmergedTriangles[i].vertices[j][k], 6);
  });
});
