/** Shared low-poly foliage profile for authored GLBs, GPU instances and exact picking. */
export type FoliageProfile = 'broadleaf' | 'shrub';
type Point = [number, number, number];

const phi = (1 + Math.sqrt(5)) / 2;
const raw: Point[] = [
  [-1, phi, 0],
  [1, phi, 0],
  [-1, -phi, 0],
  [1, -phi, 0],
  [0, -1, phi],
  [0, 1, phi],
  [0, -1, -phi],
  [0, 1, -phi],
  [phi, 0, -1],
  [phi, 0, 1],
  [-phi, 0, -1],
  [-phi, 0, 1],
];
const faces = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
];
// Each lobe stays within the authored footprint and height. Asymmetry is deterministic.
const lobes: Record<FoliageProfile, [Point, Point][]> = {
  broadleaf: [
    [
      [0, 0.48, 0],
      [0.77, 0.4, 0.77],
    ],
    [
      [-0.39, 0.36, 0.1],
      [0.6, 0.29, 0.59],
    ],
    [
      [0.38, 0.4, 0.16],
      [0.61, 0.3, 0.61],
    ],
    [
      [0.04, 0.42, -0.4],
      [0.59, 0.33, 0.59],
    ],
    [
      [-0.1, 0.73, -0.05],
      [0.6, 0.27, 0.59],
    ],
  ],
  shrub: [
    [
      [0, 0.5, 0],
      [0.72, 0.5, 0.72],
    ],
    [
      [-0.46, 0.36, 0.12],
      [0.52, 0.36, 0.53],
    ],
    [
      [0.42, 0.44, -0.07],
      [0.56, 0.44, 0.56],
    ],
    [
      [0.02, 0.76, 0.1],
      [0.48, 0.24, 0.5],
    ],
  ],
};

/** Flat-shaded triangles plus convex planes of each lobe, all in local metres. */
export function foliageGeometry(
  profile: FoliageProfile,
  radius = 1,
  height = 1,
  base = 0,
  centerX = 0,
  centerZ = 0,
) {
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  const hulls: number[][][] = [];
  for (const [center, scale] of lobes[profile]) {
    const points = raw.map(([x, y, z]): Point => [
      centerX + (center[0] + (x / phi) * scale[0]) * radius,
      base + (center[1] + (y / phi) * scale[1]) * height,
      centerZ + (center[2] + (z / phi) * scale[2]) * radius,
    ]);
    const planes: number[][] = [];
    for (const [a, b, c] of faces) {
      const p = points[a],
        q = points[b],
        r = points[c];
      const u = q.map((n, i) => n - p[i]),
        v = r.map((n, i) => n - p[i]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...n);
      const normal = n.map((value) => value / length);
      const start = positions.length / 3;
      for (const point of [p, q, r]) {
        positions.push(...point);
        normals.push(...normal);
      }
      indices.push(start, start + 1, start + 2);
      planes.push([...normal, normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2]]);
    }
    hulls.push(planes);
  }
  return { positions, normals, indices, hulls };
}

const occlusionProfiles = new Map<FoliageProfile, readonly number[]>();

/**
 * Local ambient accessibility of the overlapping crown lobes. Bake once on a
 * canonical profile so GLBs and deformed GPU instances share the same colours.
 * Only the other lobes occlude a vertex: there is no ground or world-space stain.
 */
export function foliageOcclusion(profile: FoliageProfile): readonly number[] {
  const cached = occlusionProfiles.get(profile);
  if (cached) return cached;
  const { positions, normals, hulls } = foliageGeometry(
    profile,
    1,
    profile === 'broadleaf' ? 2.6 : 1,
  );
  const directions = Array.from({ length: 64 }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / 64;
    const radius = Math.sqrt(1 - y * y),
      angle = i * Math.PI * (3 - Math.sqrt(5));
    return [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
  });
  const factors = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const normal = normals.slice(vertex * 3, vertex * 3 + 3);
    const origin = positions.slice(vertex * 3, vertex * 3 + 3).map((v, i) => v + normal[i] * 0.002);
    let blocked = 0,
      weight = 0;
    for (const direction of directions) {
      const cosine = normal.reduce((sum, n, i) => sum + n * direction[i], 0);
      if (cosine <= 0) continue;
      weight += cosine;
      let nearest = 1.5;
      for (let lobe = 0; lobe < hulls.length; lobe++) {
        if (lobe === Math.floor(vertex / (faces.length * 3))) continue;
        let near = 0,
          far = nearest;
        for (const [x, y, z, offset] of hulls[lobe]) {
          const distance = offset - x * origin[0] - y * origin[1] - z * origin[2];
          const speed = x * direction[0] + y * direction[1] + z * direction[2];
          if (Math.abs(speed) < 1e-10) {
            if (distance < 0) {
              far = -1;
              break;
            }
          } else if (speed > 0) far = Math.min(far, distance / speed);
          else near = Math.max(near, distance / speed);
          if (near > far) break;
        }
        if (near <= far && far >= 0) nearest = near;
      }
      blocked += cosine * (1 - nearest / 1.5) ** 2;
    }
    factors.push(1 - (0.34 * blocked) / weight);
  }
  const result = Object.freeze(factors);
  occlusionProfiles.set(profile, result);
  return result;
}
