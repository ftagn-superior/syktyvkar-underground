import type { Vec3 } from './simulation.js';

/** Metres, Y up; rows increase Z, columns increase X. Diagonal: NW to SE. */
export interface TerrainGrid {
  formatVersion: 1;
  origin: { x: number; z: number };
  spacing: number;
  columns: number;
  rows: number;
  heights: number[];
  bottom: number;
}
export interface TerrainSource {
  heightfield: string;
  surfaces: string;
  anchors: string;
}
export type TerrainTriangle = readonly [Vec3, Vec3, Vec3];

export function validateTerrainGrid(value: unknown): TerrainGrid {
  const g = value as TerrainGrid;
  if (
    !g ||
    g.formatVersion !== 1 ||
    !g.origin ||
    ![g.origin.x, g.origin.z, g.spacing, g.bottom].every(Number.isFinite) ||
    g.spacing <= 0 ||
    !Number.isInteger(g.columns) ||
    !Number.isInteger(g.rows) ||
    g.columns < 2 ||
    g.rows < 2 ||
    g.columns * g.rows > 1_000_000 ||
    !Array.isArray(g.heights) ||
    g.heights.length !== g.columns * g.rows ||
    !g.heights.every((h) => Number.isFinite(h) && h > g.bottom) ||
    !Number.isFinite(g.origin.x + (g.columns - 1) * g.spacing) ||
    !Number.isFinite(g.origin.z + (g.rows - 1) * g.spacing)
  )
    throw new Error('Invalid terrain grid');
  return g;
}

export function terrainVertex(g: TerrainGrid, column: number, row: number): Vec3 {
  return {
    x: g.origin.x + column * g.spacing,
    y: g.heights[row * g.columns + column],
    z: g.origin.z + row * g.spacing,
  };
}
/** Upward winding in the right-handed X/Y/Z system. */
export function terrainCellTriangles(g: TerrainGrid, x: number, z: number): TerrainTriangle[] {
  const a = terrainVertex(g, x, z),
    b = terrainVertex(g, x + 1, z),
    c = terrainVertex(g, x + 1, z + 1),
    d = terrainVertex(g, x, z + 1);
  return [
    [a, c, b],
    [a, d, c],
  ];
}
export function terrainNormal([a, b, c]: TerrainTriangle): Vec3 {
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z },
    v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
  const length = Math.hypot(n.x, n.y, n.z);
  return { x: n.x / length, y: n.y / length, z: n.z / length };
}
export function terrainPlaneHeight(t: TerrainTriangle, x: number, z: number): number {
  const n = terrainNormal(t),
    a = t[0];
  return a.y - (n.x * (x - a.x) + n.z * (z - a.z)) / n.y;
}
/** Closed outer boundary. Interior grid edges choose the cell on +X/+Z;
 * the diagonal itself chooses triangle 0. No clamping outside the surface. */
export function sampleTerrain(g: TerrainGrid, x: number, z: number) {
  const u = (x - g.origin.x) / g.spacing,
    v = (z - g.origin.z) / g.spacing;
  if (
    !Number.isFinite(u) ||
    !Number.isFinite(v) ||
    u < 0 ||
    v < 0 ||
    u > g.columns - 1 ||
    v > g.rows - 1
  )
    return undefined;
  const column = Math.min(g.columns - 2, Math.floor(u)),
    row = Math.min(g.rows - 2, Math.floor(v));
  const triangleIndex = v - row <= u - column ? 0 : 1;
  const triangle = terrainCellTriangles(g, column, row)[triangleIndex];
  return {
    height: terrainPlaneHeight(triangle, x, z),
    normal: terrainNormal(triangle),
    column,
    row,
    triangleIndex,
    triangle,
  };
}
/** Area-weighted global node normals, shared by all publication tiles. */
export function terrainVertexNormals(g: TerrainGrid): Vec3[] {
  const normals = g.heights.map(() => ({ x: 0, y: 0, z: 0 }));
  for (let z = 0; z < g.rows - 1; z++)
    for (let x = 0; x < g.columns - 1; x++) {
      const ids = [
        z * g.columns + x,
        z * g.columns + x + 1,
        (z + 1) * g.columns + x + 1,
        (z + 1) * g.columns + x,
      ];
      terrainCellTriangles(g, x, z).forEach((t, i) => {
        const n = terrainNormal(t),
          area = g.spacing ** 2 / n.y;
        for (const id of i === 0 ? [ids[0], ids[2], ids[1]] : [ids[0], ids[3], ids[2]]) {
          normals[id].x += n.x * area;
          normals[id].y += n.y * area;
          normals[id].z += n.z * area;
        }
      });
    }
  return normals.map((n) => {
    const length = Math.hypot(n.x, n.y, n.z);
    return { x: n.x / length, y: n.y / length, z: n.z / length };
  });
}
