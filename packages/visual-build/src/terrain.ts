import { meshPart, type StaticMeshPart } from '@su/terrain-build/mesh';
import { triangulate } from '@su/terrain-build/triangulate';

type Point = [number, number, number];
type Triangle = [number, number, number];
const cross = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
function height(p: Point, a: Point, b: Point, c: Point): number | undefined {
  const area = cross(a, b, c);
  if (Math.abs(area) < 1e-10) return;
  const u = cross(p, b, c) / area,
    v = cross(a, p, c) / area,
    w = 1 - u - v;
  if (Math.min(u, v, w) < -1e-7) return;
  return u * a[1] + v * b[1] + w * c[1];
}
/** Max difference of two piecewise linear surfaces occurs at overlay vertices,
 * including every intersection between new and old edges (not only input samples). */
type FaceInfo = {
  points: Point[];
  bounds: [number, number, number, number];
  plane: [number, number, number];
};
function faceInfo(points: Point[], face: Triangle, cache: WeakMap<Triangle, FaceInfo>): FaceInfo {
  let info = cache.get(face);
  if (info) return info;
  const vertices = face.map((i) => points[i]),
    [a, b, c] = vertices,
    area = cross(a, b, c);
  const x = ((b[1] - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (b[2] - a[2])) / area;
  const z = ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / area;
  info = {
    points: vertices,
    bounds: [
      Math.min(a[0], b[0], c[0]),
      Math.max(a[0], b[0], c[0]),
      Math.min(a[2], b[2], c[2]),
      Math.max(a[2], b[2], c[2]),
    ],
    plane: [x, z, a[1] - x * a[0] - z * a[2]],
  };
  cache.set(face, info);
  return info;
}
export function terrainReplacementError(
  points: Point[],
  before: Triangle[],
  after: Triangle[],
  limit = Infinity,
  cache = new WeakMap<Triangle, FaceInfo>(),
): number {
  let error = 0;
  const compare = (p: Point, a: Triangle, b: Triangle) => {
    const x = height(p, ...(a.map((i) => points[i]) as [Point, Point, Point]));
    const y = height(p, ...(b.map((i) => points[i]) as [Point, Point, Point]));
    if (x !== undefined && y !== undefined) error = Math.max(error, Math.abs(x - y));
  };
  for (const a of before)
    for (const b of after) {
      const aa = faceInfo(points, a, cache),
        bb = faceInfo(points, b, cache),
        ab = aa.bounds,
        bc = bb.bounds;
      if (ab[0] > bc[1] || ab[1] < bc[0] || ab[2] > bc[3] || ab[3] < bc[2]) continue;
      if (Number.isFinite(limit)) {
        const d = aa.plane.map((v, i) => v - bb.plane[i]);
        // A linear difference is bounded over the intersection by its values on
        // the union's vertices. Only inconclusive pairs need the exact overlay.
        const bound = Math.max(
          ...[...aa.points, ...bb.points].map((p) => Math.abs(d[0] * p[0] + d[1] * p[2] + d[2])),
        );
        if (bound <= limit - 1e-7) {
          error = Math.max(error, bound);
          continue;
        }
      }
      for (const i of [...a, ...b]) compare(points[i], a, b);
      if (error > limit) return error;
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          const p = points[a[i]],
            q = points[a[(i + 1) % 3]],
            r = points[b[j]],
            s = points[b[(j + 1) % 3]];
          const dx = q[0] - p[0],
            dz = q[2] - p[2],
            ex = s[0] - r[0],
            ez = s[2] - r[2],
            den = dx * ez - dz * ex;
          if (Math.abs(den) < 1e-12) continue;
          const t = ((r[0] - p[0]) * ez - (r[2] - p[2]) * ex) / den,
            u = ((r[0] - p[0]) * dz - (r[2] - p[2]) * dx) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1)
            compare([p[0] + t * dx, 0, p[2] + t * dz], a, b);
        }
      if (error > limit) return error;
    }
  return error;
}
/** Remove only interior fan vertices. Every boundary/color seam is immutable.
 * Every candidate is compared with the original surface, so the error cannot accumulate. */
export function simplifyTerrainPart(part: StaticMeshPart, tolerance = 0.2): StaticMeshPart {
  const points: Point[] = [],
    lookup = new Map<string, number>();
  let triangles: Triangle[] = [];
  for (let k = 0; k < part.indices.length; k += 3) {
    const face = part.indices
      .slice(k, k + 3)
      .map((i) => part.positions.slice(i * 3, i * 3 + 3) as Point);
    // Bottom and walls belong to physics, never to far surface geometry.
    if (cross(face[0], face[1], face[2]) >= -1e-10) continue;
    triangles.push(
      face.map((p) => {
        const key = p.map(Math.fround).join(',');
        let i = lookup.get(key);
        if (i === undefined) {
          i = points.length;
          lookup.set(key, i);
          points.push(p.map(Math.fround) as Point);
        }
        return i;
      }) as Triangle,
    );
  }
  const original = triangles.slice();
  if (!triangles.length) return { ...part, positions: [], normals: [], indices: [] };
  // If every vertex lies within epsilon of one plane, both the old and any
  // replacement triangle lie in that envelope by convex interpolation. Their
  // difference is at most 2*epsilon, including all edge intersections. This exact
  // bound avoids pairwise overlays for flat and nearly planar surface patches.
  const planeCache = new WeakMap<Triangle, FaceInfo>();
  let reference = original[0],
    referenceArea = 0;
  for (const face of original) {
    const area = Math.abs(cross(points[face[0]], points[face[1]], points[face[2]]));
    if (area > referenceArea) {
      reference = face;
      referenceArea = area;
    }
  }
  const plane = faceInfo(points, reference, planeCache).plane;
  let deviation = 0;
  for (const p of points)
    deviation = Math.max(deviation, Math.abs(p[1] - plane[0] * p[0] - plane[1] * p[2] - plane[2]));
  const planar = 2 * deviation <= tolerance - 2e-6;
  // Query the original surface for every replacement: the error never accumulates
  // through a chain of collapses. The fixed spatial index bounds overlay work.
  let x0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    z1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[2]);
    z1 = Math.max(z1, p[2]);
  }
  const dx = (x1 - x0) / 16,
    dz = (z1 - z0) / 16;
  const range = (ids: number[]) => {
    const x = ids.map((i) => points[i][0]),
      z = ids.map((i) => points[i][2]);
    return [
      Math.max(0, Math.floor((Math.min(...x) - x0) / dx)),
      Math.min(15, Math.floor((Math.max(...x) - x0) / dx)),
      Math.max(0, Math.floor((Math.min(...z) - z0) / dz)),
      Math.min(15, Math.floor((Math.max(...z) - z0) / dz)),
    ];
  };
  const bins = new Map<number, Set<Triangle>>();
  for (const t of planar ? [] : original) {
    const [a, b, c, d] = range(t);
    for (let x = a; x <= b; x++)
      for (let z = c; z <= d; z++) {
        const key = x * 16 + z;
        if (!bins.has(key)) bins.set(key, new Set());
        bins.get(key)!.add(t);
      }
  }
  const originalPatch = (ring: number[]) => {
    const [a, b, c, d] = range(ring),
      result = new Set<Triangle>();
    for (let x = a; x <= b; x++)
      for (let z = c; z <= d; z++) for (const t of bins.get(x * 16 + z) ?? []) result.add(t);
    return [...result];
  };
  const faceCache = new WeakMap<Triangle, FaceInfo>();
  for (let round = 0; round < 16; round++) {
    const faces = new Map<number, Set<Triangle>>(),
      edges = new Map<string, number>();
    for (const t of triangles)
      for (let j = 0; j < 3; j++) {
        const v = t[j];
        if (!faces.has(v)) faces.set(v, new Set());
        faces.get(v)!.add(t);
        const b = t[(j + 1) % 3],
          key = v < b ? `${v},${b}` : `${b},${v}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    const boundary = new Set<number>();
    for (const [e, count] of edges)
      if (count !== 2) e.split(',').forEach((v) => boundary.add(Number(v)));
    const removed = new Set<Triangle>(),
      added: Triangle[] = [],
      touched = new Set<number>();
    for (const [v, fanSet] of faces) {
      if (boundary.has(v) || touched.has(v) || fanSet.size < 3 || fanSet.size > 128) continue;
      const fan = [...fanSet];
      if (fan.some((t) => removed.has(t))) continue;
      const next = new Map<number, number>();
      for (const t of fan) {
        const j = t.indexOf(v);
        next.set(t[(j + 1) % 3], t[(j + 2) % 3]);
      }
      const ring: number[] = [],
        start = next.keys().next().value!;
      let cursor = start;
      do {
        ring.push(cursor);
        cursor = next.get(cursor)!;
      } while (cursor !== undefined && cursor !== start && ring.length <= next.size);
      if (cursor !== start || ring.length !== next.size) continue;
      const shape = triangulate(
        ring.map((i) => [points[i][0], points[i][2]]),
        [],
        0,
      );
      if (Math.abs(shape.coverage - 1) > 1e-6) continue;
      const ids = shape.points.map((p) =>
        ring.find(
          (i) => Math.abs(points[i][0] - p[0]) < 1e-7 && Math.abs(points[i][2] - p[1]) < 1e-7,
        )!,
      );
      const replacement: Triangle[] = [];
      for (let j = 0; j < shape.triangles.length; j += 3) {
        const t = shape.triangles.slice(j, j + 3).map((i) => ids[i]) as Triangle;
        if (t.some((i) => i === undefined)) break;
        if (cross(points[t[0]], points[t[1]], points[t[2]]) > 0) [t[1], t[2]] = [t[2], t[1]];
        replacement.push(t);
      }
      // Ear clipping removes collinear points; split its boundary edges again so
      // shared polylines retain every original Float32 vertex and height exactly.
      for (const id of ring) {
        if (replacement.some((t) => t.includes(id))) continue;
        const p = points[id];
        let inserted = false;
        for (let ti = 0; ti < replacement.length && !inserted; ti++)
          for (let j = 0; j < 3; j++) {
            const t = replacement[ti],
              a = points[t[j]],
              b = points[t[(j + 1) % 3]];
            if (
              Math.abs(cross(a, b, p)) > 1e-7 ||
              (p[0] - a[0]) * (p[0] - b[0]) + (p[2] - a[2]) * (p[2] - b[2]) >= 0
            )
              continue;
            replacement.splice(
              ti,
              1,
              [t[j], id, t[(j + 2) % 3]],
              [id, t[(j + 1) % 3], t[(j + 2) % 3]],
            );
            inserted = true;
            break;
          }
      }
      if (
        replacement.length !== ring.length - 2 ||
        (!planar &&
          terrainReplacementError(
            points,
            originalPatch(ring),
            replacement,
            tolerance - 1e-6,
            faceCache,
          ) >
            tolerance - 1e-6)
      )
        continue;
      fan.forEach((t) => removed.add(t));
      added.push(...replacement);
      ring.forEach((i) => touched.add(i));
    }
    triangles = triangles.filter((t) => !removed.has(t)).concat(added);
  }
  const result = meshPart(part.partId, part.role, part.color);
  result.occlusionGroup = null;
  const remap = new Map<number, number>();
  for (const t of triangles)
    for (const i of t) {
      if (!remap.has(i)) {
        remap.set(i, remap.size);
        result.positions.push(...points[i]);
        result.normals.push(0, 1, 0);
      }
      result.indices.push(remap.get(i)!);
    }
  if (result.indices.length > original.length * 3)
    throw new Error('Terrain simplification increased geometry');
  return result;
}
