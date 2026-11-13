export interface StaticMeshPart {
  partId: string;
  role: 'wall' | 'roof' | 'detail';
  occlusionGroup: string | null;
  color: string;
  positions: number[];
  normals: number[];
  indices: number[];
  /**
   * Необязательные цвета вершин (линейный RGB, по три числа на вершину). Позволяют
   * Множитель материала `color`, как COLOR_0 в glTF. После слияния разноцветных
   * деталей содержит итоговый линейный цвет, а `color` становится белым.
   */
  colors?: number[];
  /** Per-vertex night glow: GLOW_KIND and deterministic threshold, encoded as TEXCOORD_0. */
  glow?: number[];
}

/** Unmarked trailing vertices do not glow; shared by compilation and mesh merging. */
export function glowOf(part: StaticMeshPart): number[] | undefined {
  if (!part.glow) return undefined;
  const count = part.positions.length / 3;
  if (part.glow.length > count * 2) throw new Error(`Glow data exceeds ${part.partId}`);
  return part.glow.length === count * 2
    ? part.glow
    : part.glow.concat(Array<number>(count * 2 - part.glow.length).fill(0));
}

export function meshPart(
  partId: string,
  role: StaticMeshPart['role'],
  color: string,
): StaticMeshPart {
  return { partId, role, occlusionGroup: 'shell', color, positions: [], normals: [], indices: [] };
}
export function addFace(part: StaticMeshPart, points: number[][]): void {
  const [a, b, c] = points;
  const u = b.map((n, i) => n - a[i]),
    v = c.map((n, i) => n - a[i]);
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...cross),
    normal = cross.map((n) => n / length);
  const start = part.positions.length / 3;
  for (const point of points) {
    part.positions.push(...point);
    part.normals.push(...normal);
  }
  for (let i = 1; i < points.length - 1; i++) part.indices.push(start, start + i, start + i + 1);
}
