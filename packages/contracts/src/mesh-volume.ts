import type { Vec3 } from './simulation.js';

/**
 * A collision mesh describes closed, outward-oriented solid shells. Weld coincident
 * face vertices, but preserve indexed shell boundaries at shared edges. Ambiguous
 * coincident surfaces that cannot be separated into closed shells are rejected.
 */
export function validateClosedMeshTopology(vertices: number[], indices: number[]): boolean {
  if (
    vertices.length < 12 ||
    vertices.length % 3 !== 0 ||
    indices.length < 12 ||
    indices.length % 3 !== 0
  )
    return false;
  if (!vertices.every(Number.isFinite)) return false;
  const welded = new Map<string, number>();
  const vertexIds: number[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    const key = vertices
      .slice(i, i + 3)
      .map((value) => Math.round(value * 1e6))
      .join(',');
    let id = welded.get(key);
    if (id === undefined) {
      id = welded.size;
      welded.set(key, id);
    }
    vertexIds.push(id);
  }
  type Edge = { count: number; balance: number; first: number; second: number };
  const edges = new Map<string, Edge>();
  const indexedEdges = new Map<string, Edge>();
  const parent = Array.from({ length: indices.length / 3 }, (_, index) => index);
  const triangleVolumes: number[] = [];
  const component = (triangle: number): number => {
    while (parent[triangle] !== triangle) {
      parent[triangle] = parent[parent[triangle]];
      triangle = parent[triangle];
    }
    return triangle;
  };
  const addEdge = (map: Map<string, Edge>, from: number, to: number, triangle: number) => {
    const key = `${Math.min(from, to)}:${Math.max(from, to)}`;
    const record = map.get(key) ?? { count: 0, balance: 0, first: triangle, second: triangle };
    record.count++;
    record.balance += from < to ? 1 : -1;
    record.second = triangle;
    map.set(key, record);
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i],
      b = indices[i + 1],
      c = indices[i + 2];
    if (
      ![a, b, c].every((index) => Number.isInteger(index) && index >= 0 && index < vertexIds.length)
    )
      return false;
    const original = [a, b, c];
    const ids = original.map((index) => vertexIds[index]);
    if (new Set(ids).size !== 3) return false;
    for (let edge = 0; edge < 3; edge++) {
      addEdge(edges, ids[edge], ids[(edge + 1) % 3], i / 3);
      addEdge(indexedEdges, original[edge], original[(edge + 1) % 3], i / 3);
    }
    const ax = vertices[a * 3],
      ay = vertices[a * 3 + 1],
      az = vertices[a * 3 + 2];
    const bx = vertices[b * 3],
      by = vertices[b * 3 + 1],
      bz = vertices[b * 3 + 2];
    const cx = vertices[c * 3],
      cy = vertices[c * 3 + 1],
      cz = vertices[c * 3 + 2];
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az;
    const vx = cx - ax,
      vy = cy - ay,
      vz = cz - az;
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) <= 1e-10) return false;
    triangleVolumes.push(
      ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx),
    );
  }
  if (![...edges.values()].every(({ count, balance }) => count >= 2 && balance === 0)) return false;
  // A shared edge may have four uses from two touching solids. Unambiguous welded
  // edges connect split face vertices; indexed edges retain authored shell identity.
  for (const map of [edges, indexedEdges])
    for (const { count, first, second } of map.values())
      if (count === 2) parent[component(second)] = component(first);
  edges.clear();
  indexedEdges.clear();
  const volumes = new Map<number, number>();
  const shellEdges = new Map<string, { count: number; balance: number }>();
  for (let i = 0; i < indices.length; i += 3) {
    const shell = component(i / 3);
    volumes.set(shell, (volumes.get(shell) ?? 0) + triangleVolumes[i / 3]);
    for (let edge = 0; edge < 3; edge++) {
      const from = vertexIds[indices[i + edge]],
        to = vertexIds[indices[i + ((edge + 1) % 3)]];
      const key = `${shell}:${Math.min(from, to)}:${Math.max(from, to)}`;
      const record = shellEdges.get(key) ?? { count: 0, balance: 0 };
      record.count++;
      record.balance += from < to ? 1 : -1;
      shellEdges.set(key, record);
    }
  }
  return (
    [...volumes.values()].every((volume) => volume > 1e-9) &&
    [...shellEdges.values()].every(({ count, balance }) => count >= 2 && balance === 0)
  );
}

/**
 * Placement safety for a validated solid mesh, not a replacement collision solver.
 * Winding numbers preserve the union of overlapping positive solid components;
 * simple ray parity would incorrectly treat their overlap as empty.
 */
export function pointInsideClosedMesh(point: Vec3, vertices: number[], indices: number[]): boolean {
  let solidAngle = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    const ax = vertices[a] - point.x,
      ay = vertices[a + 1] - point.y,
      az = vertices[a + 2] - point.z;
    const bx = vertices[b] - point.x,
      by = vertices[b + 1] - point.y,
      bz = vertices[b + 2] - point.z;
    const cx = vertices[c] - point.x,
      cy = vertices[c + 1] - point.y,
      cz = vertices[c + 2] - point.z;
    const la = Math.hypot(ax, ay, az),
      lb = Math.hypot(bx, by, bz),
      lc = Math.hypot(cx, cy, cz);
    if (Math.min(la, lb, lc) < 1e-9) return true;
    const determinant =
      ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const denominator =
      la * lb * lc +
      (ax * bx + ay * by + az * bz) * lc +
      (bx * cx + by * cy + bz * cz) * la +
      (cx * ax + cy * ay + cz * az) * lb;
    solidAngle += 2 * Math.atan2(determinant, denominator);
  }
  return Math.abs(solidAngle) > 2 * Math.PI;
}
