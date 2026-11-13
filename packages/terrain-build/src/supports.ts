import {
  sampleTerrain,
  validateBuildingPhysicsAsset,
  type BuildingInstance,
  type TerrainGrid,
  type TerrainTriangle,
  type Vec3,
} from '@su/contracts';
import {
  validateFoundationSupportRule,
  type FoundationSupportRuleV2,
  type TerrainSupportApproach,
  type TerrainSupportComponent,
  type TerrainSupportRule,
} from './private-data.js';
import { patchRange, terrainPatch, terrainSolid, type GeneratedTerrainAsset } from './terrain.js';
import { clipRing, signedArea, triangulate, type Point2 } from './triangulate.js';

// Boundary validation allows collision-scale roundoff; edge noding is much tighter
// so nearby, genuinely different grid cuts cannot become inverted cap fans.
const WELD = 1e-6;
const EPS = 2 * WELD;
const NODE_EPS = 1e-8;
const RENDER_CAP_GAP = 0.002;
const cross = (a: Point2, b: Point2, c: Point2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const distance = (a: Point2, b: Point2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const xz = (p: Vec3): Point2 => [p.x, p.z];
const fail = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`Invalid terrain support: ${message}`);
};

function onSegment(p: Point2, a: Point2, b: Point2, tolerance = EPS): boolean {
  const length = distance(a, b);
  return (
    length > 0 &&
    Math.abs(cross(a, b, p)) <= tolerance * length &&
    p[0] >= Math.min(a[0], b[0]) - tolerance &&
    p[0] <= Math.max(a[0], b[0]) + tolerance &&
    p[1] >= Math.min(a[1], b[1]) - tolerance &&
    p[1] <= Math.max(a[1], b[1]) + tolerance
  );
}
/** -1 outside, 0 boundary, 1 inside. */
function insideRing(p: Point2, ring: readonly Point2[]): -1 | 0 | 1 {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    if (onSegment(p, a, b)) return 0;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    )
      inside = !inside;
  }
  return inside ? 1 : -1;
}
/** 0 disjoint, 1 endpoint contact, 2 crossing or an overlapping segment. */
function segmentContact(a: Point2, b: Point2, c: Point2, d: Point2): number {
  const ab = distance(a, b),
    cd = distance(c, d);
  const ac = cross(a, b, c),
    ad = cross(a, b, d),
    ca = cross(c, d, a),
    cb = cross(c, d, b);
  if (Math.abs(ac) <= EPS * ab && Math.abs(ad) <= EPS * ab) {
    const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
    const overlap =
      Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) -
      Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]));
    return overlap > EPS ? 2 : overlap >= -EPS ? 1 : 0;
  }
  if (
    ac * ad < 0 &&
    ca * cb < 0 &&
    Math.min(Math.abs(ac), Math.abs(ad)) > EPS * ab &&
    Math.min(Math.abs(ca), Math.abs(cb)) > EPS * cd
  )
    return 2;
  return onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b)
    ? 1
    : 0;
}
function cleanSupportRing(input: Point2[]): Point2[] {
  const ring = [...input];
  if (ring.length > 3 && distance(ring[0], ring[ring.length - 1]) <= WELD) ring.pop();
  fail(ring.length >= 3 && Math.abs(signedArea(ring)) > 1e-6, 'empty or degenerate contour');
  for (let i = 0; i < ring.length; i++) {
    fail(
      distance(ring[i], ring[(i + 1) % ring.length]) > WELD,
      'contour edge below topology precision',
    );
    for (let j = i + 1; j < ring.length; j++) {
      if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
      fail(
        segmentContact(
          ring[i],
          ring[(i + 1) % ring.length],
          ring[j],
          ring[(j + 1) % ring.length],
        ) === 0,
        'self-intersecting contour',
      );
    }
  }
  return ring;
}
function ringsContact(a: Point2[], b: Point2[]): number {
  let result = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      result = Math.max(
        result,
        segmentContact(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length]),
      );
  return result;
}
function occupied(p: Point2, component: TerrainSupportComponent): boolean {
  return (
    insideRing(p, component.outline) === 1 &&
    !(component.holes ?? []).some((hole) => insideRing(p, hole) >= 0)
  );
}
function validateRegion(input: TerrainSupportComponent[]): TerrainSupportComponent[] {
  const components = input.map((c) => ({
    outline: cleanSupportRing(c.outline),
    holes: (c.holes ?? []).map(cleanSupportRing),
  }));
  for (const c of components) {
    for (let i = 0; i < c.holes.length; i++) {
      const hole = c.holes[i];
      fail(
        insideRing(hole[0], c.outline) === 1 && ringsContact(c.outline, hole) === 0,
        'hole outside or touching its outline',
      );
      for (const other of c.holes.slice(0, i))
        fail(
          ringsContact(hole, other) === 0 &&
            insideRing(hole[0], other) === -1 &&
            insideRing(other[0], hole) === -1,
          'overlapping or nested holes',
        );
    }
  }
  for (let i = 0; i < components.length; i++)
    for (let j = 0; j < i; j++) {
      const a = components[i],
        b = components[j];
      for (const ar of [a.outline, ...a.holes])
        for (const br of [b.outline, ...b.holes])
          fail(ringsContact(ar, br) < 2, 'components require a normalized union');
      fail(
        !a.outline.some((p) => occupied(p, b)) && !b.outline.some((p) => occupied(p, a)),
        'overlapping occupied components',
      );
    }
  return components;
}

function approachOutline(approach: TerrainSupportApproach): Point2[] {
  const [a, b] = approach.edge,
    offset = (p: Point2): Point2 => [
      p[0] + approach.outward[0] * approach.length,
      p[1] + approach.outward[1] * approach.length,
    ];
  return [a, b, offset(b), offset(a)];
}

/** Full interval coverage, including a near edge spanning several collinear contour edges. */
function validateApproachAttachment(
  approach: TerrainSupportApproach,
  components: TerrainSupportComponent[],
) {
  const [a, b] = approach.edge,
    dx = b[0] - a[0],
    dz = b[1] - a[1],
    width = Math.hypot(dx, dz),
    intervals: [number, number][] = [];
  for (const ring of components.flatMap((c) => [c.outline, ...(c.holes ?? [])]))
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i],
        q = ring[(i + 1) % ring.length];
      if (Math.abs(cross(a, b, p)) > EPS * width || Math.abs(cross(a, b, q)) > EPS * width)
        continue;
      const t0 = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (width * width),
        t1 = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / (width * width),
        lo = Math.max(0, Math.min(t0, t1)),
        hi = Math.min(1, Math.max(t0, t1));
      if (hi > lo) intervals.push([lo, hi]);
    }
  intervals.sort(([a0, a1], [b0, b1]) => a0 - b0 || a1 - b1);
  let covered = 0;
  for (const [lo, hi] of intervals) {
    fail(
      lo <= covered + EPS / width,
      `approach ${approach.id} near edge is not fully attached to the occupied boundary`,
    );
    covered = Math.max(covered, hi);
  }
  fail(
    covered >= 1 - EPS / width,
    `approach ${approach.id} near edge is not fully attached to the occupied boundary`,
  );
}

/** Exact triangle clipping detects intersections even when neither polygon contains the other's corners. */
function approachOverlapArea(
  approach: TerrainSupportApproach,
  components: TerrainSupportComponent[],
): number {
  const [a, b] = approach.edge,
    ex = b[0] - a[0],
    ez = b[1] - a[1],
    dx = approach.outward[0] * approach.length,
    dz = approach.outward[1] * approach.length,
    determinant = ex * dz - ez * dx;
  const uv = (p: Point2): Point2 => [
    ((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / determinant,
    (ex * (p[1] - a[1]) - ez * (p[0] - a[0])) / determinant,
  ];
  let area = 0;
  for (const component of components) {
    const shape = triangulate(component.outline, component.holes, 1e-9);
    fail(
      shape.triangles.length > 0 && Math.abs(shape.coverage - 1) <= 1e-7,
      'support contour cannot be triangulated',
    );
    for (let i = 0; i < shape.triangles.length; i += 3) {
      const clipped = clipRing(
        shape.triangles.slice(i, i + 3).map((id) => uv(shape.points[id])),
        [0, 0],
        [1, 1],
      );
      area += Math.abs(signedArea(clipped)) * Math.abs(determinant);
    }
  }
  return area;
}

function validateApproaches(rule: FoundationSupportRuleV2, local: TerrainSupportComponent[]) {
  const previous: TerrainSupportComponent[] = [];
  for (const approach of rule.approaches ?? []) {
    validateApproachAttachment(approach, local);
    const areaTolerance = Math.max(1e-8, distance(...approach.edge) * approach.length * 1e-10);
    // With an attached near edge, no occupied interior overlap also proves that
    // the perpendicular direction points outward, including entrances facing a hole.
    fail(
      approachOverlapArea(approach, local) <= areaTolerance,
      `approach ${approach.id} points inward or overlaps an occupied component`,
    );
    fail(
      approachOverlapArea(approach, previous) <= areaTolerance,
      `approach ${approach.id} overlaps another approach`,
    );
    previous.push({ outline: approachOutline(approach) });
  }
}

function ownerTransform(rule: FoundationSupportRuleV2, owner: BuildingInstance) {
  fail(
    owner.assetId === rule.assetId &&
      (rule.ownerId === undefined || rule.ownerId === owner.entityId),
    'owner does not match selector',
  );
  fail(Object.values(owner.position).every(Number.isFinite), 'non-finite owner position');
  const q = owner.rotation;
  fail(
    [q.x, q.y, q.z, q.w].every(Number.isFinite) &&
      Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) <= 1e-6,
    'invalid owner rotation',
  );
  fail(Math.abs(q.x) + Math.abs(q.z) <= 1e-8, 'tilted owners are not supported');
  const yaw = 2 * Math.atan2(q.y, q.w),
    c = Math.cos(yaw),
    s = Math.sin(yaw);
  return (p: Point2): Point2 => [
    owner.position.x + c * p[0] + s * p[1],
    owner.position.z - s * p[0] + c * p[1],
  ];
}
function clampGridPoint(grid: TerrainGrid, p: Point2): Point2 {
  const maxX = grid.origin.x + (grid.columns - 1) * grid.spacing,
    maxZ = grid.origin.z + (grid.rows - 1) * grid.spacing;
  fail(
    p[0] >= grid.origin.x - EPS &&
      p[0] <= maxX + EPS &&
      p[1] >= grid.origin.z - EPS &&
      p[1] <= maxZ + EPS,
    'footprint outside terrain',
  );
  return [
    Math.max(grid.origin.x, Math.min(maxX, p[0])),
    Math.max(grid.origin.z, Math.min(maxZ, p[1])),
  ];
}

/** Node every shared cap edge before extruding; ear-clipping diagonals are not solid boundaries. */
function conformPatch(
  grid: TerrainGrid,
  source: TerrainTriangle[],
  components: TerrainSupportComponent[],
): TerrainTriangle[] {
  const vertices: Vec3[] = [],
    weldBuckets = new Map<string, number[]>();
  const node = (point: Point2): number => {
    const [x, z] = clampGridPoint(grid, point),
      column = Math.floor(x / NODE_EPS),
      row = Math.floor(z / NODE_EPS),
      key = `${column},${row}`;
    let id: number | undefined;
    // Search neighboring buckets: equal intersections can straddle a rounding-bin
    // boundary. A single rounded key leaves sub-micrometre edges and inverted fans.
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const candidate of weldBuckets.get(`${column + dx},${row + dz}`) ?? [])
          if (
            Math.hypot(vertices[candidate].x - x, vertices[candidate].z - z) <= NODE_EPS &&
            (id === undefined || candidate < id)
          )
            id = candidate;
    if (id === undefined) {
      id = vertices.length;
      const bucket = weldBuckets.get(key) ?? [];
      bucket.push(id);
      weldBuckets.set(key, bucket);
      const sampled = sampleTerrain(grid, x, z);
      fail(sampled, 'missing terrain at support vertex');
      vertices.push({ x, y: sampled!.height, z });
    }
    return id;
  };
  const faces = source.map((t) => t.map((p) => node(xz(p)))).filter((t) => new Set(t).size === 3);
  const buckets = new Map<string, number[]>(),
    bucket = (n: number, origin: number) => Math.floor((n - origin) / grid.spacing);
  vertices.forEach((v, i) => {
    const key = `${bucket(v.x, grid.origin.x)},${bucket(v.z, grid.origin.z)}`,
      list = buckets.get(key) ?? [];
    list.push(i);
    buckets.set(key, list);
  });
  const output: number[][] = [];
  for (const face of faces) {
    const boundary: number[] = [];
    for (let edge = 0; edge < 3; edge++) {
      const from = face[edge],
        to = face[(edge + 1) % 3],
        a = vertices[from],
        b = vertices[to],
        dx = b.x - a.x,
        dz = b.z - a.z,
        squared = dx * dx + dz * dz,
        hits: { id: number; t: number }[] = [];
      boundary.push(from);
      for (
        let row = bucket(Math.min(a.z, b.z) - EPS, grid.origin.z);
        row <= bucket(Math.max(a.z, b.z) + EPS, grid.origin.z);
        row++
      )
        for (
          let col = bucket(Math.min(a.x, b.x) - EPS, grid.origin.x);
          col <= bucket(Math.max(a.x, b.x) + EPS, grid.origin.x);
          col++
        )
          for (const id of buckets.get(`${col},${row}`) ?? []) {
            if (id === from || id === to) continue;
            const v = vertices[id],
              t = ((v.x - a.x) * dx + (v.z - a.z) * dz) / squared;
            if (t > 0 && t < 1 && onSegment(xz(v), xz(a), xz(b), NODE_EPS)) hits.push({ id, t });
          }
      hits.sort((a, b) => a.t - b.t || a.id - b.id);
      boundary.push(...hits.map((h) => h.id));
    }
    if (boundary.length === 3) output.push(face);
    else {
      const center = node([
        face.reduce((sum, id) => sum + vertices[id].x / 3, 0),
        face.reduce((sum, id) => sum + vertices[id].z / 3, 0),
      ]);
      for (let i = 0; i < boundary.length; i++)
        output.push([center, boundary[i], boundary[(i + 1) % boundary.length]]);
    }
  }
  // The collision contract welds at 1 micrometre. Two independently clipped
  // diagonals may leave a valid sub-micrometre sliver here that that weld turns
  // into a degenerate face. Contract the same nodes throughout the cap, then
  // remove only the faces whose edges actually collapsed. This preserves shared
  // edges; deleting a thin face in isolation would leave an open solid. Keep the
  // 10 nm noding above: using the coarser tolerance for edge cuts can invert fans.
  const collisionNodes = new Map<string, number>();
  const collisionIds = vertices.map((vertex, id) => {
    const key = `${Math.round(vertex.x * 1e6)},${Math.round(vertex.z * 1e6)}`;
    const previous = collisionNodes.get(key);
    if (previous !== undefined) return previous;
    collisionNodes.set(key, id);
    return id;
  });
  const contractedFaces = output
    .map((face) => face.map((id) => collisionIds[id]))
    .filter((face) => new Set(face).size === 3);
  // A whole thin clipped polygon can collapse into a backtracking fan. Cancel
  // exact opposite faces together: their oriented boundary and volume sum to
  // zero. Removing a lone inverted/sliver face would instead open the solid.
  const pendingFaces = new Map<string, number[]>(),
    cancelledFaces = new Set<number>();
  contractedFaces.forEach((face, index) => {
    const start = face.indexOf(Math.min(...face)),
      a = face[start],
      b = face[(start + 1) % 3],
      c = face[(start + 2) % 3],
      opposite = pendingFaces.get(`${a},${c},${b}`)?.pop();
    if (opposite !== undefined) {
      cancelledFaces.add(opposite);
      cancelledFaces.add(index);
    } else {
      const key = `${a},${b},${c}`,
        pending = pendingFaces.get(key) ?? [];
      pending.push(index);
      pendingFaces.set(key, pending);
    }
  });
  const collisionFaces = contractedFaces.filter((_, index) => !cancelledFaces.has(index));
  const edges = new Map<string, { count: number; balance: number; from: number; to: number }>();
  let area = 0;
  for (const face of collisionFaces) {
    const turn = cross(xz(vertices[face[0]]), xz(vertices[face[1]]), xz(vertices[face[2]]));
    fail(
      turn < -1e-10,
      `degenerate or inverted support cap triangle (${turn}; ${JSON.stringify(face.map((id) => xz(vertices[id])))})`,
    );
    area -= turn / 2;
    for (let i = 0; i < 3; i++) {
      const from = face[i],
        to = face[(i + 1) % 3],
        key = `${Math.min(from, to)},${Math.max(from, to)}`,
        entry = edges.get(key) ?? { count: 0, balance: 0, from, to };
      entry.count++;
      entry.balance += from < to ? 1 : -1;
      edges.set(key, entry);
    }
  }
  const rings = components.flatMap((c) => [c.outline, ...(c.holes ?? [])]);
  for (const edge of edges.values()) {
    fail(edge.count === 1 || (edge.count === 2 && edge.balance === 0), 'non-manifold support cap');
    if (edge.count === 1) {
      const a = xz(vertices[edge.from]),
        b = xz(vertices[edge.to]);
      fail(
        rings.some((ring) =>
          ring.some(
            (p, i) =>
              onSegment(a, p, ring[(i + 1) % ring.length], EPS * 4) &&
              onSegment(b, p, ring[(i + 1) % ring.length], EPS * 4),
          ),
        ),
        'unmatched internal support edge',
      );
    }
  }
  const expected = components.reduce(
      (sum, c) =>
        sum +
        Math.abs(signedArea(c.outline)) -
        (c.holes ?? []).reduce((n, h) => n + Math.abs(signedArea(h)), 0),
      0,
    ),
    perimeter = rings.reduce(
      (sum, r) => sum + r.reduce((n, p, i) => n + distance(p, r[(i + 1) % r.length]), 0),
      0,
    );
  fail(
    Math.abs(area - expected) <= Math.max(1e-6, perimeter * EPS * 4, expected * 1e-8),
    'support cap area differs from occupied region',
  );
  return collisionFaces.map((face) => face.map((id) => vertices[id]) as unknown as TerrainTriangle);
}
function regionPatch(grid: TerrainGrid, components: TerrainSupportComponent[]): TerrainTriangle[] {
  const raw: TerrainTriangle[] = [];
  for (const component of components) {
    const shape = triangulate(component.outline, component.holes, 1e-9);
    fail(
      shape.triangles.length > 0 && Math.abs(shape.coverage - 1) <= 1e-7,
      'support contour cannot be triangulated',
    );
    for (let i = 0; i < shape.triangles.length; i += 3)
      for (const triangle of terrainPatch(
        grid,
        shape.triangles.slice(i, i + 3).map((id) => shape.points[id]),
      ))
        raw.push(triangle);
  }
  return conformPatch(grid, raw, components);
}
function prepare(grid: TerrainGrid, rule: FoundationSupportRuleV2, owner: BuildingInstance) {
  validateFoundationSupportRule(rule);
  const transform = ownerTransform(rule, owner),
    local = validateRegion(rule.components);
  validateApproaches(rule, local);
  const world = local.map((c) => ({
      outline: c.outline.map((p) => clampGridPoint(grid, transform(p))),
      holes: c.holes!.map((h) => h.map((p) => clampGridPoint(grid, transform(p)))),
    })),
    patch = regionPatch(grid, world),
    range = patchRange(patch),
    approaches = (rule.approaches ?? []).map((approach) => {
      const ring = approachOutline(approach).map((p) => clampGridPoint(grid, transform(p))),
        patch = regionPatch(grid, [{ outline: ring }]);
      return { approach, patch, range: patchRange(patch), start: ring[0], far: ring[3] };
    });
  return { patch, range, approaches };
}

export function selectSupportRule(
  rules: TerrainSupportRule[],
  owner: BuildingInstance,
): FoundationSupportRuleV2 | undefined {
  const matches = rules.filter(
    (r): r is FoundationSupportRuleV2 =>
      r.kind === 'foundation-v2' &&
      r.assetId === owner.assetId &&
      (r.ownerId === undefined || r.ownerId === owner.entityId),
  );
  const overrides = matches.filter((r) => r.ownerId !== undefined),
    defaults = matches.filter((r) => r.ownerId === undefined);
  fail(overrides.length <= 1 && defaults.length <= 1, 'duplicate support selector');
  return overrides[0] ?? defaults[0];
}
/**
 * Conservative admissible owner Y, including terrain over every approach.
 * The far edge already blends exactly to terrain; including its maximum can
 * raise the planned Y, but never produces an approach crossing the ground.
 */
export function planSupportPlacement(
  grid: TerrainGrid,
  rule: FoundationSupportRuleV2,
  owner: BuildingInstance,
) {
  const { range, approaches } = prepare(grid, rule, owner);
  return {
    minimumY: Math.max(
      range.max + rule.clearance - rule.jointY,
      range.max - rule.burial + RENDER_CAP_GAP + NODE_EPS - rule.jointY,
      ...approaches.map(({ approach, range }) => range.max - approach.targetY),
    ),
    terrainMin: range.min,
    terrainMax: range.max,
    jointY: rule.jointY,
  };
}
export interface GeneratedSupportAsset {
  role: 'foundation' | `approach:${string}`;
  asset: GeneratedTerrainAsset;
}
export function generateSupportAssets(
  grid: TerrainGrid,
  rule: FoundationSupportRuleV2,
  owner: BuildingInstance,
  ids: { foundation: string; approaches: Record<string, string> },
): GeneratedSupportAsset[] {
  const { patch, range, approaches } = prepare(grid, rule, owner),
    joint = owner.position.y + rule.jointY;
  fail(
    joint + 1e-8 >= range.max + rule.clearance,
    `owner Y ${owner.position.y} is below minimum ${range.max + rule.clearance - rule.jointY}`,
  );
  fail(
    patch.every((t) => t.every((p) => joint - RENDER_CAP_GAP > p.y - rule.burial)),
    'inverted foundation solid',
  );
  const foundation = terrainSolid(
    ids.foundation,
    patch,
    () => joint,
    (p) => p.y - rule.burial,
    rule.color,
  );
  // Only the horizontal cap is hidden below the existing floor. Side walls retain
  // the physical extent, so the compiler's visual bounds still enclose the collider.
  for (let i = 0; i < patch.length; i++)
    for (let j = 0; j < 3; j++) foundation.parts[0].positions[i * 18 + j * 3 + 1] -= RENDER_CAP_GAP;
  validateBuildingPhysicsAsset(foundation.physics);
  const output: GeneratedSupportAsset[] = [{ role: 'foundation', asset: foundation }];
  for (const { approach, patch: ramp, start, far } of approaches) {
    const id = ids.approaches[approach.id];
    fail(id, `missing approach asset ID ${approach.id}`);
    const dx = far[0] - start[0],
      dz = far[1] - start[1],
      squared = dx * dx + dz * dz,
      target = owner.position.y + approach.targetY,
      top = (p: Vec3) => {
        const t = Math.max(
          0,
          Math.min(1, ((p.x - start[0]) * dx + (p.z - start[1]) * dz) / squared),
        );
        return target * (1 - t) + p.y * t;
      };
    // The blend supplies vertex samples; the emitted mesh interpolates them
    // linearly inside each final-terrain triangle. Comparing those affine mesh
    // surfaces at their vertices also checks the whole ramp interior.
    fail(
      ramp.every((t) => t.every((p) => top(p) >= p.y - 1e-8 && top(p) > p.y - rule.burial)),
      `approach ${approach.id} intersects terrain or inverts its solid`,
    );
    const asset = terrainSolid(id, ramp, top, (p) => p.y - rule.burial, approach.color);
    validateBuildingPhysicsAsset(asset.physics);
    output.push({ role: `approach:${approach.id}`, asset });
  }
  return output;
}
