import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sampleTerrain,
  validateTerrainGrid,
  validateBuildingPhysicsAsset,
  loadWorldBundle,
  terrainVertexNormals,
  type TerrainGrid,
  type WorldDefinition,
  type WorldSource,
  createWorldGrid,
} from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import { buildTerrainAuthoring } from '../../tools/world-build/src/terrain-authoring.js';
import {
  terrainPatch,
  terrainSolid,
  patchRange,
  rectangle,
  terrainContours,
  generateTerrainTile,
} from '../../tools/world-build/src/terrain.js';
import { createPhysicsWorld } from '../../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../../packages/simulation/src/server.js';
import { terrainPhysicsScenarios } from '../terrain/physics-scenarios.js';
import { terrainGeometryEvidence } from '../terrain/geometry-evidence.js';
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const g = validateTerrainGrid(await json('content/worlds/terrain-lab/terrain.json'));
let temporary: string, world: WorldDefinition;
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'su-terrain-'));
  const manifest = await buildWorld('content/worlds/terrain-lab/world.json', temporary);
  world = await loadWorldBundle(manifest, (file) => readFile(join(temporary, file)));
}, 30_000);
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe('terrain-lab geometry and publication', () => {
  it('measures the saved GLB coverage interiors and the saved foundation collision surface', async () => {
    const evidence = await terrainGeometryEvidence(
      g,
      world,
      await json(join(temporary, 'manifest.json')),
      (await json('content/worlds/terrain-lab/surfaces.json')).layers,
      (file) => readFile(join(temporary, file)),
    );
    expect(evidence.groundTopTriangles).toBe(3200);
    expect(evidence.maxCoverError).toBeLessThan(0.001);
    expect(evidence.foundation.maxError).toBeLessThan(0.001);
    expect(evidence.contour3ChordDeviationMetres).toBeGreaterThan(4);
  });
  it('keeps entire corner pads at their declared elevations', () => {
    for (const [x0, z0, h] of [
      [-20, -20, 0],
      [-20, 16, 0],
      [16, 16, 0],
      [16, -20, 6],
    ])
      for (let x = x0; x <= x0 + 4; x += 0.5)
        for (let z = z0; z <= z0 + 4; z += 0.5)
          expect(sampleTerrain(g, x, z)!.height).toBeCloseTo(h, 6);
  });
  it('has curved contours and changing slope directions', () => {
    for (const h of [1.5, 3, 4.5]) expect(terrainContours(g, h).length).toBeGreaterThan(40);
    const contour = terrainContours(g, 3).flat();
    const deviation = Math.max(
      ...contour
        .filter(([x, z]) => x >= -4 && x <= 16 && z >= -16 && z <= 4)
        .map(([x, z]) => Math.abs(z - x + 12) / Math.SQRT2),
    );
    expect(deviation).toBeGreaterThan(4);
    const a = sampleTerrain(g, -4, -16)!.normal,
      b = sampleTerrain(g, 16, 4)!.normal;
    const angle = Math.acos((a.x * b.x + a.z * b.z) / Math.hypot(a.x, a.z) / Math.hypot(b.x, b.z));
    expect((angle * 180) / Math.PI).toBeGreaterThan(60);
  });
  it('publishes four closed ground solids, matching smooth seam normals and immutable derivatives', async () => {
    const tiles = world.buildings.filter((b) => b.assetId.startsWith('terrain-tile-'));
    expect(tiles).toHaveLength(4);
    expect(world.entities).toHaveLength(0);
    for (const asset of Object.values(world.buildingAssets))
      expect(validateBuildingPhysicsAsset(asset)).toBeTruthy();
    const metadata = await json(join(temporary, 'authoring.json'));
    for (const id of [
      'slope-house',
      'slope-house-foundation',
      'slope-house-approach',
      ...tiles.map((b) => b.entityId),
    ])
      expect(metadata.fixedInstanceIds).toContain(id);
    const normals = terrainVertexNormals(g);
    expect(normals).toHaveLength(1681);
    for (const n of normals) expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1);
    const a = generateTerrainTile('test-a', g, rectangle(-10, -10, 20, 20), []).parts[0];
    const b = generateTerrainTile('test-b', g, rectangle(10, -10, 20, 20), []).parts[0];
    const seam = (p: typeof a) => {
      const out = new Map<string, number[]>();
      for (let i = 0; i < p.positions.length; i += 3)
        if (p.positions[i] === 0 && p.normals[i + 1] > 0.5)
          out.set(`${p.positions[i + 1]},${p.positions[i + 2]}`, p.normals.slice(i, i + 3));
      return out;
    };
    for (const [id, n] of seam(a)) expect(seam(b).get(id)).toEqual(n);
  });
  it('builds deterministically and recomputes houses for flat and changed source heights', async () => {
    const again = await buildWorld(
      'content/worlds/terrain-lab/world.json',
      join(temporary, 'repeat'),
    );
    const first = await json(join(temporary, 'manifest.json'));
    expect(again).toEqual(first);
    const flat = await buildWorld(
      'content/worlds/terrain-lab/world.json',
      join(temporary, 'flat'),
      { terrainVariant: 'flat' },
    );
    expect(flat.mapVersion).not.toBe(first.mapVersion);
    const flatWorld = await loadWorldBundle(flat, (file) =>
      readFile(join(temporary, 'flat', file)),
    );
    expect(flatWorld.buildings.find((b) => b.entityId === 'slope-house')!.position.y).toBeCloseTo(
      0.3,
    );
    const source = (await json('content/worlds/terrain-lab/world.json')) as WorldSource;
    const args = [source, createWorldGrid(source.bounds, 20), world.itemCatalog] as const;
    const surfaces = await json('content/worlds/terrain-lab/surfaces.json');
    const anchors = await json('content/worlds/terrain-lab/anchors.json');
    const changed = buildTerrainAuthoring(
      ...args,
      { ...g, heights: g.heights.map((h) => h + 0.5) },
      surfaces,
      anchors,
      'hill',
    );
    expect(changed.buildings.find((b) => b.entityId === 'slope-house')!.position.y).toBeCloseTo(
      world.buildings.find((b) => b.entityId === 'slope-house')!.position.y + 0.5,
    );
    expect(() =>
      buildTerrainAuthoring(
        { ...source, spawnPoints: [{ x: 0, y: 0, z: 0 }] },
        args[1],
        args[2],
        g,
        surfaces,
        anchors,
        'hill',
      ),
    ).toThrow('compete');
  });
  it('captures interior maxima, rotated footprints, and grid triangle cuts', () => {
    const hill: TerrainGrid = {
      formatVersion: 1,
      origin: { x: 0, z: 0 },
      spacing: 1,
      columns: 3,
      rows: 3,
      bottom: -2,
      heights: [0, 0, 0, 0, 2, 0, 0, 0, 0],
    };
    const patch = terrainPatch(hill, rectangle(1, 1, 1.8, 1.8, Math.PI / 12));
    expect(patchRange(patch).max).toBeCloseTo(2);
    const built = terrainSolid(
      'interior-max',
      patch,
      () => 2.3,
      (p) => p.y - 0.02,
      '#888888',
    );
    expect(validateBuildingPhysicsAsset(built.physics)).toBeTruthy();
  });
  it('follows the full area below the horizontal foundation with two cm burial', () => {
    const range = patchRange(terrainPatch(g, rectangle(1, -7, 6, 4)));
    expect(range.max - range.min).toBeGreaterThan(1);
    const house = world.buildings.find((b) => b.entityId === 'slope-house')!;
    expect(house.position.y).toBeCloseTo(range.max + 0.3, 6);
    expect(house.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const collider = world.buildingAssets['slope-house-foundation'].colliders[0];
    if (collider.kind !== 'mesh') throw new Error('Expected foundation mesh');
    for (let i = 0; i < collider.indices.length; i += 3) {
      const pts = collider.indices.slice(i, i + 3).map((j) => ({
        x: collider.vertices[j * 3],
        y: collider.vertices[j * 3 + 1],
        z: collider.vertices[j * 3 + 2],
      }));
      if (pts.every((p) => Math.abs(p.y - house.position.y) < 1e-6)) continue;
      if (pts.some((p) => Math.abs(p.y - house.position.y) < 1e-6)) continue;
      const center = pts.reduce(
        (s, p) => ({ x: s.x + p.x / 3, y: s.y + p.y / 3, z: s.z + p.z / 3 }),
        { x: 0, y: 0, z: 0 },
      );
      for (const p of [...pts, center])
        expect(p.y).toBeCloseTo(sampleTerrain(g, p.x, p.z)!.height - 0.02, 6);
    }
  });
  it('clips coverage holes and drapes the interior of overlays across cell boundaries', () => {
    const layer = {
      id: 'hole-test',
      outline: rectangle(0, 0, 6, 6),
      holes: [rectangle(0, 0, 2, 2)],
      color: '#ffffff',
      offset: 0.025,
    };
    let area = 0;
    for (const x of [-10, 10])
      for (const z of [-10, 10]) {
        const part = generateTerrainTile('overlay-test', g, rectangle(x, z, 20, 20), [
          layer,
        ]).parts.find((p) => p.partId === 'hole-test')!;
        for (let i = 0; i < part.indices.length; i += 3) {
          const p = part.indices.slice(i, i + 3).map((j) => part.positions.slice(j * 3, j * 3 + 3));
          const [a, b, c] = p;
          area += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
          const center = [
            (a[0] + b[0] + c[0]) / 3,
            (a[1] + b[1] + c[1]) / 3,
            (a[2] + b[2] + c[2]) / 3,
          ];
          expect(Math.abs(center[0]) < 1 && Math.abs(center[2]) < 1).toBe(false);
          for (const v of [...p, center])
            expect(v[1] - 0.025).toBeCloseTo(sampleTerrain(g, v[0], v[2])!.height, 6);
        }
      }
    expect(area).toBeCloseTo(32, 6);
  });
});

describe('terrain-lab Havok contacts', () => {
  it('keeps sprinting capsules inside all four finite terrain boundaries', async () => {
    const physics = await createPhysicsWorld(
      { ...world, initialItems: [] },
      await loadServerWasm(),
      false,
    );
    try {
      for (const [x, z, dx, dz] of [
        [19, 2, 1, 0],
        [-19, 2, -1, 0],
        [5, -19, 0, -1],
        [5, 19, 0, 1],
      ]) {
        const point = { x, y: sampleTerrain(g, x, z)!.height, z };
        physics.createCharacter('edge', physics.findSpawn(undefined, point)!);
        physics.characters.get('edge')!.input = { moveX: dx, moveZ: dz, sprint: true };
        for (let i = 0; i < 120; i++) physics.advance(1 / 60);
        const p = physics.state('edge').position;
        expect(p.x).toBeGreaterThan(-20);
        expect(p.x).toBeLessThan(20);
        expect(p.z).toBeGreaterThan(-20);
        expect(p.z).toBeLessThan(20);
        expect(p.y).toBeGreaterThan(sampleTerrain(g, p.x, p.z)!.height + 0.8);
        physics.removeCharacter('edge');
      }
    } finally {
      physics.dispose();
    }
  });
  it('accepts support at the exact shared edge of legacy flat box tiles', async () => {
    const assets = Object.fromEntries(
      [
        ['left', -81.5],
        ['right', 43.5],
      ].map(([name, cx]) => [
        name,
        {
          assetId: name as string,
          bounds: {
            min: { x: Number(cx) - 62.5, y: -2, z: -745 },
            max: { x: Number(cx) + 62.5, y: 0, z: -620 },
          },
          colliders: [
            {
              id: 'slab',
              kind: 'box' as const,
              position: { x: Number(cx), y: -1, z: -682.5 },
              rotation: { x: 0, y: 0, z: 0, w: 1 },
              size: { x: 125, y: 2, z: 125 },
              friction: 0.6,
              restitution: 0.05,
            },
          ],
        },
      ]),
    );
    const physics = await createPhysicsWorld(
      {
        ...world,
        initialItems: [],
        entities: [],
        buildingAssets: assets,
        buildings: Object.keys(assets).map((id) => ({
          entityId: id,
          assetId: id,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        })),
      },
      await loadServerWasm(),
      false,
    );
    try {
      expect(physics.findSpawn(undefined, { x: -19, y: 0, z: -721 })).toBeDefined();
    } finally {
      physics.dispose();
    }
  });
  it('walks and sprints the full route, stops on the slope, and rolls a ball across both seams', async () => {
    const result = await terrainPhysicsScenarios(world, g, await loadServerWasm());
    expect(result.maxFootGap).toBeLessThan(0.18);
    expect(result.maxRestDrift).toBeLessThan(0.01);
    expect(result.ballCrossedX && result.ballCrossedZ).toBe(true);
    expect(result.routes).toHaveLength(2);
  });
  it('blocks walking up a slope steeper than 70 degrees and rejects an unsupported spawn', async () => {
    const steep: TerrainGrid = {
      formatVersion: 1,
      origin: { x: -1, z: -0.5 },
      spacing: 1,
      columns: 3,
      rows: 2,
      heights: [0, 0, 4, 0, 0, 4],
      bottom: -2,
    };
    const built = terrainSolid(
      'steep-test',
      terrainPatch(steep, rectangle(0, 0, 2, 1)),
      (p) => p.y,
      () => -2,
      '#888888',
    );
    const physics = await createPhysicsWorld(
      {
        ...world,
        initialItems: [],
        entities: [],
        buildings: [
          {
            entityId: 'steep-test',
            assetId: 'steep-test',
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          },
        ],
        buildingAssets: { 'steep-test': built.physics },
      },
      await loadServerWasm(),
      false,
    );
    try {
      expect(physics.findSpawn(undefined, { x: 10, y: 0, z: 10 })).toBeUndefined();
      physics.createCharacter('climber', { x: -0.6, y: 0.92, z: 0 });
      physics.characters.get('climber')!.input = { moveX: 1, moveZ: 0 };
      let maxY = 0;
      for (let i = 0; i < 240; i++) {
        physics.advance(1 / 60);
        maxY = Math.max(maxY, physics.state('climber').position.y);
      }
      expect(maxY).toBeLessThan(1.15);
      expect(physics.state('climber').position.x).toBeLessThan(0.1);
    } finally {
      physics.dispose();
    }
  });
  it('matches open physical rays to the surface, validates all spawns, and releases static references', async () => {
    const physics = await createPhysicsWorld(
      { ...world, initialItems: [] },
      await loadServerWasm(),
      false,
    );
    try {
      for (const [x, z] of [
        [-0.27, 1.64],
        [0, 0],
        [8, -4],
        [0, 6],
        [15, -18],
        [-3.5, -8],
        [19, 19],
      ]) {
        const ray = physics.surfaceRay({ x, y: 15, z }, { x, y: -5, z })!;
        expect(ray.point.y).toBeCloseTo(sampleTerrain(g, x, z)!.height, 2);
      }
      for (const spawn of world.spawnPoints)
        expect(physics.findSpawn(undefined, spawn)).toBeDefined();
    } finally {
      physics.dispose();
    }
    const {
      entities: _entities,
      buildings: _buildings,
      buildingAssets: _assets,
      ...header
    } = world;
    const streamed = await createPhysicsWorld(header, await loadServerWasm(), true);
    try {
      const baseline = streamed.staticDiagnostics();
      for (let cycle = 0; cycle < 20; cycle++) {
        for (const b of world.buildings) {
          streamed.retainStatic(b, 'test', world.buildingAssets[b.assetId]);
          streamed.retainStatic(b, 'test', world.buildingAssets[b.assetId]);
        }
        for (const b of world.buildings) streamed.releaseStatic(b.entityId);
        expect(streamed.staticDiagnostics().entities).toBe(world.buildings.length);
        for (const b of world.buildings) streamed.releaseStatic(b.entityId);
        expect(streamed.staticDiagnostics()).toEqual(baseline);
      }
    } finally {
      streamed.dispose();
    }
  });
});
