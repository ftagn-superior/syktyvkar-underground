import assert from 'node:assert/strict';
import { sampleTerrain, type TerrainGrid, type WorldDefinition } from '@su/contracts';
import { patchRange, rectangle, terrainPatch } from '@su/terrain-build';

/** Explicit release authoring. Each boundary remains solid below the entire local surface. */
export function ringTerrainBoundaries(world: WorldDefinition, grid: TerrainGrid) {
  const result: WorldDefinition['entities'] = [];
  for (const original of world.entities) {
    assert.ok(
      /^boundary-(north|south|east|west)$/.test(original.entityId),
      'Unexpected source primitive',
    );
    const axis = original.size.x > original.size.z ? 'x' : 'z';
    const length = original.size[axis],
      segments = Math.ceil(length / 16);
    for (let i = 0; i < segments; i++) {
      const segment = structuredClone(original);
      segment.entityId = `${original.entityId}-${i}`;
      segment.size[axis] = length / segments;
      segment.position[axis] =
        original.position[axis] - length / 2 + (i + 0.5) * segment.size[axis];
      const patch = terrainPatch(
        grid,
        rectangle(segment.position.x, segment.position.z, segment.size.x, segment.size.z),
      );
      assert.ok(patch.length);
      const top = patchRange(patch).max + 1.5;
      segment.position.y = (top + grid.bottom) / 2;
      segment.size.y = top - grid.bottom;
      result.push(segment);
    }
  }
  return result;
}

export function terrainHeight(grid: TerrainGrid, p: { x: number; z: number }) {
  const sample = sampleTerrain(grid, p.x, p.z);
  assert.ok(sample, 'Authored point is outside the terrain');
  return sample.height;
}
