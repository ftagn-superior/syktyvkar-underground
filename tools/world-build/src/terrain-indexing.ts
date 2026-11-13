import type { BuildingPhysicsAsset } from '@su/contracts';
import type { GeneratedTerrainAsset, StaticMeshPart } from '@su/terrain-build';

/** Index attributes exactly as emitted by the GLB writer, including signed zero. */
function indexPart(part: StaticMeshPart): StaticMeshPart {
  const values = new Float32Array(part.colors ? 9 : 6),
    bits = new Uint32Array(values.buffer),
    lookup = new Map<string, number>(),
    positions: number[] = [],
    normals: number[] = [],
    colors: number[] | undefined = part.colors ? [] : undefined,
    indices: number[] = [];
  for (const index of part.indices) {
    for (let axis = 0; axis < 3; axis++) {
      values[axis] = part.positions[index * 3 + axis];
      values[axis + 3] = part.normals[index * 3 + axis];
      if (colors) values[axis + 6] = part.colors![index * 3 + axis];
    }
    const key = bits.join(',');
    let id = lookup.get(key);
    if (id === undefined) {
      id = lookup.size;
      lookup.set(key, id);
      for (let axis = 0; axis < 3; axis++) {
        positions.push(values[axis]);
        normals.push(values[axis + 3]);
        if (colors) colors.push(values[axis + 6]);
      }
    }
    indices.push(id);
  }
  return { ...part, positions, normals, indices, ...(colors ? { colors } : {}) };
}

function indexCollider(
  collider: BuildingPhysicsAsset['colliders'][number],
): BuildingPhysicsAsset['colliders'][number] {
  if (collider.kind !== 'mesh') return collider;
  const values = new Float64Array(3),
    bits = new Uint32Array(values.buffer),
    lookup = new Map<string, number>(),
    vertices: number[] = [],
    indices: number[] = [];
  for (const index of collider.indices) {
    for (let axis = 0; axis < 3; axis++) values[axis] = collider.vertices[index * 3 + axis];
    const key = bits.join(',');
    let id = lookup.get(key);
    if (id === undefined) {
      id = lookup.size;
      lookup.set(key, id);
      vertices.push(values[0], values[1], values[2]);
    }
    indices.push(id);
  }
  return { ...collider, vertices, indices };
}

/**
 * Share identical vertices without changing the ordered triangle attribute streams.
 * Graphics use their serialized Float32 attributes; physics retains exact Number coordinates.
 * This belongs to bounded city publication, leaving the base terrain generator unchanged.
 */
export function indexTerrainAsset(asset: GeneratedTerrainAsset): GeneratedTerrainAsset {
  return {
    parts: asset.parts.map(indexPart),
    physics: { ...asset.physics, colliders: asset.physics.colliders.map(indexCollider) },
  };
}
