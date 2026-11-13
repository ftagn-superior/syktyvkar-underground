import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TerrainGrid } from '../../packages/contracts/src/index.js';
import type { StaticMeshPart } from '../../packages/terrain-build/src/mesh.js';
import {
  generateTerrainTile,
  rectangle,
  type GeneratedTerrainAsset,
} from '../../packages/terrain-build/src/terrain.js';
import { indexTerrainAsset } from '../../tools/world-build/src/terrain-tiles.js';
import { mergeParts } from '../../tools/world-build/src/merge.js';

// Expanded ordered streams are the geometry actually consumed by rendering and physics.
function renderHash(parts: StaticMeshPart[]) {
  const hash = createHash('sha256'),
    scalar = Buffer.alloc(4);
  for (const part of parts) {
    hash.update(
      JSON.stringify({ color: part.color, role: part.role, occlusionGroup: part.occlusionGroup }),
    );
    for (const index of part.indices)
      for (const attributes of [
        part.positions,
        part.normals,
        ...(part.colors ? [part.colors] : []),
      ])
        for (const value of attributes.slice(index * 3, index * 3 + 3)) {
          scalar.writeFloatLE(value);
          hash.update(scalar);
        }
  }
  return hash.digest('hex');
}
function colliderHash(asset: GeneratedTerrainAsset) {
  const hash = createHash('sha256'),
    scalar = Buffer.alloc(8);
  for (const collider of asset.physics.colliders) {
    if (collider.kind !== 'mesh') {
      hash.update(JSON.stringify(collider));
      continue;
    }
    for (const index of collider.indices)
      for (const value of collider.vertices.slice(index * 3, index * 3 + 3)) {
        scalar.writeDoubleLE(value);
        hash.update(scalar);
      }
  }
  return hash.digest('hex');
}

describe('lossless indexing of terrain publication geometry', () => {
  it.each([false, true])(
    'preserves ordered triangle attributes on sloped geometry (merge=%s)',
    (merge) => {
      const grid: TerrainGrid = {
        formatVersion: 1,
        origin: { x: 0, z: 0 },
        spacing: 2,
        columns: 9,
        rows: 7,
        bottom: -5,
        heights: Array.from(
          { length: 9 * 7 },
          (_, i) => Math.sin(i % 9) + Math.cos(Math.floor(i / 9)),
        ),
      };
      const original = generateTerrainTile('indexed-ground', grid, rectangle(8, 6, 16, 12), [
        {
          id: 'road',
          outline: rectangle(8, 6, 14, 10),
          holes: [rectangle(8, 6, 2, 2)],
          color: '#706d68',
          offset: 0.031,
        },
      ]);
      if (merge) original.parts = mergeParts(original.parts);
      const before = structuredClone(original),
        indexed = indexTerrainAsset(original);
      expect(original).toEqual(before);
      expect(renderHash(indexed.parts)).toBe(renderHash(original.parts));
      expect(colliderHash(indexed)).toBe(colliderHash(original));
      expect(indexed.parts.reduce((sum, p) => sum + p.positions.length, 0)).toBeLessThan(
        original.parts.reduce((sum, p) => sum + p.positions.length, 0),
      );
      expect(indexed.parts.reduce((sum, p) => sum + p.indices.length, 0)).toBe(
        original.parts.reduce((sum, p) => sum + p.indices.length, 0),
      );
      expect(indexed.physics.bounds).toEqual(original.physics.bounds);
      const a = original.physics.colliders[0],
        b = indexed.physics.colliders[0];
      if (a.kind !== 'mesh' || b.kind !== 'mesh') throw new Error('Mesh fixture required');
      expect(b.vertices.length).toBeLessThan(a.vertices.length);
      expect(b.indices.length).toBe(a.indices.length);
    },
  );

  it('preserves signed zero and separates Float64 physics points that share one Float32 render position', () => {
    const positions = [
      1000.000000001, 0, 0, 1001, 0, 0, 1000, 0, 1, 1000.000000002, 0, 0, 1001, 0, 0, 1000, 0, 1, 0,
      0, 0, 1, 0, 0, 0, 0, 1, -0, 0, 0, 1, 0, 0, 0, 0, 1,
    ];
    const indices = Array.from({ length: positions.length / 3 }, (_, i) => i);
    const part: StaticMeshPart = {
      partId: 'surface',
      role: 'detail',
      occlusionGroup: null,
      color: '#ffffff',
      positions,
      normals: positions.map((_, i) => (i % 3 === 1 ? 1 : 0)),
      indices,
      colors: positions.map((_, i) => (i % 3 === 0 ? 1 : 0)),
    };
    const original: GeneratedTerrainAsset = {
      parts: [part],
      physics: {
        assetId: 'precision-ground',
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1001, y: 0, z: 1 } },
        colliders: [
          {
            id: 'solid',
            kind: 'mesh',
            vertices: [...positions],
            indices: [...indices],
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            friction: 0.6,
            restitution: 0.05,
          },
        ],
      },
    };
    const indexed = indexTerrainAsset(original),
      rendered = indexed.parts[0];
    const physics = indexed.physics.colliders[0];
    if (physics.kind !== 'mesh') throw new Error('Mesh fixture required');
    expect(rendered.indices[0]).toBe(rendered.indices[3]);
    expect(physics.indices[0]).not.toBe(physics.indices[3]);
    expect(rendered.indices[6]).not.toBe(rendered.indices[9]);
    expect(physics.indices[6]).not.toBe(physics.indices[9]);
    expect(Object.is(rendered.positions[rendered.indices[9] * 3], -0)).toBe(true);
    expect(Object.is(physics.vertices[physics.indices[9] * 3], -0)).toBe(true);
    expect(renderHash(indexed.parts)).toBe(renderHash(original.parts));
    expect(colliderHash(indexed)).toBe(colliderHash(original));
  });
});
