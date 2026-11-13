import {
  sampleTerrain,
  terrainCellTriangles,
  terrainPlaneHeight,
  terrainVertexNormals,
  type TerrainGrid,
  type TerrainTriangle,
  type BuildingPhysicsAsset,
  type Vec3,
} from '@su/contracts';
import { addFace, meshPart } from './house.js';
import { signedArea, triangulate, type Point2 } from './triangulate.js';
import type { StaticMeshPart } from './glb.js';

export interface TerrainSurface {
  id: string;
  outline: Point2[];
  holes?: Point2[][];
  color: string;
  /** Absolute offset above terrain, including the underlying road for markings. */
  offset: number;
}
export type GeneratedTerrainAsset = { parts: StaticMeshPart[]; physics: BuildingPhysicsAsset };
const key = (p: Vec3) => `${Math.round(p.x * 1e8)},${Math.round(p.z * 1e8)}`;
const cross = (a: Point2, b: Point2, c: Point2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const point = (v: Vec3): Point2 => [v.x, v.z];

/** Convex polygon intersection; keep intermediate boundary vertices for watertight solids. */
function clip(subject: Point2[], boundary: readonly Point2[]): Point2[] {
  const ring = signedArea(boundary) < 0 ? [...boundary].reverse() : boundary;
  let out = subject;
  for (let e = 0; e < ring.length; e++) {
    const a = ring[e],
      b = ring[(e + 1) % ring.length],
      input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[(i + input.length - 1) % input.length],
        q = input[i];
      const cp = cross(a, b, p),
        cq = cross(a, b, q);
      if (cp < -1e-10 !== cq < -1e-10) {
        const t = cp / (cp - cq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
      if (cq >= -1e-10) out.push(q);
    }
    out = out.filter(
      (p, i) =>
        Math.hypot(
          p[0] - out[(i + out.length - 1) % out.length][0],
          p[1] - out[(i + out.length - 1) % out.length][1],
        ) > 1e-9,
    );
  }
  return out.length >= 3 && Math.abs(signedArea(out)) > 1e-10 ? out : [];
}

/** Intersection with the final terrain triangles, never a separately sampled surface. */
export function terrainPatch(g: TerrainGrid, convex: readonly Point2[]): TerrainTriangle[] {
  const output: TerrainTriangle[] = [];
  for (let row = 0; row < g.rows - 1; row++)
    for (let col = 0; col < g.columns - 1; col++)
      for (const t of terrainCellTriangles(g, col, row)) {
        const polygon = clip(t.map(point), convex);
        if (!polygon.length) continue;
        const vertices = polygon.map(([x, z]) => ({ x, y: terrainPlaneHeight(t, x, z), z }));
        // Preserve every cut vertex. A centre fan also handles collinear boundary nodes.
        if (vertices.length === 3) {
          output.push(vertices as unknown as TerrainTriangle);
          continue;
        }
        const center = vertices.reduce(
          (s, p) => ({
            x: s.x + p.x / vertices.length,
            y: s.y + p.y / vertices.length,
            z: s.z + p.z / vertices.length,
          }),
          { x: 0, y: 0, z: 0 },
        );
        for (let i = 0; i < vertices.length; i++)
          output.push([center, vertices[i], vertices[(i + 1) % vertices.length]]);
      }
  return output;
}

export function rectangle(x: number, z: number, width: number, depth: number, yaw = 0): Point2[] {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ].map(([a, b]) => [x + c * a + s * b, z - s * a + c * b] as Point2);
}

export function patchRange(triangles: TerrainTriangle[]) {
  if (!triangles.length) throw new Error('Terrain footprint has no surface');
  let min = Infinity,
    max = -Infinity;
  for (const triangle of triangles)
    for (const v of triangle) {
      min = Math.min(min, v.y);
      max = Math.max(max, v.y);
    }
  return { min, max };
}

/** A single connected solid, with matching triangulations on both caps and all cut boundary edges. */
export function terrainSolid(
  assetId: string,
  triangles: TerrainTriangle[],
  top: (p: Vec3) => number,
  bottom: (p: Vec3) => number,
  color: string,
): GeneratedTerrainAsset {
  const part = meshPart('solid', 'detail', color);
  part.occlusionGroup = null;
  const edges = new Map<string, { a: Vec3; b: Vec3; count: number }>();
  for (const t of triangles) {
    addFace(
      part,
      t.map((p) => [p.x, top(p), p.z]),
    );
    addFace(
      part,
      [...t].reverse().map((p) => [p.x, bottom(p), p.z]),
    );
    for (let i = 0; i < 3; i++) {
      const a = t[i],
        b = t[(i + 1) % 3],
        ids = [key(a), key(b)].sort().join('/');
      const edge = edges.get(ids);
      if (edge) edge.count++;
      else edges.set(ids, { a, b, count: 1 });
    }
  }
  for (const { a, b, count } of edges.values())
    if (count === 1)
      addFace(part, [
        [b.x, top(b), b.z],
        [a.x, top(a), a.z],
        [a.x, bottom(a), a.z],
        [b.x, bottom(b), b.z],
      ]);
  const bounds = boundsOf([part]);
  return {
    parts: [part],
    physics: {
      assetId,
      bounds,
      colliders: [
        {
          id: 'solid',
          kind: 'mesh',
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          friction: 0.6,
          restitution: 0.05,
          vertices: [...part.positions],
          indices: [...part.indices],
        },
      ],
    },
  };
}

export function boundsOf(parts: StaticMeshPart[]) {
  const min = { x: Infinity, y: Infinity, z: Infinity },
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of parts)
    for (let i = 0; i < p.positions.length; i += 3)
      for (const [j, axis] of (['x', 'y', 'z'] as const).entries()) {
        min[axis] = Math.min(min[axis], p.positions[i + j]);
        max[axis] = Math.max(max[axis], p.positions[i + j]);
      }
  return { min, max };
}

function smoothNormal(g: TerrainGrid, normals: Vec3[], x: number, z: number): number[] {
  const s = sampleTerrain(g, x, z)!;
  const u = (x - g.origin.x) / g.spacing - s.column,
    v = (z - g.origin.z) / g.spacing - s.row;
  const a = s.row * g.columns + s.column;
  const ids =
    s.triangleIndex === 0 ? [a, a + g.columns + 1, a + 1] : [a, a + g.columns, a + g.columns + 1];
  const weights = s.triangleIndex === 0 ? [1 - u, v, u - v] : [1 - v, v - u, u];
  const n = ['x', 'y', 'z'].map((axis) =>
    ids.reduce((sum, id, i) => sum + normals[id][axis as keyof Vec3] * weights[i], 0),
  );
  const length = Math.hypot(...n);
  return n.map((v) => v / length);
}

export function generateTerrainTile(
  assetId: string,
  g: TerrainGrid,
  boundary: Point2[],
  surfaces: TerrainSurface[],
): GeneratedTerrainAsset {
  const triangles = terrainPatch(g, boundary);
  const built = terrainSolid(
    assetId,
    triangles,
    (p) => p.y,
    () => g.bottom,
    '#617658',
  );
  const normals = terrainVertexNormals(g),
    solid = built.parts[0];
  // The solid writer interleaves top and bottom triangles (nine position scalars each).
  for (let i = 0; i < triangles.length; i++)
    for (let j = 0; j < 3; j++)
      solid.normals.splice(
        i * 18 + j * 3,
        3,
        ...smoothNormal(g, normals, triangles[i][j].x, triangles[i][j].z),
      );
  // Adjacent solids retain closed collision shells. Their hidden shared walls
  // must not cast a thin shadow onto the continuous visible surface.
  const internalEdges: { axis: 0 | 2; value: number }[] = [];
  for (const [axis, start, end, values] of [
    [0, g.origin.x, g.origin.x + (g.columns - 1) * g.spacing, boundary.map((p) => p[0])],
    [2, g.origin.z, g.origin.z + (g.rows - 1) * g.spacing, boundary.map((p) => p[1])],
  ] as const)
    for (const value of [Math.min(...values), Math.max(...values)])
      if (value > start + 1e-8 && value < end - 1e-8) internalEdges.push({ axis, value });
  const kept: number[] = [];
  for (let i = 0; i < solid.indices.length; i += 3) {
    const face = solid.indices.slice(i, i + 3);
    if (
      !internalEdges.some((edge) =>
        face.every((id) => Math.abs(solid.positions[id * 3 + edge.axis] - edge.value) < 1e-8),
      )
    )
      kept.push(...face);
  }
  const remap = new Map<number, number>(),
    positions: number[] = [],
    vertexNormals: number[] = [],
    indices: number[] = [];
  for (const id of kept) {
    if (!remap.has(id)) {
      remap.set(id, remap.size);
      positions.push(...solid.positions.slice(id * 3, id * 3 + 3));
      vertexNormals.push(...solid.normals.slice(id * 3, id * 3 + 3));
    }
    indices.push(remap.get(id)!);
  }
  solid.positions = positions;
  solid.normals = vertexNormals;
  solid.indices = indices;
  for (const surface of [...surfaces].sort(
    (a, b) => a.offset - b.offset || a.id.localeCompare(b.id),
  )) {
    const shape = triangulate(surface.outline, surface.holes);
    if (Math.abs(shape.coverage - 1) > 1e-6)
      throw new Error(`Invalid terrain surface ${surface.id}`);
    const part = meshPart(surface.id, 'detail', surface.color);
    part.occlusionGroup = null;
    for (let i = 0; i < shape.triangles.length; i += 3) {
      const polygon = clip(
        shape.triangles.slice(i, i + 3).map((id) => shape.points[id]),
        boundary,
      );
      if (!polygon.length) continue;
      for (const t of terrainPatch(g, polygon)) {
        const start = part.normals.length;
        addFace(
          part,
          t.map((p) => [p.x, p.y + surface.offset, p.z]),
        );
        for (let j = 0; j < 3; j++)
          part.normals.splice(start + j * 3, 3, ...smoothNormal(g, normals, t[j].x, t[j].z));
      }
    }
    if (part.indices.length) built.parts.push(part);
  }
  built.physics.bounds = boundsOf(built.parts);
  return built;
}

/** Contour segments extracted from the published triangulation. */
export function terrainContours(g: TerrainGrid, height: number): Point2[][] {
  const segments: Point2[][] = [];
  for (let z = 0; z < g.rows - 1; z++)
    for (let x = 0; x < g.columns - 1; x++)
      for (const triangle of terrainCellTriangles(g, x, z)) {
        const hits: Point2[] = [];
        for (let i = 0; i < 3; i++) {
          const a = triangle[i],
            b = triangle[(i + 1) % 3];
          if ((a.y <= height && b.y > height) || (b.y <= height && a.y > height)) {
            const t = (height - a.y) / (b.y - a.y);
            hits.push([a.x + t * (b.x - a.x), a.z + t * (b.z - a.z)]);
          }
        }
        if (hits.length === 2) segments.push(hits);
      }
  return segments;
}
