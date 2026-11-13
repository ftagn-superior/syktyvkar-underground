import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  pointInsideClosedMesh,
  validateBuildingPhysicsAsset,
  type BuildingInstance,
  type TerrainGrid,
} from '../../packages/contracts/src/index.js';
import { compileGeneratedAsset } from '../../packages/terrain-build/src/assets.js';
import {
  generateSupportAssets,
  planSupportPlacement,
  selectSupportRule,
} from '../../packages/terrain-build/src/supports.js';
import {
  validateTerrainPrivateData,
  type FoundationSupportRuleV2,
} from '../../packages/terrain-build/src/private-data.js';

const grid = (): TerrainGrid => ({
  formatVersion: 1,
  origin: { x: -8, z: -8 },
  spacing: 1,
  columns: 17,
  rows: 17,
  heights: Array(289).fill(0),
  bottom: -3,
});
const owner = (y = 0, yaw = 0): BuildingInstance => ({
  entityId: 'owner-1',
  assetId: 'support-fixture',
  position: { x: 0, y, z: 0 },
  rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
});
const rule = (): FoundationSupportRuleV2 => ({
  kind: 'foundation-v2',
  assetId: 'support-fixture',
  components: [
    {
      outline: [
        [-4, -4],
        [4, -4],
        [4, 4],
        [2, 4],
        [2, 1],
        [-4, 1],
      ],
      holes: [
        [
          [-3, -3],
          [-1, -3],
          [-1, -1],
          [-3, -1],
        ],
      ],
    },
    {
      outline: [
        [-4, 2],
        [-2, 2],
        [-2, 4],
        [-4, 4],
      ],
    },
  ],
  jointY: -0.25,
  clearance: 0.08,
  burial: 0.1,
  color: '#8b8580',
});
const ids = { foundation: 'support-foundation', approaches: { east: 'support-approach' } };
const approachRule = (): FoundationSupportRuleV2 => ({
  ...rule(),
  components: [
    {
      outline: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
    },
  ],
  jointY: 0,
  clearance: 0.1,
  burial: 0.05,
  approaches: [
    {
      id: 'east',
      edge: [
        [-0.5, 1],
        [0.5, 1],
      ],
      outward: [0, 1],
      length: 4,
      targetY: 0,
      color: '#b5afa1',
    },
  ],
});

describe('complex foundations on the final terrain triangles', () => {
  it('contracts sub-micrometre cap cuts consistently before the collision-contract weld', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('../fixtures/terrain-support-collision-weld.json', import.meta.url),
        'utf8',
      ),
    ) as { grid: TerrainGrid; rule: FoundationSupportRuleV2; owner: BuildingInstance };
    const [result] = generateSupportAssets(fixture.grid, fixture.rule, fixture.owner, {
      foundation: 'submicrometre-foundation',
      approaches: {},
    });
    expect(() => validateBuildingPhysicsAsset(result.asset.physics)).not.toThrow();
    expect(() => compileGeneratedAsset(result.asset.physics.assetId, result.asset)).not.toThrow();
    const mesh = result.asset.physics.colliders[0];
    if (mesh.kind !== 'mesh') throw new Error('Expected a mesh');
    const area = (ring: readonly (readonly [number, number])[]) =>
      Math.abs(
        ring.reduce((sum, p, i) => {
          const q = ring[(i + 1) % ring.length];
          return sum + p[0] * q[1] - p[1] * q[0];
        }, 0),
      ) / 2;
    const expected = fixture.rule.components.reduce(
      (sum, component) =>
        sum +
        area(component.outline) -
        (component.holes ?? []).reduce((total, hole) => total + area(hole), 0),
      0,
    );
    let capArea = 0;
    const top = fixture.owner.position.y + fixture.rule.jointY;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = mesh.indices
        .slice(i, i + 3)
        .map((index) => mesh.vertices.slice(index * 3, index * 3 + 3));
      if ([a, b, c].every((p) => p[1] === top))
        capArea += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
    }
    expect(Math.abs(capArea - expected)).toBeLessThan(0.000001);
    // The regression is a four-component occupied region, including two real
    // 30 cm piers. The repair must retain each of these separate small solids.
    for (const component of [fixture.rule.components[0], ...fixture.rule.components.slice(2)]) {
      const center = component.outline.reduce(
        (sum, p) => ({
          x: sum.x + p[0] / component.outline.length,
          z: sum.z + p[1] / component.outline.length,
        }),
        { x: fixture.owner.position.x, z: fixture.owner.position.z },
      );
      expect(pointInsideClosedMesh({ ...center, y: top - 0.04 }, mesh.vertices, mesh.indices)).toBe(
        true,
      );
    }
  });

  it('uses the maximum over all occupied components while excluding a hole and a concave gap', () => {
    const g = grid(),
      r = rule();
    for (const [x, z, h] of [
      [0, -2, 3],
      [-2, -2, 9],
      [0, 3, 12],
      [-3, 3, 4],
    ])
      g.heights[(z + 8) * 17 + x + 8] = h;
    const plan = planSupportPlacement(g, r, owner());
    expect(plan.terrainMax).toBeCloseTo(4, 10);
    expect(plan.minimumY).toBeCloseTo(4.33, 10);
    const accepted = owner(plan.minimumY + 0.2),
      [result] = generateSupportAssets(g, r, accepted, ids),
      asset = result.asset;
    expect(result.role).toBe('foundation');
    validateBuildingPhysicsAsset(asset.physics);
    const mesh = asset.physics.colliders[0];
    expect(mesh.kind).toBe('mesh');
    if (mesh.kind !== 'mesh') throw Error('mesh');
    const top = accepted.position.y + r.jointY;
    expect(pointInsideClosedMesh({ x: 0, y: top - 0.01, z: -2 }, mesh.vertices, mesh.indices)).toBe(
      true,
    );
    expect(
      pointInsideClosedMesh({ x: -2, y: top - 0.01, z: -2 }, mesh.vertices, mesh.indices),
    ).toBe(false);
    expect(pointInsideClosedMesh({ x: 0, y: top - 0.01, z: 3 }, mesh.vertices, mesh.indices)).toBe(
      false,
    );
    expect(pointInsideClosedMesh({ x: -3, y: top - 0.01, z: 3 }, mesh.vertices, mesh.indices)).toBe(
      true,
    );
    // Every vertical face lies on an actual outer/hole contour, never an ear or grid diagonal.
    const rings = r.components.flatMap((c) => [c.outline, ...(c.holes ?? [])]);
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const p = mesh.indices.slice(i, i + 3).map((id) => mesh.vertices.slice(id * 3, id * 3 + 3));
      const area =
        (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]) - (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]);
      if (Math.abs(area) > 1e-10) continue;
      const x = (p[0][0] + p[1][0] + p[2][0]) / 3,
        z = (p[0][2] + p[1][2] + p[2][2]) / 3;
      expect(
        rings.some((ring) =>
          ring.some((a, j) => {
            const b = ring[(j + 1) % ring.length],
              length = Math.hypot(b[0] - a[0], b[1] - a[1]);
            return (
              Math.abs((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0])) / length < 1e-5 &&
              x >= Math.min(a[0], b[0]) - 1e-5 &&
              x <= Math.max(a[0], b[0]) + 1e-5 &&
              z >= Math.min(a[1], b[1]) - 1e-5 &&
              z <= Math.max(a[1], b[1]) + 1e-5
            );
          }),
        ),
      ).toBe(true);
    }
    for (const part of asset.parts)
      for (let i = 0; i < part.positions.length; i += 3)
        if (part.normals[i + 1] > 0.999) expect(part.positions[i + 1]).toBeCloseTo(top - 0.002, 10);
    expect(() => compileGeneratedAsset(ids.foundation, asset)).not.toThrow();
    expect(() => generateSupportAssets(g, r, owner(plan.minimumY - 0.01), ids)).toThrow(
      /below minimum/,
    );
  });

  it('keeps rotated hole/component shells deterministic and rejects tilted owners', () => {
    const g = grid(),
      r = rule(),
      placed = owner(0.5, 0.37);
    const first = generateSupportAssets(g, r, placed, ids);
    expect(canonicalJson(generateSupportAssets(g, r, placed, ids))).toBe(canonicalJson(first));
    for (const result of first)
      expect(() => compileGeneratedAsset(result.asset.physics.assetId, result.asset)).not.toThrow();
    expect(() =>
      planSupportPlacement(g, r, {
        ...placed,
        rotation: { x: Math.sin(0.1), y: 0, z: 0, w: Math.cos(0.1) },
      }),
    ).toThrow(/tilted/);
  });

  it('uses the explicit east entrance and rejects a terrain peak inside the ramp', () => {
    const g = grid(),
      r = rule();
    r.jointY = 0;
    r.approaches = [
      {
        id: 'east',
        edge: [
          [4, -3],
          [4, -1],
        ],
        outward: [1, 0],
        length: 3,
        targetY: 0.04,
        color: '#b5afa1',
      },
    ];
    const results = generateSupportAssets(g, r, owner(0.6), ids);
    expect(results.map((r) => r.role)).toEqual(['foundation', 'approach:east']);
    const approach = results[1].asset;
    expect(approach.physics.bounds.min.x).toBeCloseTo(4, 8);
    expect(approach.physics.bounds.max.x).toBeCloseTo(7, 8);
    expect(() => compileGeneratedAsset(ids.approaches.east, approach)).not.toThrow();
    g.heights[(-2 + 8) * 17 + 5 + 8] = 1;
    expect(() => generateSupportAssets(g, r, owner(0.6), ids)).toThrow(
      /approach east intersects terrain/,
    );
  });

  it('rejects overlapping raw components and holes outside the occupied region', () => {
    const g = grid(),
      r = rule();
    r.components.push({
      outline: [
        [-0.5, -3],
        [1, -3],
        [1, 0],
        [-0.5, 0],
      ],
    });
    expect(() => planSupportPlacement(g, r, owner())).toThrow(/overlap|normalized union/);
    const invalid = rule();
    invalid.components[0].holes = [
      [
        [6, 6],
        [7, 6],
        [7, 7],
        [6, 7],
      ],
    ];
    expect(() => planSupportPlacement(g, invalid, owner())).toThrow(/hole outside/);
  });

  it('rejects inward, unattached and only partially attached entrance edges', () => {
    const inward = approachRule();
    inward.approaches![0].edge = [
      [-0.5, -1],
      [0.5, -1],
    ];
    inward.approaches![0].length = 1.5;
    expect(() => generateSupportAssets(grid(), inward, owner(1), ids)).toThrow(
      /points inward|overlaps an occupied/,
    );
    const unattached = approachRule();
    unattached.approaches![0].edge = [
      [-0.5, 2],
      [0.5, 2],
    ];
    expect(() => planSupportPlacement(grid(), unattached, owner())).toThrow(/not fully attached/);
    const partial = approachRule();
    partial.approaches![0].edge = [
      [-0.5, 1],
      [1.5, 1],
    ];
    expect(() => generateSupportAssets(grid(), partial, owner(1), ids)).toThrow(
      /not fully attached/,
    );
    const gap = approachRule();
    gap.components = [
      {
        outline: [
          [-2, -1],
          [-0.1, -1],
          [-0.1, 1],
          [-2, 1],
        ],
      },
      {
        outline: [
          [0.1, -1],
          [2, -1],
          [2, 1],
          [0.1, 1],
        ],
      },
    ];
    gap.approaches![0].edge = [
      [-1.5, 1],
      [1.5, 1],
    ];
    expect(() => planSupportPlacement(grid(), gap, owner())).toThrow(/not fully attached/);
  });

  it('rejects occupied overlap inside the ramp or crossing it without either set of corners contained', () => {
    for (const obstacle of [
      [
        [-0.2, 2],
        [0.2, 2],
        [0.2, 3],
        [-0.2, 3],
      ],
      [
        [-2, 2],
        [2, 2],
        [2, 3],
        [-2, 3],
      ],
    ]) {
      const r = approachRule();
      r.components.push({ outline: obstacle as [number, number][] });
      expect(() => generateSupportAssets(grid(), r, owner(1), ids)).toThrow(
        /overlaps an occupied component/,
      );
    }
    const overlapping = approachRule();
    overlapping.approaches!.push({ ...overlapping.approaches![0], id: 'second' });
    expect(() => planSupportPlacement(grid(), overlapping, owner())).toThrow(
      /overlaps another approach/,
    );
  });

  it('accepts attachment over multiple contour segments and an outward entrance into a hole', () => {
    const splitEdge = approachRule();
    splitEdge.components[0].outline = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [0, 1],
      [-1, 1],
    ];
    expect(() => generateSupportAssets(grid(), splitEdge, owner(1), ids)).not.toThrow();
    const courtyard = approachRule();
    courtyard.components = [
      {
        outline: [
          [-4, -4],
          [4, -4],
          [4, 4],
          [-4, 4],
        ],
        holes: [
          [
            [-2, -2],
            [-2, 2],
            [2, 2],
            [2, -2],
          ],
        ],
      },
    ];
    courtyard.approaches![0].edge = [
      [-0.5, -2],
      [0.5, -2],
    ];
    courtyard.approaches![0].length = 3;
    for (const result of generateSupportAssets(grid(), courtyard, owner(0.6), ids))
      expect(() => compileGeneratedAsset(result.asset.physics.assetId, result.asset)).not.toThrow();
  });

  it('plans an admissible Y over the whole approach, including a conservative far-edge maximum', () => {
    const g = grid(),
      r = approachRule();
    g.heights[(3 + 8) * 17 + 8] = 2;
    const plan = planSupportPlacement(g, r, owner());
    expect(plan.terrainMax).toBe(0);
    expect(plan.minimumY).toBeCloseTo(2, 10);
    for (const result of generateSupportAssets(g, r, owner(plan.minimumY), ids))
      expect(() => compileGeneratedAsset(result.asset.physics.assetId, result.asset)).not.toThrow();
    g.heights[(5 + 8) * 17 + 8] = 4;
    const farPlan = planSupportPlacement(g, r, owner());
    expect(farPlan.minimumY).toBeCloseTo(4, 10);
    expect(() => generateSupportAssets(g, r, owner(farPlan.minimumY), ids)).not.toThrow();
  });

  it('includes the hidden render-cap gap when planning unusually thin foundations', () => {
    const g = grid(),
      r = approachRule();
    r.approaches = [];
    r.clearance = 0.0001;
    r.burial = 0.0001;
    const plan = planSupportPlacement(g, r, owner());
    expect(plan.minimumY).toBeGreaterThan(0.0019);
    expect(() => generateSupportAssets(g, r, owner(plan.minimumY), ids)).not.toThrow();
  });

  it('selects an explicit owner override and reads both private-data versions', () => {
    const model = rule(),
      override = { ...rule(), ownerId: 'owner-1', burial: 0.2 };
    expect(selectSupportRule([model, override], owner())).toBe(override);
    expect(selectSupportRule([model, override], { ...owner(), entityId: 'other' })).toBe(model);
    expect(() =>
      validateTerrainPrivateData({
        formatVersion: 2,
        generatorVersion: 'terrain-build/2',
        worldId: 'test',
        grid: grid(),
        supports: [model, override],
      }),
    ).not.toThrow();
    expect(() =>
      validateTerrainPrivateData({
        formatVersion: 1,
        generatorVersion: 'terrain-build/1',
        worldId: 'test',
        grid: grid(),
        supports: [
          {
            kind: 'rectangle-v1',
            ownerId: 'legacy',
            assetId: 'legacy',
            width: 2,
            depth: 2,
            clearance: 0.1,
            burial: 0.1,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateTerrainPrivateData({
        formatVersion: 2,
        generatorVersion: 'terrain-build/2',
        worldId: 'test',
        grid: grid(),
        supports: [model, model],
      }),
    ).toThrow(/Duplicate/);
  });

  it.each([0, 0.12])(
    'compiles the actual saved pilot XZ on the world-aligned grid at yaw %s',
    async (yaw) => {
      const companion = JSON.parse(
        await readFile(
          'content/buildings/ring-block/osm-way-1258973447/terrain-support.json',
          'utf8',
        ),
      );
      const g: TerrainGrid = {
        formatVersion: 1,
        origin: { x: -269, z: -745 },
        spacing: 4,
        columns: 151,
        rows: 220,
        heights: Array(151 * 220).fill(0),
        bottom: -1,
      };
      const placed: BuildingInstance = {
        entityId: 'osm-way-1258973447',
        assetId: 'osm-way-1258973447',
        position: { x: -148.88, y: 0.6, z: -157.92 },
        rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
      };
      expect(planSupportPlacement(g, companion.rule, placed).minimumY).toBeCloseTo(0.08, 10);
      const assets = generateSupportAssets(g, companion.rule, placed, {
        foundation: 'pilot-foundation',
        approaches: { 'main-entrance': 'pilot-approach' },
      });
      expect(assets).toHaveLength(2);
      for (const result of assets)
        expect(() =>
          compileGeneratedAsset(result.asset.physics.assetId, result.asset),
        ).not.toThrow();
    },
  );
});
