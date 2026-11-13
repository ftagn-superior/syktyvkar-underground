import { canonicalJson, validateTerrainGrid, type BuildingInstance } from '@su/contracts';
import { hash } from '@su/world-release';
import { cleanRing, signedArea, triangulate, type Point2 } from '@su/terrain-build/triangulate';
import type { TerrainSurface } from '@su/terrain-build/terrain';
import type { GroundRecipe } from './city.js';

export const GROUND_TERRAIN_OFFSET_SCALE = 0.04 / 0.042;
// One observed source defect, not an automatic acceptance of future invalid polygons.
const LEGACY_GREEN_SHA256 = '96a441e43a8dad7dea32d9d81644f3f09da161e1698825be8246026b6018b999';
const LEGACY_GREEN_TRIANGLES_SHA256 =
  'b99fbffd2266235524fa60779967805b7466a0c55b46316deeb9d639cfae20dc';
const colorPattern = /^#[a-f0-9]{6}$/i;
const cross = (a: Point2, b: Point2, c: Point2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a: Point2, b: Point2, p: Point2) =>
  Math.abs(cross(a, b, p)) <= 1e-9 &&
  p[0] >= Math.min(a[0], b[0]) - 1e-9 &&
  p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
  p[1] >= Math.min(a[1], b[1]) - 1e-9 &&
  p[1] <= Math.max(a[1], b[1]) + 1e-9;
function intersects(a: Point2, b: Point2, c: Point2, d: Point2) {
  return (
    (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}
const crosses = (a: Point2, b: Point2, c: Point2, d: Point2) =>
  cross(a, b, c) * cross(a, b, d) < -1e-16 && cross(c, d, a) * cross(c, d, b) < -1e-16;
function inside(p: Point2, ring: Point2[], includeBoundary = false) {
  let result = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    if (onSegment(a, b, p)) return includeBoundary;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    )
      result = !result;
  }
  return result;
}
function inspectTopology(rings: Point2[][]) {
  const issues: string[] = [];
  const notes: string[] = [];
  if (rings.some((ring) => ring.length < 3 || Math.abs(signedArea(ring)) < 1e-6))
    return { issues: ['degenerate polygon ring'], notes };
  for (const [r, ring] of rings.entries()) {
    for (let i = 0; i < ring.length; i++)
      for (let j = i + 2; j < ring.length; j++) {
        if (i === 0 && j === ring.length - 1) continue;
        const a = ring[i],
          b = ring[(i + 1) % ring.length],
          c = ring[j],
          d = ring[(j + 1) % ring.length];
        if (crosses(a, b, c, d)) issues.push(`ring ${r} edges ${i}/${j} cross`);
        else if (intersects(a, b, c, d)) notes.push(`ring ${r} edges ${i}/${j} touch`);
      }
    if (r > 0 && !ring.every((p) => inside(p, rings[0], true)))
      issues.push(`hole ${r} outside outline`);
    for (let previous = 0; previous < r; previous++) {
      const other = rings[previous];
      if (previous > 0 && (inside(ring[0], other) || inside(other[0], ring)))
        issues.push(`holes ${previous}/${r} overlap`);
      if (
        ring.some((p, i) =>
          other.some((q, j) =>
            crosses(p, ring[(i + 1) % ring.length], q, other[(j + 1) % other.length]),
          ),
        )
      )
        issues.push(`rings ${previous}/${r} cross`);
      else if (
        ring.some((p, i) =>
          other.some((q, j) =>
            intersects(p, ring[(i + 1) % ring.length], q, other[(j + 1) % other.length]),
          ),
        )
      )
        notes.push(`rings ${previous}/${r} touch`);
    }
  }
  return { issues, notes };
}
function triangleFingerprint(triangles: Point2[][]) {
  return hash(
    canonicalJson(
      triangles.map((t) => canonicalJson([...t].sort((a, b) => a[0] - b[0] || a[1] - b[1]))).sort(),
    ),
  );
}

export interface GroundTerrainConversionDiagnostics {
  formatVersion: 1;
  spacing: 2 | 4;
  offsetScale: number;
  sourcePolygonCount: number;
  sourceHoleCount: number;
  sourceVertexCount: number;
  surfaceCount: number;
  layers: {
    index: number;
    id: string;
    polygons: number;
    holes: number;
    sourceElevation: number;
    offset: number;
    surfaces: number;
  }[];
  cleanedRings: {
    layerId: string;
    polygonIndex: number;
    ringIndex: number;
    sourceVertices: number;
    cleanedVertices: number;
  }[];
  topologyNotes: { layerId: string; polygonIndex: number; notes: string[] }[];
  exceptions: {
    strategy: 'legacy-triangle-footprint';
    layerId: string;
    polygonIndex: number;
    sourceSha256: string;
    triangleFootprintSha256: string;
    issues: string[];
    legacyCoverage: number;
    triangleCount: number;
    outlineSignedAreaMagnitude: number;
    triangleAreaSum: number;
  }[];
}

/** Convert the existing ground authoring without lab anchors or spawn/item policy. */
export function createGroundTerrain(
  recipe: GroundRecipe,
  placement: BuildingInstance,
  spacing: 2 | 4,
) {
  if (spacing !== 2 && spacing !== 4)
    throw new Error('Ground terrain spacing must be 2 or 4 metres');
  const pointValid = (p: unknown): p is Point2 =>
    Array.isArray(p) &&
    p.length === 2 &&
    p.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100_000);
  if (
    !recipe ||
    recipe.formatVersion !== 1 ||
    !pointValid(recipe.min) ||
    !pointValid(recipe.max) ||
    typeof recipe.color !== 'string' ||
    !colorPattern.test(recipe.color) ||
    !Number.isFinite(recipe.depth) ||
    recipe.depth <= 0 ||
    recipe.depth > 10 ||
    !Array.isArray(recipe.layers)
  )
    throw new Error('Invalid ground terrain recipe');
  const position = placement?.position,
    q = placement?.rotation;
  if (
    !position ||
    ![position.x, position.y, position.z].every(Number.isFinite) ||
    !q ||
    ![q.x, q.y, q.z, q.w].every(Number.isFinite) ||
    Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) > 1e-8 ||
    Math.abs(q.w - 1) > 1e-8
  )
    throw new Error('Ground terrain requires finite, axis-aligned placement');
  const columns = (recipe.max[0] - recipe.min[0]) / spacing + 1;
  const rows = (recipe.max[1] - recipe.min[1]) / spacing + 1;
  if (
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns < 2 ||
    rows < 2 ||
    columns * rows > 1_000_000
  )
    throw new Error('Ground extent must align with terrain spacing');
  const grid = validateTerrainGrid({
    formatVersion: 1,
    origin: { x: recipe.min[0] + position.x, z: recipe.min[1] + position.z },
    spacing,
    columns,
    rows,
    bottom: position.y - recipe.depth,
    heights: Array(columns * rows).fill(position.y),
  });
  const surfaces: TerrainSurface[] = [];
  const diagnostics: GroundTerrainConversionDiagnostics = {
    formatVersion: 1,
    spacing,
    offsetScale: GROUND_TERRAIN_OFFSET_SCALE,
    sourcePolygonCount: 0,
    sourceHoleCount: 0,
    sourceVertexCount: 0,
    surfaceCount: 0,
    layers: [],
    cleanedRings: [],
    topologyNotes: [],
    exceptions: [],
  };
  const ids = new Set<string>();
  let previousElevation = 0;
  const translate = (ring: readonly Point2[]): Point2[] =>
    ring.map(([x, z]) => [x + position.x, z + position.z]);
  for (const [layerIndex, layer] of recipe.layers.entries()) {
    if (
      !layer ||
      typeof layer.id !== 'string' ||
      !/^[a-z0-9-]{1,40}$/.test(layer.id) ||
      ids.has(layer.id) ||
      typeof layer.color !== 'string' ||
      !colorPattern.test(layer.color) ||
      !Number.isFinite(layer.elevation) ||
      layer.elevation <= previousElevation ||
      layer.elevation > 0.042 ||
      !Array.isArray(layer.polygons)
    )
      throw new Error(
        `Invalid ground terrain layer ${layer?.id ?? layerIndex}; elevations must increase up to 0.042`,
      );
    ids.add(layer.id);
    previousElevation = layer.elevation;
    const offset = layer.elevation * GROUND_TERRAIN_OFFSET_SCALE;
    const summary = {
      index: layerIndex,
      id: layer.id,
      polygons: layer.polygons.length,
      holes: 0,
      sourceElevation: layer.elevation,
      offset,
      surfaces: 0,
    };
    for (const [polygonIndex, polygon] of layer.polygons.entries()) {
      const label = `${layer.id}.polygons[${polygonIndex}]`;
      if (
        !Array.isArray(polygon) ||
        !polygon.length ||
        !polygon.every(
          (ring) =>
            Array.isArray(ring) &&
            ring.length >= 3 &&
            ring.every(
              (p) =>
                pointValid(p) &&
                p[0] >= recipe.min[0] &&
                p[0] <= recipe.max[0] &&
                p[1] >= recipe.min[1] &&
                p[1] <= recipe.max[1],
            ),
        )
      )
        throw new Error(`Invalid ground terrain polygon ${label}`);
      diagnostics.sourcePolygonCount++;
      diagnostics.sourceHoleCount += polygon.length - 1;
      summary.holes += polygon.length - 1;
      const cleaned = polygon.map((ring, ringIndex) => {
        diagnostics.sourceVertexCount += ring.length;
        const result = cleanRing(ring);
        if (result.length !== ring.length)
          diagnostics.cleanedRings.push({
            layerId: layer.id,
            polygonIndex,
            ringIndex,
            sourceVertices: ring.length,
            cleanedVertices: result.length,
          });
        return result;
      });
      const { issues, notes } = inspectTopology(cleaned);
      if (notes.length) diagnostics.topologyNotes.push({ layerId: layer.id, polygonIndex, notes });
      let shape: ReturnType<typeof triangulate>;
      try {
        shape = triangulate(polygon[0], polygon.slice(1));
      } catch (error) {
        throw new Error(`Invalid ground terrain polygon ${label}: ${String(error)}`);
      }
      if (
        !shape.triangles.length ||
        !Number.isFinite(shape.coverage) ||
        Math.abs(shape.coverage - 1) > 1e-6
      )
        issues.push(`triangulation coverage ${shape.coverage}`);
      const id = `ground-${String(layerIndex).padStart(3, '0')}-${layer.id}-${String(polygonIndex).padStart(6, '0')}`;
      if (!issues.length) {
        surfaces.push({
          id,
          outline: translate(polygon[0]),
          ...(polygon.length > 1 ? { holes: polygon.slice(1).map(translate) } : {}),
          color: layer.color,
          offset,
        });
        summary.surfaces++;
        continue;
      }
      const sourceSha256 = hash(canonicalJson(polygon));
      if (layer.id !== 'green' || polygonIndex !== 290 || sourceSha256 !== LEGACY_GREEN_SHA256)
        throw new Error(`Invalid ground terrain polygon ${label}: ${issues.join('; ')}`);
      const triangles: Point2[][] = [];
      for (let i = 0; i < shape.triangles.length; i += 3)
        triangles.push(shape.triangles.slice(i, i + 3).map((index) => shape.points[index]));
      const triangleFootprintSha256 = triangleFingerprint(triangles);
      if (triangles.length !== 20 || triangleFootprintSha256 !== LEGACY_GREEN_TRIANGLES_SHA256)
        throw new Error(`Legacy ground triangle footprint changed: ${label}`);
      for (const [index, triangle] of triangles.entries()) {
        const checked = triangulate(triangle);
        if (
          checked.triangles.length !== 3 ||
          triangleFingerprint([checked.points]) !== triangleFingerprint([triangle])
        )
          throw new Error(`Legacy ground triangle cannot be preserved: ${label}/${index}`);
        surfaces.push({
          id: `${id}-legacy-${String(index).padStart(3, '0')}`,
          outline: translate(triangle),
          color: layer.color,
          offset,
        });
      }
      summary.surfaces += triangles.length;
      diagnostics.exceptions.push({
        strategy: 'legacy-triangle-footprint',
        layerId: layer.id,
        polygonIndex,
        sourceSha256,
        triangleFootprintSha256,
        issues,
        legacyCoverage: shape.coverage,
        triangleCount: triangles.length,
        outlineSignedAreaMagnitude: Math.abs(signedArea(polygon[0])),
        triangleAreaSum: triangles.reduce(
          (sum, triangle) => sum + Math.abs(signedArea(triangle)),
          0,
        ),
      });
    }
    diagnostics.layers.push(summary);
  }
  diagnostics.surfaceCount = surfaces.length;
  return { grid, surfaces, color: recipe.color, conversionDiagnostics: diagnostics };
}
