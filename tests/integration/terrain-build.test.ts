import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  terrainCellTriangles,
  terrainPlaneHeight,
  type TerrainGrid,
  type TerrainTriangle,
} from '../../packages/contracts/src/index.js';
import {
  generateTerrainTile,
  prepareTerrainBuildContext,
  rectangle,
  terrainPatch,
  type Point2,
  type TerrainSurface,
} from '../../packages/terrain-build/src/index.js';

// Frozen brute-force clipping reference from tools/world-build/src/terrain.ts,
// SHA256 23bb7df1e6ecb1e4506cfb65194e66a2e33d2180fad6ceab736649f1847831d3.
// Deliberately visits every original cell; do not optimize it with the implementation.
const oldArea = (ring: readonly Point2[]) =>
  ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;
const oldCross = (a: Point2, b: Point2, c: Point2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function oldClip(subject: Point2[], boundary: readonly Point2[]) {
  const ring = oldArea(boundary) < 0 ? [...boundary].reverse() : boundary;
  let out = subject;
  for (let e = 0; e < ring.length; e++) {
    const a = ring[e],
      b = ring[(e + 1) % ring.length],
      input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[(i + input.length - 1) % input.length],
        q = input[i];
      const cp = oldCross(a, b, p),
        cq = oldCross(a, b, q);
      if (cp < -1e-10 !== cq < -1e-10) {
        const t = cp / (cp - cq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
      if (cq >= -1e-10) out.push(q);
    }
    out = out.filter(
      (p, i) =>
        Math.hypot(
          p[0] - out[(i + out.length - 1) % out.length][0],
          p[1] - out[(i + out.length - 1) % out.length][1],
        ) > 1e-9,
    );
  }
  return out.length >= 3 && Math.abs(oldArea(out)) > 1e-10 ? out : [];
}
function oldPatch(g: TerrainGrid, convex: readonly Point2[]): TerrainTriangle[] {
  const output: TerrainTriangle[] = [];
  for (let row = 0; row < g.rows - 1; row++)
    for (let column = 0; column < g.columns - 1; column++)
      for (const triangle of terrainCellTriangles(g, column, row)) {
        const polygon = oldClip(
          triangle.map((p) => [p.x, p.z]),
          convex,
        );
        if (!polygon.length) continue;
        const vertices = polygon.map(([x, z]) => ({ x, y: terrainPlaneHeight(triangle, x, z), z }));
        if (vertices.length === 3) {
          output.push(vertices as unknown as TerrainTriangle);
          continue;
        }
        const center = vertices.reduce(
          (sum, p) => ({
            x: sum.x + p.x / vertices.length,
            y: sum.y + p.y / vertices.length,
            z: sum.z + p.z / vertices.length,
          }),
          { x: 0, y: 0, z: 0 },
        );
        for (let i = 0; i < vertices.length; i++)
          output.push([center, vertices[i], vertices[(i + 1) % vertices.length]]);
      }
  return output;
}
const grid = (): TerrainGrid => ({
  formatVersion: 1,
  origin: { x: -2.5, z: -3.25 },
  spacing: 0.75,
  columns: 7,
  rows: 6,
  bottom: -10,
  heights: Array.from(
    { length: 42 },
    (_, i) => Math.sin(i * 1.37) * 1.2 + Math.cos(i * 0.43) * 0.7,
  ),
});
const full = () => rectangle(-0.25, -1.375, 4.5, 3.75);
const layers = (): TerrainSurface[] => [
  {
    id: 'road',
    outline: rectangle(-0.2, -1.4, 3, 2.5),
    holes: [rectangle(-0.1, -1.4, 0.6, 0.7)],
    color: '#999999',
    offset: 0.02,
  },
  { id: 'marking-z', outline: rectangle(-0.2, -1.4, 2.9, 0.08), color: '#ffffff', offset: 0.03 },
  { id: 'marking-a', outline: rectangle(-0.2, -1.4, 0.08, 2.4), color: '#ffff00', offset: 0.03 },
  { id: 'disjoint', outline: rectangle(1.75, 0.25, 0.2, 0.2), color: '#999999', offset: 0.02 },
];
const cases: { id: string; polygon: Point2[] }[] = [
  { id: 'full extent', polygon: full() },
  { id: 'one aligned cell', polygon: rectangle(-1.375, -2.125, 0.75, 0.75) },
  { id: 'fractional cut', polygon: rectangle(-0.34, -1.13, 1.83, 1.27) },
  { id: 'rotated footprint', polygon: rectangle(-0.4, -1.7, 1.4, 1.1, Math.PI / 7) },
  { id: 'thin grid crossing', polygon: rectangle(-1.75, -1.25, 0.02, 2.2) },
  { id: 'partially outside', polygon: rectangle(-2.4, -3.1, 1.3, 1.1) },
  { id: 'fully outside', polygon: rectangle(10, 10, 1, 1) },
  { id: 'touches outer boundary', polygon: rectangle(2.5, -1.5, 1, 1) },
  { id: 'clockwise', polygon: rectangle(-0.34, -1.13, 1.83, 1.27).reverse() },
  {
    id: 'triangle diagonal',
    polygon: [
      [-1.75, -2.5],
      [-1, -1.75],
      [-1, -2.5],
    ],
  },
  {
    id: 'collinear boundary',
    polygon: [
      [-2, -3],
      [-1.5, -3],
      [-1, -3],
      [-1, -2],
      [-2, -2],
    ],
  },
  { id: 'subcell tiny', polygon: rectangle(-1.375, -2.1249, 0.0003, 0.0003) },
  { id: 'epsilon boundary sliver', polygon: rectangle(2.5 - 1e-8, -1.5, 1, 1) },
];

describe('terrain generation compatibility', () => {
  it.each(cases)('retains exact brute-force triangle and vertex order: $id', ({ polygon }) => {
    const g = grid();
    expect(terrainPatch(g, polygon)).toEqual(oldPatch(g, polygon));
  });
  it.each<{ id: string; polygon: Point2[] }>([
    { id: 'near-axis rotation', polygon: rectangle(-0.34, -1.13, 1.83, 1.27, 1e-12) },
    {
      id: 'exact grid-diagonal rotation',
      polygon: rectangle(-0.34, -1.13, 1.83, 1.27, Math.PI / 4),
    },
    {
      id: 'near grid-diagonal rotation',
      polygon: rectangle(-0.34, -1.13, 1.83, 1.27, Math.PI / 4 + 1e-12),
    },
    {
      id: 'negative offset near clipping tolerance',
      polygon: rectangle(-1.375 - 1e-10, -2.125 - 1e-10, 0.75, 0.75),
    },
    { id: 'just beyond grid at clipping tolerance', polygon: rectangle(2.5 + 5e-11, -1.5, 1, 1) },
  ])('preserves epsilon-sensitive intersections: $id', ({ polygon }) => {
    const g = grid();
    expect(terrainPatch(g, polygon)).toEqual(oldPatch(g, polygon));
  });
  it.each<{ id: string; polygon: Point2[] }>([
    { id: 'empty', polygon: [] },
    { id: 'single point', polygon: [[0, 0]] },
    {
      id: 'two points',
      polygon: [
        [0, 0],
        [1, 1],
      ],
    },
    {
      id: 'zero edge',
      polygon: [
        [-2, -3],
        [-2, -3],
        [-1, -3],
        [-1, -2],
        [-2, -2],
      ],
    },
    {
      id: 'nonfinite',
      polygon: [
        [0, 0],
        [NaN, 1],
        [1, 0],
      ],
    },
    {
      id: 'nonconvex',
      polygon: [
        [-2, -3],
        [0, -3],
        [-1.5, -2],
        [0, -1],
        [-2, -1],
      ],
    },
    {
      id: 'acute',
      polygon: [
        [0, 0],
        [1, 0],
        [1e-10, 1e-12],
      ],
    },
  ])('preserves the pre-optimization fallback for $id input', ({ polygon }) => {
    const g = grid();
    expect(terrainPatch(g, polygon)).toEqual(oldPatch(g, polygon));
  });

  it('prepares once without changing ordered ground, holes, tied layers or collider data', () => {
    const g = grid(),
      surfaces = layers(),
      context = prepareTerrainBuildContext(g, surfaces);
    for (const boundary of [
      full(),
      rectangle(-1.1875, -1.375, 2.625, 3.75),
      rectangle(1.0625, -1.375, 1.875, 3.75),
    ]) {
      expect(generateTerrainTile('same-id', g, boundary, surfaces, context)).toEqual(
        generateTerrainTile('same-id', g, boundary, surfaces),
      );
    }
    expect(
      generateTerrainTile('same-id', g, full(), surfaces, context).parts.map((p) => p.partId),
    ).toEqual(['solid', 'disjoint', 'road', 'marking-a', 'marking-z']);
  });

  it('shares smooth normals on a publication seam that cuts through grid cells', () => {
    const g = grid(),
      surfaces = layers(),
      context = prepareTerrainBuildContext(g, surfaces);
    const left = generateTerrainTile(
      'left',
      g,
      rectangle(-1.1875, -1.375, 2.625, 3.75),
      surfaces,
      context,
    );
    const right = generateTerrainTile(
      'right',
      g,
      rectangle(1.0625, -1.375, 1.875, 3.75),
      surfaces,
      context,
    );
    const seam = (parts: typeof left.parts) => {
      const result = new Map<string, number[]>();
      for (const part of parts)
        for (let i = 0; i < part.positions.length; i += 3)
          if (Math.abs(part.positions[i] - 0.125) < 1e-8 && part.normals[i + 1] > 0)
            result.set(
              `${part.partId}:${part.positions[i + 1].toFixed(8)}:${part.positions[i + 2].toFixed(8)}`,
              part.normals.slice(i, i + 3),
            );
      return result;
    };
    const a = seam(left.parts),
      b = seam(right.parts);
    expect(a.size).toBeGreaterThan(5);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [key, normal] of a)
      normal.forEach((component, i) => expect(b.get(key)![i]).toBeCloseTo(component, 12));
  });

  it('uses an immutable prepared snapshot and refreshes only with a fresh context', () => {
    const g = grid(),
      surfaces = layers(),
      context = prepareTerrainBuildContext(g, surfaces);
    const before = generateTerrainTile('snapshot', g, full(), surfaces, context);
    g.heights[5] += 0.4;
    surfaces[0].offset += 0.005;
    surfaces[0].outline[0] = [surfaces[0].outline[0][0] + 0.1, surfaces[0].outline[0][1]];
    surfaces[0].holes![0][0] = [surfaces[0].holes![0][0][0] + 0.03, surfaces[0].holes![0][0][1]];
    expect(generateTerrainTile('snapshot', g, full(), surfaces, context)).toEqual(before);
    const fresh = generateTerrainTile(
      'snapshot',
      g,
      full(),
      surfaces,
      prepareTerrainBuildContext(g, surfaces),
    );
    expect(fresh).not.toEqual(before);
    expect(fresh).toEqual(generateTerrainTile('snapshot', g, full(), surfaces));
  });

  it('rejects a context reused with another grid or another surface array', () => {
    const g = grid(),
      surfaces = layers(),
      context = prepareTerrainBuildContext(g, surfaces);
    expect(() =>
      generateTerrainTile('foreign-grid', structuredClone(g), full(), surfaces, context),
    ).toThrow();
    expect(() =>
      generateTerrainTile('foreign-surfaces', g, full(), [...surfaces], context),
    ).toThrow();
  });

  it('validates disjoint surface geometry before filtering by publication tile', () => {
    const g = grid();
    const invalid = [
      {
        id: 'invalid-outside',
        outline: rectangle(100, 100, 4, 4),
        holes: [rectangle(110, 110, 1, 1)],
        color: '#ffffff',
        offset: 0.02,
      },
    ];
    expect(() => prepareTerrainBuildContext(g, invalid)).toThrow('Hole is outside');
    expect(() => generateTerrainTile('outside', g, full(), invalid)).toThrow('Hole is outside');
  });

  it('imports the shared package and serializes geometry from an empty working directory', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'su-terrain-package-'));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const entry = pathToFileURL(join(root, 'packages/terrain-build/src/index.ts')).href;
    const glb = pathToFileURL(join(root, 'packages/terrain-build/src/glb.ts')).href;
    const loader = createRequire(import.meta.url).resolve('tsx');
    const script = `
      import assert from 'node:assert/strict';
      const terrain = await import(${JSON.stringify(entry)});
      const { encodeStaticGlb, inspectStaticGlb } = await import(${JSON.stringify(glb)});
      const grid = {formatVersion:1,origin:{x:0,z:0},spacing:1,columns:2,rows:2,bottom:-2,heights:[0,.2,.1,.4]};
      const generated = terrain.generateTerrainTile('standalone', grid, terrain.rectangle(.5,.5,1,1), []);
      const serial = JSON.stringify(generated);
      assert.equal(JSON.stringify(JSON.parse(serial)), serial);
      const bytes = encodeStaticGlb(generated.parts);
      const inspected = inspectStaticGlb(bytes, 'standalone');
      for (const edge of ['min','max']) for (const axis of ['x','y','z'])
        assert.ok(Math.abs(inspected.bounds[edge][axis]-generated.physics.bounds[edge][axis])<1e-6);
      assert.equal(inspected.parts.parts.length, generated.parts.length);
      console.log(JSON.stringify({assetId:generated.physics.assetId,glbBytes:bytes.length,colliders:generated.physics.colliders.length}));
    `;
    try {
      const stdout = execFileSync(
        process.execPath,
        ['--import', loader, '--input-type=module', '-e', script],
        { cwd: temporary, encoding: 'utf8', timeout: 15_000 },
      );
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({ assetId: 'standalone', colliders: 1 });
      expect(result.glbBytes).toBeGreaterThan(100);
      expect(await readdir(temporary)).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
