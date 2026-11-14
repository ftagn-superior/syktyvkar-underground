import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORLD_RESOURCE_LIMITS, type TerrainGrid } from '../../packages/contracts/src/index.js';
import { encodeStaticGlb, inspectStaticGlb } from '../../packages/terrain-build/src/glb.js';
import {
  generateTerrainTile,
  prepareTerrainBuildContext,
  rectangle,
  type TerrainSurface,
} from '../../packages/terrain-build/src/terrain.js';
import { mergeParts } from '../../tools/world-build/src/merge.js';
import { buildTerrainTiles, indexTerrainAsset } from '../../tools/world-build/src/terrain-tiles.js';

const grid: TerrainGrid = {
  formatVersion: 1,
  origin: { x: 0, z: 0 },
  spacing: 2,
  columns: 65,
  rows: 65,
  heights: Array(65 * 65).fill(0),
  bottom: -1,
};
const baseColor = '#d9cbb1';
const linear = (hex: string) =>
  [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
// Inspect the actual Float32 arrays read back from the saved GLB, not generator arrays.
function decode(bytes: Uint8Array, assetId: string) {
  const document = inspectStaticGlb(bytes, assetId).document;
  const buffer = Buffer.from(bytes),
    binaryOffset = 28 + buffer.readUInt32LE(12);
  const array = (index: number): number[] => {
    const accessor = document.accessors[index],
      view = document.bufferViews[accessor.bufferView];
    const width = accessor.type === 'VEC3' ? 3 : 1;
    const offset = binaryOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    return Array.from({ length: accessor.count * width }, (_, i) =>
      accessor.componentType === 5126
        ? buffer.readFloatLE(offset + i * 4)
        : buffer.readUInt32LE(offset + i * 4),
    );
  };
  expect(document.meshes).toHaveLength(1);
  const primitive = document.meshes[0].primitives[0];
  return {
    document,
    positions: array(primitive.attributes.POSITION),
    normals: array(primitive.attributes.NORMAL),
    colors:
      primitive.attributes.COLOR_0 === undefined ? undefined : array(primitive.attributes.COLOR_0),
    indices: array(primitive.indices),
  };
}
function horizontalAreas(positions: number[], indices: number[], normals?: number[]) {
  const areas = new Map<number, number>();
  for (let i = 0; i < indices.length; i += 3) {
    const ids = indices.slice(i, i + 3),
      height = positions[ids[0] * 3 + 1];
    if (
      !ids.every((id) => Math.abs(positions[id * 3 + 1] - height) < 1e-6) ||
      (normals && !ids.every((id) => normals[id * 3 + 1] > 0.99))
    )
      continue;
    const [a, b, c] = ids.map((id) => [positions[id * 3], positions[id * 3 + 2]]);
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    const key = Math.round(height * 1000) / 1000;
    areas.set(key, (areas.get(key) ?? 0) + area);
  }
  return areas;
}

describe('terrain resources inside unchanged publication cells', () => {
  it('retains visible outer skirts when the world edge cuts through the sample halo', () => {
    const boundary = rectangle(64, 64, 126, 126);
    const worldBounds = { min: { x: 1, z: 1 }, max: { x: 127, z: 127 } };
    const result = generateTerrainTile('halo', grid, boundary, [], undefined, { worldBounds });
    const part = result.parts[0];
    for (const axis of [0, 2])
      for (const coordinate of [1, 127]) {
        let skirtTriangles = 0;
        for (let i = 0; i < part.indices.length; i += 3) {
          const ids = part.indices.slice(i, i + 3);
          if (
            ids.every((id) => part.positions[id * 3 + axis] === coordinate) &&
            ids.some((id) => part.positions[id * 3 + 1] === grid.bottom)
          )
            skirtTriangles++;
        }
        expect(skirtTriangles).toBeGreaterThan(0);
      }
  });

  it('splits a naturally oversized cell and preserves saved colors, areas, collision and seams', async () => {
    const surfaces: TerrainSurface[] = Array.from({ length: 20 }, (_, index) => ({
      id: `layer-${index}`,
      outline: rectangle(64, 64, 128, 128),
      color: ['#9eb747', '#706d68', '#f3e7ce'][index % 3],
      offset: (index + 1) / 500,
    }));
    const expectedColors = [linear(baseColor), ...surfaces.map((surface) => linear(surface.color))];
    const context = prepareTerrainBuildContext(grid, surfaces),
      boundary = rectangle(62.5, 62.5, 125, 125);
    const oversized = generateTerrainTile('large-ground', grid, boundary, surfaces, context, {
      baseColor,
    });
    // A single original part exceeds the argument-count limit of spread into push.
    expect(oversized.parts[0].positions.length).toBeGreaterThan(125_000);
    const unsplit = encodeStaticGlb(
      indexTerrainAsset({
        ...oversized,
        parts: mergeParts(oversized.parts),
      }).parts,
    );
    expect(unsplit.byteLength).toBeGreaterThan(WORLD_RESOURCE_LIMITS.modelBytes);
    const result = buildTerrainTiles({
      assetId: 'large-ground',
      grid,
      surfaces,
      context,
      boundary,
      color: baseColor,
      merge: true,
    });
    expect(result.length).toBeGreaterThan(1);
    const directory = await mkdtemp(join(tmpdir(), 'terrain-tiles-'));
    const totalVisual = new Map<number, number>();
    let collisionArea = 0,
      maxColorError = 0;
    const decoded: { asset: (typeof result)[number]['asset']; mesh: ReturnType<typeof decode> }[] =
      [];
    try {
      for (const { suffix, asset } of result) {
        expect(suffix).not.toBe('');
        expect(asset.model!.byteLength).toBeLessThanOrEqual(WORLD_RESOURCE_LIMITS.modelBytes);
        expect(asset.collision.byteLength).toBeLessThanOrEqual(
          WORLD_RESOURCE_LIMITS.collisionBytes,
        );
        expect(asset.parts.byteLength).toBeLessThanOrEqual(WORLD_RESOURCE_LIMITS.partsBytes);
        expect(asset.bounds.min.x).toBeGreaterThanOrEqual(0);
        expect(asset.bounds.min.z).toBeGreaterThanOrEqual(0);
        expect(asset.bounds.max.x).toBeLessThanOrEqual(125);
        expect(asset.bounds.max.z).toBeLessThanOrEqual(125);
        const path = join(directory, `ground${suffix}.glb`);
        await writeFile(path, asset.model!);
        const mesh = decode(await readFile(path), asset.physics.assetId);
        decoded.push({ asset, mesh });
        expect(mesh.colors).toBeDefined();
        expect(mesh.document.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([
          1, 1, 1, 1,
        ]);
        for (const [height, area] of horizontalAreas(mesh.positions, mesh.indices, mesh.normals))
          totalVisual.set(height, (totalVisual.get(height) ?? 0) + area);
        for (let index = 0; index < mesh.positions.length / 3; index++) {
          if (mesh.normals[index * 3 + 1] < 0.99) continue;
          const layer = Math.round(mesh.positions[index * 3 + 1] * 500);
          const expected = expectedColors[layer];
          for (let axis = 0; axis < 3; axis++)
            maxColorError = Math.max(
              maxColorError,
              Math.abs(mesh.colors![index * 3 + axis] - expected[axis]),
            );
        }
        for (const collider of asset.physics.colliders) {
          expect(collider.kind).toBe('mesh');
          if (collider.kind !== 'mesh') continue;
          expect(collider.vertices.length).toBeLessThanOrEqual(600_000);
          expect(collider.indices.length).toBeLessThanOrEqual(600_000);
          collisionArea += horizontalAreas(collider.vertices, collider.indices).get(0) ?? 0;
        }
      }
      expect(maxColorError).toBeLessThan(1e-6);
      expect([...totalVisual.keys()].sort((a, b) => a - b)).toEqual([
        0,
        ...surfaces.map((surface) => surface.offset),
      ]);
      for (const area of totalVisual.values()) expect(area).toBeCloseTo(125 * 125, 4);
      expect(collisionArea).toBeCloseTo(125 * 125, 4);
      const neighbors = decoded.flatMap((a) =>
        decoded
          .filter(
            (b) =>
              a.asset.bounds.max.x === b.asset.bounds.min.x &&
              a.asset.bounds.min.z === b.asset.bounds.min.z &&
              a.asset.bounds.max.z === b.asset.bounds.max.z,
          )
          .map((b) => [a, b] as const),
      );
      expect(neighbors.length).toBeGreaterThan(0);
      const [left, right] = neighbors[0],
        seamX = left.asset.bounds.max.x;
      const seam = (mesh: typeof left.mesh) => {
        const values = new Set<string>();
        for (let i = 0; i < mesh.positions.length; i += 3)
          if (
            mesh.positions[i] === seamX &&
            mesh.positions[i + 1] === 0 &&
            mesh.normals[i + 1] > 0.99
          )
            values.add(`${mesh.positions[i + 2]}:${mesh.normals.slice(i, i + 3).join(',')}`);
        return [...values].sort();
      };
      expect(seam(left.mesh).length).toBeGreaterThan(2);
      expect(seam(left.mesh)).toEqual(seam(right.mesh));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps a one metre outer strip and the requested base material without unnecessary subdivision', () => {
    const surfaces: TerrainSurface[] = [],
      context = prepareTerrainBuildContext(grid, surfaces);
    const result = buildTerrainTiles({
      assetId: 'thin-ground',
      grid,
      surfaces,
      context,
      boundary: rectangle(62.5, 127.5, 125, 1),
      color: baseColor,
      merge: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].suffix).toBe('');
    const mesh = decode(result[0].asset.model!, 'thin-ground');
    expect(mesh.colors).toBeUndefined();
    expect(mesh.document.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([
      ...linear(baseColor),
      1,
    ]);
    expect(horizontalAreas(mesh.positions, mesh.indices, mesh.normals).get(0)).toBeCloseTo(125, 5);
    expect(result[0].asset.bounds).toMatchObject({
      min: { x: 0, z: 127 },
      max: { x: 125, z: 128 },
    });
  });
});
