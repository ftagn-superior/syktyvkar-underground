import assert from 'node:assert/strict';
import {
  sampleTerrain,
  type TerrainGrid,
  type WorldDefinition,
  type BuildingInstance,
  type Landmark,
} from '@su/contracts';
import { patchRange, rectangle, terrainPatch } from '@su/terrain-build';

/** Explicit release authoring. Each boundary remains solid below the entire local surface. */
export function ringTerrainBoundaries(
  world: WorldDefinition,
  grid: TerrainGrid,
  options: { insetMetres?: number } = {},
) {
  const inset = options.insetMetres ?? 0;
  assert.ok(Number.isFinite(inset) && inset >= 0, 'Invalid boundary inset');
  const result: WorldDefinition['entities'] = [];
  for (const original of world.entities) {
    assert.ok(
      /^boundary-(north|south|east|west)$/.test(original.entityId),
      'Unexpected source primitive',
    );
    const axis = original.size.x > original.size.z ? 'x' : 'z';
    const normal = axis === 'x' ? 'z' : 'x';
    assert.ok(inset < original.size[normal] / 2 && 2 * inset < original.size[axis]);
    const sign =
      Math.abs(original.position[normal] - world.bounds.min[normal]) <
      Math.abs(original.position[normal] - world.bounds.max[normal])
        ? -1
        : 1;
    const length = original.size[axis] - 2 * inset,
      segments = Math.ceil(length / 16);
    for (let i = 0; i < segments; i++) {
      const segment = structuredClone(original);
      segment.entityId = `${original.entityId}-${i}`;
      // All exterior faces, including end caps, sit inside the terrain skirt.
      // Adjacent perpendicular walls still overlap by their full thickness.
      segment.position[normal] -= sign * inset;
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

/** Authored label bindings keep roof labels above the same rigid model after its Y move. */
export function ringTerrainLandmarks(
  landmarks: Landmark[],
  owners: BuildingInstance[],
  targetY: Record<string, number>,
  grid: TerrainGrid,
): Landmark[] {
  const bindings: Record<string, string> = {
    ring: 'monument-trudovaya-slava',
    'school-1': 'osm-way-111538131',
    'banya-4': 'osm-way-111493596',
    'opera-theatre': 'osm-way-146724915',
    syktsu: 'osm-way-1258973447',
  };
  return landmarks.map((landmark) => {
    const ownerId = bindings[landmark.id];
    let delta: number;
    if (ownerId) {
      const owner = owners.find((o) => o.entityId === ownerId);
      assert.ok(owner && Number.isFinite(targetY[ownerId]), `Missing label owner: ${ownerId}`);
      assert.ok(
        Math.hypot(owner.position.x - landmark.position.x, owner.position.z - landmark.position.z) <
          0.01,
        'Landmark binding has changed',
      );
      delta = targetY[ownerId] - owner.position.y;
    } else {
      assert.equal(landmark.id, 'theatre-square', 'Unreviewed terrain landmark');
      delta = terrainHeight(grid, landmark.position);
    }
    return { ...landmark, position: { ...landmark.position, y: landmark.position.y + delta } };
  });
}
