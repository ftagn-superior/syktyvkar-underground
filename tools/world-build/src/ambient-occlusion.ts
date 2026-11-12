import type { StaticMeshPart } from './glb.js';

type V3 = [number, number, number];
type Triangle = { a: V3; u: V3; v: V3; min: V3; max: V3 };
type Node = { min: V3; max: V3; triangles?: Triangle[]; children?: [Node, Node] };
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: V3): V3 => {
  const length = Math.hypot(...v);
  return length > 1e-12 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 1, 0];
};
const at = (values: number[], index: number): V3 => values.slice(index * 3, index * 3 + 3) as V3;

function tree(triangles: Triangle[]): Node {
  const min: V3 = [Infinity, Infinity, Infinity],
    max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], triangle.min[k]);
      max[k] = Math.max(max[k], triangle.max[k]);
    }
  if (triangles.length <= 8) return { min, max, triangles };
  const extent = sub(max, min);
  const axis = extent.indexOf(Math.max(...extent));
  triangles.sort((a, b) => a.min[axis] + a.max[axis] - b.min[axis] - b.max[axis]);
  const middle = Math.floor(triangles.length / 2);
  return { min, max, children: [tree(triangles.slice(0, middle)), tree(triangles.slice(middle))] };
}

function hitBounds(node: Node, origin: V3, direction: V3, limit: number): boolean {
  let near = 0,
    far = limit;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(direction[k]) < 1e-12) {
      if (origin[k] < node.min[k] || origin[k] > node.max[k]) return false;
      continue;
    }
    const a = (node.min[k] - origin[k]) / direction[k],
      b = (node.max[k] - origin[k]) / direction[k];
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (far < near) return false;
  }
  return true;
}

function nearest(node: Node, origin: V3, direction: V3, limit: number): number {
  if (!hitBounds(node, origin, direction, limit)) return limit;
  if (node.children) {
    const first = nearest(node.children[0], origin, direction, limit);
    return nearest(node.children[1], origin, direction, first);
  }
  for (const triangle of node.triangles!) {
    const p = cross(direction, triangle.v),
      determinant = dot(triangle.u, p);
    if (Math.abs(determinant) < 1e-10) continue;
    const inverse = 1 / determinant,
      t = sub(origin, triangle.a),
      u = dot(t, p) * inverse;
    if (u < 0 || u > 1) continue;
    const q = cross(t, triangle.u),
      v = dot(direction, q) * inverse;
    if (v < 0 || u + v > 1) continue;
    const distance = dot(triangle.v, q) * inverse;
    if (distance > 1e-5 && distance < limit) limit = distance;
  }
  return limit;
}

// Fixed cosine-weighted hemisphere: repeatable builds, no random sampling noise.
const rays: V3[] = Array.from({ length: 24 }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / 24),
    angle = i * Math.PI * (3 - Math.sqrt(5));
  return [r * Math.cos(angle), r * Math.sin(angle), Math.sqrt(1 - r * r)];
});

/**
 * Asset-local contact AO, baked once into linear COLOR_0 multipliers. No topology,
 * materials, physics, draw calls or runtime AO calculations are added. Only surfaces
 * in the SAME fade group occlude each other; neither ground nor nearby instances
 * participate, so moving/removing an asset cannot leave stale shadows behind.
 *
 * Sparse large faces cannot represent a narrow crease. Attenuate their AO by
 * edge length rather than spreading a dark band over the whole wall or roof.
 * Specialized foliage uses a shared instancing profile and is excluded here.
 */
export function bakeLocalAo(parts: StaticMeshPart[]): void {
  const radius = 0.75,
    strength = 0.3;
  const groups = new Map<string | null, StaticMeshPart[]>();
  for (const part of parts) {
    const group = groups.get(part.occlusionGroup) ?? [];
    group.push(part);
    groups.set(part.occlusionGroup, group);
  }
  for (const group of groups.values()) {
    // Weld only the sampling data, not the mesh. Coplanar triangles and separate
    // material parts must agree at a shared vertex or COLOR_0 exposes their seams.
    type Sample = { position: V3; normal: V3; inward: V3; span: number; visibility: number };
    const samples = new Map<string, Sample>();
    const partSamples = new Map<StaticMeshPart, Sample[]>();
    for (const part of group) {
      const entries: Sample[] = [];
      for (let i = 0; i < part.positions.length / 3; i++) {
        const position = at(part.positions, i),
          normal = unit(at(part.normals, i));
        const key = [...position, ...normal].map((n) => Math.round(n * 1e6)).join(',');
        let sample = samples.get(key);
        if (!sample) {
          sample = { position, normal, inward: [0, 0, 0], span: 0, visibility: 1 };
          samples.set(key, sample);
        }
        entries.push(sample);
      }
      partSamples.set(part, entries);
    }
    const triangles: Triangle[] = [];
    for (const part of group)
      for (let i = 0; i < part.indices.length; i += 3) {
        const points = part.indices.slice(i, i + 3).map((index) => at(part.positions, index));
        const [a, b, c] = points;
        const u = sub(b, a),
          v = sub(c, a);
        if (Math.hypot(...cross(u, v)) < 1e-10) continue;
        const span = Math.max(...points.map((p, k) => Math.hypot(...sub(p, points[(k + 1) % 3]))));
        for (let j = 0; j < 3; j++) {
          const sample = partSamples.get(part)![part.indices[i + j]];
          sample.span = Math.max(sample.span, span);
          for (let k = 0; k < 3; k++) sample.inward[k] += (a[k] + b[k] + c[k]) / 3 - points[j][k];
        }
        triangles.push({
          a,
          u,
          v,
          min: [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k]))) as V3,
          max: [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k]))) as V3,
        });
      }
    if (!triangles.length) continue;
    const bvh = tree(triangles);
    for (const sample of samples.values()) {
      const { normal } = sample;
      const tangent = unit(cross(Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], normal));
      const bitangent = cross(normal, tangent);
      const inset = Math.hypot(...sample.inward) > 1e-12 ? unit(sample.inward) : [0, 0, 0];
      const origin = sample.position.map((p, k) => p + normal[k] * 0.002 + inset[k] * 0.004) as V3;
      let occluded = 0;
      for (const ray of rays) {
        const direction = [0, 1, 2].map(
          (k) => tangent[k] * ray[0] + bitangent[k] * ray[1] + normal[k] * ray[2],
        ) as V3;
        const distance = nearest(bvh, origin, direction, radius);
        occluded += (1 - distance / radius) ** 2;
      }
      const resolution = Math.min(1, Math.sqrt((radius * 2) / Math.max(sample.span, radius)));
      sample.visibility = 1 - (strength * resolution * occluded) / rays.length;
    }
    for (const part of group) {
      const colors = part.colors ? [...part.colors] : Array<number>(part.positions.length).fill(1);
      let changed = false;
      for (const [i, { visibility }] of partSamples.get(part)!.entries()) {
        if (visibility < 1 - 1e-6) changed = true;
        for (let k = 0; k < 3; k++) colors[i * 3 + k] *= visibility;
      }
      if (changed) part.colors = colors;
    }
  }
}
