import assert from 'node:assert/strict';
import { triangulate, type Point2 } from '../../packages/terrain-build/src/triangulate.js';
export type FlatTriangle = [number, number, number, number, number, number];
const binSize = 16;
const tolerance = 0.0001;
const centroid = (t: FlatTriangle): Point2 => [(t[0] + t[2] + t[4]) / 3, (t[1] + t[3] + t[5]) / 3];
const bins = (t: FlatTriangle) => ({
  x0: Math.floor((Math.min(t[0], t[2], t[4]) - tolerance) / binSize),
  x1: Math.floor((Math.max(t[0], t[2], t[4]) + tolerance) / binSize),
  z0: Math.floor((Math.min(t[1], t[3], t[5]) - tolerance) / binSize),
  z1: Math.floor((Math.max(t[1], t[3], t[5]) + tolerance) / binSize),
});
function contains(t: FlatTriangle, p: Point2) {
  let positive = false,
    negative = false;
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3,
      dx = t[j * 2] - t[i * 2],
      dz = t[j * 2 + 1] - t[i * 2 + 1];
    const cross = dx * (p[1] - t[i * 2 + 1]) - dz * (p[0] - t[i * 2]),
      epsilon = tolerance * Math.hypot(dx, dz);
    if (cross > epsilon) positive = true;
    if (cross < -epsilon) negative = true;
  }
  return !(positive && negative);
}

/** Spatial controls against the old rendered footprint, including holes and overlaps. */
export function flatCoverageProbe(
  reference: FlatTriangle[],
  holes: Point2[][],
  min: Point2,
  max: Point2,
) {
  const oldBins = new Map<string, FlatTriangle[]>();
  for (const t of reference) {
    const b = bins(t);
    for (let z = b.z0; z <= b.z1; z++)
      for (let x = b.x0; x <= b.x1; x++) {
        const key = `${x},${z}`,
          values = oldBins.get(key) ?? [];
        values.push(t);
        oldBins.set(key, values);
      }
  }
  const oldContains = (p: Point2) =>
    (oldBins.get(`${Math.floor(p[0] / binSize)},${Math.floor(p[1] / binSize)}`) ?? []).some((t) =>
      contains(t, p),
    );
  const points: Point2[] = reference.map(centroid);
  for (const hole of holes) {
    const shape = triangulate(hole);
    for (let i = 0; i < shape.triangles.length; i += 3) {
      const [a, b, c] = shape.triangles.slice(i, i + 3).map((id) => shape.points[id]);
      points.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]);
    }
  }
  for (let z = min[1] + 7.75; z < max[1]; z += 31)
    for (let x = min[0] + 7.75; x < max[0]; x += 31) points.push([x, z]);
  const controls = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].map((p) => ({
    p,
    expected: oldContains(p),
    hit: false,
  }));
  const controlBins = new Map<string, typeof controls>();
  for (const control of controls) {
    const key = `${Math.floor(control.p[0] / binSize)},${Math.floor(control.p[1] / binSize)}`;
    const values = controlBins.get(key) ?? [];
    values.push(control);
    controlBins.set(key, values);
  }
  let inspectedTriangles = 0;
  return {
    visit(t: FlatTriangle) {
      assert.ok(
        oldContains(centroid(t)),
        `Saved cover leaves the legacy footprint at ${centroid(t)}`,
      );
      inspectedTriangles++;
      const b = bins(t);
      for (let z = b.z0; z <= b.z1; z++)
        for (let x = b.x0; x <= b.x1; x++)
          for (const control of controlBins.get(`${x},${z}`) ?? [])
            if (!control.hit && contains(t, control.p)) control.hit = true;
    },
    evidence() {
      const missed = controls.filter((c) => c.expected !== c.hit);
      assert.deepEqual(
        missed.slice(0, 5),
        [],
        `${missed.length} spatial footprint controls changed`,
      );
      return {
        controls: controls.length,
        positive: controls.filter((c) => c.expected).length,
        negative: controls.filter((c) => !c.expected).length,
        holeRings: holes.length,
        inspectedTriangles,
        toleranceMetres: tolerance,
      };
    },
  };
}
