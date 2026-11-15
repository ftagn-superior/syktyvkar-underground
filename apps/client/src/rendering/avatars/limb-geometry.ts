import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';

interface Vertex {
  p: number[];
  n: number[];
  c: number[];
}
export interface LimbHalf {
  data: VertexData;
  clothingVertices: number;
}

/** Clip neutral triangles at a hinge, retaining normals and clothing/fixed colour ownership.
 * The two capped surfaces exactly cover the original exterior at zero flexion.
 * Only v2 playback creates these meshes; v1 keeps the original merged geometry/draw count.
 */
export function splitLimb(
  data: VertexData,
  clothingVertices: number,
  y: number,
): [LimbHalf, LimbHalf] {
  const vertex = (i: number): Vertex => ({
    p: Array.from(data.positions!.slice(i * 3, i * 3 + 3)),
    n: Array.from(data.normals!.slice(i * 3, i * 3 + 3)),
    c: Array.from(data.colors!.slice(i * 4, i * 4 + 4)),
  });
  const interpolate = (a: Vertex, b: Vertex): Vertex => {
    const t = (y - a.p[1]) / (b.p[1] - a.p[1]);
    const mix = (key: keyof Vertex) => a[key].map((v, i) => v + (b[key][i] - v) * t);
    return { p: mix('p'), n: mix('n'), c: mix('c') };
  };
  return [1, -1].map((sign) => {
    const positions: number[] = [],
      normals: number[] = [],
      colors: number[] = [],
      indices: number[] = [];
    let clothCount = 0;
    // Keep clothing first, so recolouring still touches exactly its original vertex range.
    for (const cloth of [true, false]) {
      const cut: Vertex[] = [];
      const append = (v: Vertex) => {
        indices.push(indices.length);
        positions.push(v.p[0], v.p[1] - (sign < 0 ? y : 0), v.p[2]);
        normals.push(...v.n);
        colors.push(...v.c);
        if (cloth) clothCount++;
      };
      for (let i = 0; i < data.indices!.length; i += 3) {
        if (data.indices![i] < clothingVertices !== cloth) continue;
        const triangle = [0, 1, 2].map((j) => vertex(data.indices![i + j]));
        const polygon: Vertex[] = [];
        for (let j = 0; j < 3; j++) {
          const a = triangle[j],
            b = triangle[(j + 1) % 3];
          const insideA = sign * (a.p[1] - y) >= -1e-10;
          const insideB = sign * (b.p[1] - y) >= -1e-10;
          if (insideA) polygon.push(a);
          if (insideA !== insideB) {
            const intersection = interpolate(a, b);
            polygon.push(intersection);
            if (
              !cut.some(
                (v) => Math.hypot(v.p[0] - intersection.p[0], v.p[2] - intersection.p[2]) < 1e-7,
              )
            )
              cut.push(intersection);
          }
        }
        for (let j = 1; j < polygon.length - 1; j++)
          [polygon[0], polygon[j], polygon[j + 1]].forEach(append);
      }
      if (cut.length > 2) {
        const center: Vertex = {
          p: [0, y, 0],
          n: [0, -sign, 0],
          c: [0, 0, 0, 0],
        };
        for (const v of cut) {
          center.p[0] += v.p[0] / cut.length;
          center.p[2] += v.p[2] / cut.length;
          v.c.forEach((c, i) => (center.c[i] += c / cut.length));
        }
        cut.sort(
          (a, b) =>
            Math.atan2(a.p[2] - center.p[2], a.p[0] - center.p[0]) -
            Math.atan2(b.p[2] - center.p[2], b.p[0] - center.p[0]),
        );
        for (let j = 0; j < cut.length; j++) {
          const a = { ...cut[j], n: center.n },
            b = { ...cut[(j + 1) % cut.length], n: center.n };
          (sign > 0 ? [center, a, b] : [center, b, a]).forEach(append);
        }
      }
    }
    const result = new VertexData();
    Object.assign(result, { positions, normals, colors, indices });
    return { data: result, clothingVertices: clothCount };
  }) as [LimbHalf, LimbHalf];
}
