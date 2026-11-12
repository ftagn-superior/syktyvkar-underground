import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { Vec3 } from '@su/contracts';

/** Small planar bevels catch the sun while keeping the exact physical envelope. */
export function createBeveledBox(name: string, size: Vec3, bevel: number, scene: Scene): Mesh {
  const half = [size.x / 2, size.y / 2, size.z / 2];
  const radius = Math.min(bevel, ...half.map((value) => value * 0.45));
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const face = (points: number[][], normal: number[]) => {
    const first = positions.length / 3;
    const a = points[1].map((value, i) => value - points[0][i]);
    const b = points[2].map((value, i) => value - points[0][i]);
    const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    if (cross.reduce((sum, value, i) => sum + value * normal[i], 0) < 0) points.reverse();
    const length = Math.hypot(...normal);
    for (const point of points) {
      positions.push(...point);
      normals.push(...normal.map((value) => value / length));
    }
    for (let i = 1; i < points.length - 1; i++) indices.push(first, first + i, first + i + 1);
  };
  // Six large faces, twelve edge strips, eight corner triangles: 44 triangles total.
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3,
      v = (axis + 2) % 3;
    for (const sign of [-1, 1]) {
      const normal = [0, 0, 0];
      normal[axis] = sign;
      face(
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([su, sv]) => {
          const point = [0, 0, 0];
          point[axis] = sign * half[axis];
          point[u] = su * (half[u] - radius);
          point[v] = sv * (half[v] - radius);
          return point;
        }),
        normal,
      );
    }
    for (const su of [-1, 1])
      for (const sv of [-1, 1]) {
        const normal = [0, 0, 0];
        normal[u] = su;
        normal[v] = sv;
        face(
          [
            [-1, false],
            [1, false],
            [1, true],
            [-1, true],
          ].map(([end, inset]) => {
            const point = [0, 0, 0];
            point[axis] = Number(end) * (half[axis] - radius);
            point[u] = su * (half[u] - (inset ? radius : 0));
            point[v] = sv * (half[v] - (inset ? 0 : radius));
            return point;
          }),
          normal,
        );
      }
  }
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      for (const z of [-1, 1]) {
        const signs = [x, y, z];
        face(
          [0, 1, 2].map((axis) =>
            half.map((value, i) => signs[i] * (value - (i === axis ? 0 : radius))),
          ),
          signs,
        );
      }
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = Array((positions.length / 3) * 2).fill(0);
  // Match Babylon MeshBuilder winding so these faces can merge with its primitives.
  data.indices = indices.reduce<number[]>((result, _, i) => {
    if (i % 3 === 0) result.push(indices[i], indices[i + 2], indices[i + 1]);
    return result;
  }, []);
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh);
  return mesh;
}
