import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  sampleTerrain,
  type BuildingInstance,
  type TerrainGrid,
} from '../../packages/contracts/src/index.js';
import {
  generateTerrainTile,
  prepareTerrainBuildContext,
  rectangle,
} from '../../packages/terrain-build/src/terrain.js';
import { generateGround, type GroundRecipe } from '../../tools/world-build/src/city.js';
import { createGroundTerrain } from '../../tools/world-build/src/ground-terrain.js';

const placement: BuildingInstance = {
  entityId: 'ground',
  assetId: 'ground',
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};
const source: GroundRecipe = JSON.parse(
  readFileSync(
    new URL('../../content/buildings/ring-block/ring-block-ground/source.json', import.meta.url),
    'utf8',
  ),
);
const small = (): GroundRecipe => ({
  formatVersion: 1,
  min: [-4, -4],
  max: [4, 4],
  depth: 1,
  color: '#d9cbb1',
  layers: [
    {
      id: 'road',
      color: '#333333',
      elevation: 0.034,
      polygons: [
        [
          [
            [-3, -3],
            [3, -3],
            [3, 3],
            [-3, 3],
          ],
          [
            [-1, -1],
            [-1, 1],
            [1, 1],
            [1, -1],
          ],
        ],
      ],
    },
    {
      id: 'markings',
      color: '#ffffff',
      elevation: 0.042,
      polygons: [
        [
          [
            [2, -2],
            [2.5, -2],
            [2.5, 2],
            [2, 2],
          ],
        ],
      ],
    },
  ],
});
const fingerprint = (triangles: readonly (readonly (readonly number[])[])[]) => {
  const normalized = triangles
    .map((t) => canonicalJson([...t].sort((a, b) => a[0] - b[0] || a[1] - b[1])))
    .sort();
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
};

describe('existing city ground to terrain conversion', () => {
  it('keeps narrow roads, holes and markings on an independent coarse lattice without resampling', () => {
    const grid: TerrainGrid = {
      formatVersion: 1,
      origin: { x: -5, z: -7 },
      spacing: 20,
      columns: 2,
      rows: 2,
      bottom: -1,
      heights: [0, 0.2, 0.3, 0.5],
    };
    const recipe = small();
    const converted = createGroundTerrain(recipe, placement, 20, grid);
    expect(converted.grid).toEqual(grid);
    expect(converted.grid).not.toBe(grid);
    expect(converted.surfaces).toEqual(createGroundTerrain(recipe, placement, 4).surfaces);
    const tile = generateTerrainTile(
      'coarse-road',
      converted.grid,
      rectangle(0, 0, 8, 8),
      converted.surfaces,
    );
    for (const [index, expectedArea] of [32, 2].entries()) {
      const surface = converted.surfaces[index];
      const part = tile.parts.find((p) => p.partId === surface.id)!;
      expect(part.color).toBe(surface.color);
      let area = 0;
      for (let i = 0; i < part.indices.length; i += 3) {
        const [a, b, c] = part.indices
          .slice(i, i + 3)
          .map((id) => part.positions.slice(id * 3, id * 3 + 3));
        area += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
      }
      expect(area).toBeCloseTo(expectedArea, 8);
      for (let i = 0; i < part.positions.length; i += 3) {
        const [x, y, z] = part.positions.slice(i, i + 3);
        expect(y).toBeCloseTo(sampleTerrain(grid, x, z)!.height + surface.offset, 10);
      }
    }
    expect(() => createGroundTerrain(recipe, placement, 20)).toThrow(/explicit 20 metre/);
    expect(() => createGroundTerrain(recipe, placement, 20, { ...grid, spacing: 4 })).toThrow(
      /cover the ground extent/,
    );
    expect(() =>
      createGroundTerrain(recipe, placement, 20, { ...grid, origin: { x: -3, z: -7 } }),
    ).toThrow(/cover the ground extent/);
    expect(() => createGroundTerrain({ ...recipe, color: 'invalid' }, placement, 20, grid)).toThrow(
      /Invalid ground terrain recipe/,
    );
  });

  it.each([
    { spacing: 4 as const, columns: 877, rows: 427 },
    { spacing: 20 as const, columns: 177, rows: 87 },
  ])(
    'preserves the complete city authoring with $spacing metre samples',
    ({ spacing, columns, rows }) => {
      const before = canonicalJson(source);
      const converted = createGroundTerrain(
        source,
        placement,
        spacing,
        spacing === 20
          ? {
              formatVersion: 1,
              origin: { x: -1501, z: -853 },
              spacing,
              columns,
              rows,
              bottom: -1,
              heights: Array(columns * rows).fill(0),
            }
          : undefined,
      );
      expect(converted.grid).toMatchObject({
        origin: { x: -1501, z: -853 },
        spacing,
        columns,
        rows,
        bottom: -1,
      });
      expect(converted.grid.heights).toHaveLength(columns * rows);
      expect(new Set(converted.grid.heights)).toEqual(new Set([0]));
      expect(converted.color).toBe('#d9cbb1');
      expect(converted.conversionDiagnostics).toMatchObject({
        sourcePolygonCount: 9934,
        sourceHoleCount: 282,
        sourceVertexCount: 165265,
        surfaceCount: 9953,
      });
      expect(converted.surfaces.flatMap((s) => s.holes ?? [])).toHaveLength(282);
      expect(converted.conversionDiagnostics.cleanedRings).toHaveLength(5);
      expect(converted.conversionDiagnostics.topologyNotes).toHaveLength(5);
      expect(new Set(converted.surfaces.map((s) => s.id)).size).toBe(converted.surfaces.length);
      let cursor = 0;
      for (const layer of source.layers) {
        for (const [index, polygon] of layer.polygons.entries()) {
          if (layer.id === 'green' && index === 290) {
            cursor += 20;
            continue;
          }
          const surface = converted.surfaces[cursor++];
          expect(surface.outline).toEqual(polygon[0]);
          expect(surface.holes ?? []).toEqual(polygon.slice(1));
          expect(surface.color).toBe(layer.color);
          expect(surface.offset).toBeCloseTo(layer.elevation * (20 / 21), 14);
        }
      }
      expect(cursor).toBe(converted.surfaces.length);
      expect(converted.surfaces.at(-1)!.offset).toBe(0.04);
      const ordered = [...converted.surfaces].sort(
        (a, b) => a.offset - b.offset || a.id.localeCompare(b.id),
      );
      expect(ordered.map((s) => s.id)).toEqual(converted.surfaces.map((s) => s.id));
      expect(canonicalJson(source)).toBe(before);
      // The strict shared generator accepts every converted surface, including holes at map edges.
      if (spacing === 4)
        expect(
          prepareTerrainBuildContext(converted.grid, converted.surfaces).surfaces,
        ).toHaveLength(9953);
    },
  );

  it('preserves the observed legacy visible triangle footprint without accepting changed defects', () => {
    const converted = createGroundTerrain(source, placement, 4);
    const exception = converted.conversionDiagnostics.exceptions;
    expect(exception).toHaveLength(1);
    expect(exception[0]).toMatchObject({
      strategy: 'legacy-triangle-footprint',
      layerId: 'green',
      polygonIndex: 290,
      triangleCount: 20,
      sourceSha256: '96a441e43a8dad7dea32d9d81644f3f09da161e1698825be8246026b6018b999',
      triangleFootprintSha256: 'b99fbffd2266235524fa60779967805b7466a0c55b46316deeb9d639cfae20dc',
    });
    expect(exception[0].legacyCoverage).toBeCloseTo(1.0068600963232681, 12);
    const legacy = generateGround('legacy-ground', {
      ...source,
      merge: false,
      layers: [
        {
          ...source.layers.find((layer) => layer.id === 'green')!,
          polygons: [source.layers.find((layer) => layer.id === 'green')!.polygons[290]],
        },
      ],
    }).parts.find((p) => p.partId === 'green')!;
    const originalTriangles: number[][][] = [];
    for (let i = 0; i < legacy.indices.length; i += 3)
      originalTriangles.push(
        legacy.indices
          .slice(i, i + 3)
          .map((index) => [legacy.positions[index * 3], legacy.positions[index * 3 + 2]]),
      );
    const convertedTriangles = converted.surfaces
      .filter((s) => s.id.includes('-legacy-'))
      .map((s) => s.outline);
    expect(originalTriangles).toHaveLength(20);
    expect(fingerprint(convertedTriangles)).toBe(fingerprint(originalTriangles));
    expect(fingerprint(originalTriangles)).toBe(
      'b99fbffd2266235524fa60779967805b7466a0c55b46316deeb9d639cfae20dc',
    );
    const changed = structuredClone(source);
    changed.layers.find((layer) => layer.id === 'green')!.polygons[290][0][0] = [-216.69, -691];
    expect(() => createGroundTerrain(changed, placement, 4)).toThrow(/green\.polygons\[290\]/);
  });

  it('applies only the authored translation and preserves holes and absolute layer offsets', () => {
    const recipe = small();
    const converted = createGroundTerrain(
      recipe,
      { ...placement, position: { x: 10, y: 7, z: -20 } },
      2,
    );
    expect(converted.grid).toMatchObject({
      origin: { x: 6, z: -24 },
      bottom: 6,
      columns: 5,
      rows: 5,
    });
    expect(new Set(converted.grid.heights)).toEqual(new Set([7]));
    expect(converted.surfaces[0].outline).toEqual([
      [7, -23],
      [13, -23],
      [13, -17],
      [7, -17],
    ]);
    expect(converted.surfaces[0].holes).toEqual([
      [
        [9, -21],
        [9, -19],
        [11, -19],
        [11, -21],
      ],
    ]);
    expect(converted.surfaces[1].offset).toBe(0.04);
    expect(converted.conversionDiagnostics.exceptions).toEqual([]);
  });

  it('rejects new self-intersections, outside holes and malformed grid/placement inputs', () => {
    const crossed = small();
    crossed.layers[0].polygons = [
      [
        [
          [-3, -3],
          [3, 3],
          [-3, 3],
          [3, -3],
        ],
      ],
    ];
    expect(() => createGroundTerrain(crossed, placement, 2)).toThrow(
      /Invalid ground terrain polygon road/,
    );
    const outsideHole = small();
    outsideHole.layers[0].polygons[0][1] = [
      [3.2, 0],
      [3.2, 1],
      [3.8, 1],
      [3.8, 0],
    ];
    expect(() => createGroundTerrain(outsideHole, placement, 2)).toThrow(
      /Invalid ground terrain polygon road/,
    );
    expect(() => createGroundTerrain({ ...small(), max: [5, 4] }, placement, 2)).toThrow(/align/);
    expect(() =>
      createGroundTerrain(small(), { ...placement, rotation: { x: 0, y: 1, z: 0, w: 0 } }, 2),
    ).toThrow(/axis-aligned/);
    const reordered = small();
    reordered.layers.reverse();
    expect(() => createGroundTerrain(reordered, placement, 2)).toThrow(/elevations must increase/);
  });
});
