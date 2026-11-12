import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Ray } from '@babylonjs/core/Culling/ray';
import { foliageGeometry, foliageOcclusion, type TreeRenderRecipe } from '@su/contracts';

const SIDES = 7;
const APOTHEM = Math.cos(Math.PI / SIDES);
const BROADLEAF_HULLS = foliageGeometry('broadleaf').hulls;
const linear = (hex: string) =>
  [1, 3, 5].map((i) => {
    const value = parseInt(hex.slice(i, i + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

/** One shared crown profile and unit trunk; the shader restores each authored envelope. */
export function treeTemplate(
  crownColor: string,
  trunkColor: string,
  foliage: TreeRenderRecipe['foliage'],
) {
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  const colors: number[] = [],
    parts: number[] = [];
  const face = (points: number[][], part: number) => {
    const vectors = points.map((p) => Vector3.FromArray(p));
    let normal = Vector3.Cross(
      vectors[1].subtract(vectors[0]),
      vectors[2].subtract(vectors[0]),
    ).normalize();
    const center = vectors.reduce((a, b) => a.add(b), Vector3.Zero()).scale(1 / points.length);
    if (Vector3.Dot(normal, center.subtract(new Vector3(0, 0.5, 0))) < 0) {
      vectors.reverse();
      normal = normal.negate();
    }
    const start = positions.length / 3;
    const color = linear(part === 2 ? trunkColor : crownColor);
    for (const v of vectors) {
      positions.push(v.x, v.y, v.z);
      normals.push(normal.x, normal.y, normal.z);
      colors.push(...color, 1);
      parts.push(part);
    }
    for (let i = 1; i < vectors.length - 1; i++) indices.push(start, start + i, start + i + 1);
  };
  if (foliage === 'broadleaf') {
    const data = foliageGeometry(foliage);
    positions.push(...data.positions);
    normals.push(...data.normals);
    indices.push(...data.indices);
    const color = linear(crownColor);
    const occlusion = foliageOcclusion(foliage);
    for (let i = 0; i < data.positions.length / 3; i++) {
      colors.push(...color.map((channel) => channel * occlusion[i]), 1);
      parts.push(0);
    }
  }
  for (let part = 0; foliage === 'spruce' && part < 2; part++) {
    const ring = (y: number) =>
      Array.from({ length: SIDES }, (_, k) => [
        Math.cos((k * Math.PI * 2) / SIDES),
        y,
        Math.sin((k * Math.PI * 2) / SIDES),
      ]);
    const bottom = ring(0),
      top = ring(1);
    for (let k = 0; k < SIDES; k++) {
      const next = (k + 1) % SIDES;
      face([bottom[k], bottom[next], top[next], top[k]], part);
    }
    face(bottom, part);
    face(top, part);
  }
  const box = [
    [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
    [
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
      [-1, -1, -1],
    ],
    [
      [-1, 1, -1],
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
    ],
    [
      [-1, -1, 1],
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
    ],
    [
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
      [-1, -1, 1],
    ],
    [
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
      [1, -1, -1],
    ],
  ];
  for (const points of box)
    face(
      points.map(([x, y, z]) => [x / 2, (y + 1) / 2, z / 2]),
      2,
    );
  return { positions, normals, indices, colors, parts };
}

/** Convex clipping against the same crown lobes/cones and trunk used in both render paths. */
export function treeIntersectsRay(recipe: TreeRenderRecipe, ray: Ray): boolean {
  const clip = (planes: number[][], origin = ray.origin, direction = ray.direction) => {
    let near = 0,
      far = ray.length;
    for (const [x, y, z, offset] of planes) {
      const distance = offset - x * origin.x - y * origin.y - z * origin.z;
      const speed = x * direction.x + y * direction.y + z * direction.z;
      if (Math.abs(speed) < 1e-10) {
        if (distance < -1e-8) return false;
      } else if (speed > 0) far = Math.min(far, distance / speed);
      else near = Math.max(near, distance / speed);
      if (near > far) return false;
    }
    return far >= 0 && near < ray.length;
  };
  if (recipe.foliage === 'broadleaf') {
    const [lower, upper] = recipe.crowns;
    const radius = Math.max(lower[0], lower[1], upper[0], upper[1]);
    const height = upper[2] + upper[3] - lower[2];
    const origin = new Vector3(
      ray.origin.x / radius,
      (ray.origin.y - lower[2]) / height,
      ray.origin.z / radius,
    );
    const direction = new Vector3(
      ray.direction.x / radius,
      ray.direction.y / height,
      ray.direction.z / radius,
    );
    for (const planes of BROADLEAF_HULLS) if (clip(planes, origin, direction)) return true;
  }
  for (const [bottom, top, base, height] of recipe.foliage === 'spruce' ? recipe.crowns : []) {
    const slope = ((top - bottom) * APOTHEM) / height;
    const planes = [
      [0, -1, 0, -base],
      [0, 1, 0, base + height],
    ];
    for (let k = 0; k < SIDES; k++) {
      const a = ((k + 0.5) * Math.PI * 2) / SIDES;
      planes.push([Math.cos(a), -slope, Math.sin(a), bottom * APOTHEM - slope * base]);
    }
    if (clip(planes)) return true;
  }
  const [x, y, z, yaw] = recipe.trunk;
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  const unrotate = (v: Vector3) => new Vector3(c * v.x - s * v.z, v.y, s * v.x + c * v.z);
  return clip(
    [
      [1, 0, 0, x / 2],
      [-1, 0, 0, x / 2],
      [0, 1, 0, recipe.trunkBase + y],
      [0, -1, 0, -recipe.trunkBase],
      [0, 0, 1, z / 2],
      [0, 0, -1, z / 2],
    ],
    unrotate(ray.origin),
    unrotate(ray.direction),
  );
}
