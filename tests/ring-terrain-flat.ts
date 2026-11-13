/** Saved city resources and Havok acceptance, independent of a database or rendering. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  WORLD_RESOURCE_LIMITS,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import { readAuthoringRelease } from '../apps/server/src/layout/release.js';
import { prepareRingProfilePublication } from './helpers/ring-terrain-profile.js';
import { generateGround, type GroundRecipe } from '../tools/world-build/src/city.js';
import { GROUND_TERRAIN_OFFSET_SCALE } from '../tools/world-build/src/ground-terrain.js';
import { linear } from '../tools/world-build/src/merge.js';
import { createPhysicsWorld } from '../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { flatCoverageProbe, type FlatTriangle } from './terrain/flat-coverage.js';

const directory = resolve(process.argv[2] ?? 'output/ring-terrain-stage2/flat-4m');
const source = resolve(process.argv[3] ?? 'output/ring-terrain-stage0/source-world');
const snapshot: WorldLayoutSnapshot = JSON.parse(await readFile('data/map-layout.json', 'utf8'));
const release = await readAuthoringRelease(directory);
const { world, profileFixture } = await prepareRingProfilePublication(source, snapshot, directory);
const recipe: GroundRecipe = JSON.parse(
  await readFile('content/buildings/ring-block/ring-block-ground/source.json', 'utf8'),
);
const original = generateGround('reference-ground', { ...recipe, merge: false });
const projectedArea = (a: number[], b: number[], c: number[]) =>
  Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
const layers = recipe.layers.map((layer) => {
  const part = original.parts.find((p) => p.partId === layer.id)!;
  let area = 0;
  const triangles: FlatTriangle[] = [];
  for (let i = 0; i < part.indices.length; i += 3) {
    const [a, b, c] = part.indices
      .slice(i, i + 3)
      .map((v) => part.positions.slice(v * 3, v * 3 + 3));
    const size = projectedArea(a, b, c);
    area += size;
    if (size > 1e-10) triangles.push([a[0], a[2], b[0], b[2], c[0], c[2]]);
  }
  return {
    id: layer.id,
    color: linear(layer.color),
    y: Math.fround(layer.elevation * GROUND_TERRAIN_OFFSET_SCALE),
    expectedArea: area,
    actualArea: 0,
    triangles: 0,
    coverage: flatCoverageProbe(
      triangles,
      layer.polygons.flatMap((p) => p.slice(1)),
      recipe.min,
      recipe.max,
    ),
  };
});
let groundArea = 0,
  graphicTriangles = 0,
  collisionTriangles = 0,
  maxColorError = 0,
  maxNormalError = 0;
const fixed = new Set(release.metadata.fixedInstanceIds);
const groundInstances = world.buildings.filter((b) => fixed.has(b.entityId));
assert.ok(groundInstances.length >= 40);
assert.ok(
  world.buildings.filter((b) => !fixed.has(b.entityId)).length ===
    snapshot.instances.filter((i) => i.enabled).length,
);
for (const instance of groundInstances) {
  assert.deepEqual(instance.position, { x: 0, y: 0, z: 0 });
  const descriptor = release.manifest.assets[instance.assetId];
  const bytes = await readFile(join(directory, descriptor.modelFile!));
  assert.ok(bytes.byteLength <= WORLD_RESOURCE_LIMITS.modelBytes);
  const length = bytes.readUInt32LE(12),
    doc = JSON.parse(bytes.subarray(20, 20 + length).toString());
  const binary = bytes.subarray(28 + length);
  const accessor = (id: number) => {
    const a = doc.accessors[id],
      v = doc.bufferViews[a.bufferView],
      offset = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return Array.from({ length: a.count * (a.type === 'VEC3' ? 3 : 1) }, (_, i) =>
      a.componentType === 5126
        ? binary.readFloatLE(offset + 4 * i)
        : binary.readUInt32LE(offset + 4 * i),
    );
  };
  assert.equal(doc.meshes.length, 1, 'Keep one merged ground draw per resource');
  for (const mesh of doc.meshes)
    for (const primitive of mesh.primitives) {
      const positions = accessor(primitive.attributes.POSITION),
        normals = accessor(primitive.attributes.NORMAL),
        colors = accessor(primitive.attributes.COLOR_0),
        indices = accessor(primitive.indices);
      assert.ok(positions.every(Number.isFinite) && normals.every(Number.isFinite));
      graphicTriangles += indices.length / 3;
      for (let i = 0; i < indices.length; i += 3) {
        const ids = indices.slice(i, i + 3),
          points = ids.map((v) => positions.slice(v * 3, v * 3 + 3));
        const y = points[0][1],
          horizontal = points.every((p) => p[1] === y);
        const layer = layers.find((l) => l.y === y);
        if (horizontal && y === 0) groundArea += projectedArea(points[0], points[1], points[2]);
        if (horizontal && y > 0) {
          assert.ok(layer, `Unexpected layer height ${y}`);
          layer.actualArea += projectedArea(points[0], points[1], points[2]);
          layer.triangles++;
          if (projectedArea(points[0], points[1], points[2]) > 1e-10)
            layer.coverage.visit(points.flatMap((p) => [p[0], p[2]]) as FlatTriangle);
        }
        const expectedColor = layer?.color ?? linear(recipe.color);
        for (const v of ids)
          for (let c = 0; c < 3; c++)
            maxColorError = Math.max(maxColorError, Math.abs(colors[v * 3 + c] - expectedColor[c]));
        if (horizontal && y >= 0)
          for (const v of ids)
            for (let c = 0; c < 3; c++)
              maxNormalError = Math.max(
                maxNormalError,
                Math.abs(normals[v * 3 + c] - (c === 1 ? 1 : 0)),
              );
        if (!horizontal)
          assert.ok(
            points.every((p) => p[0] === world.bounds.min.x) ||
              points.every((p) => p[0] === world.bounds.max.x) ||
              points.every((p) => p[2] === world.bounds.min.z) ||
              points.every((p) => p[2] === world.bounds.max.z),
            'Internal tile walls must not appear in graphics',
          );
      }
    }
  const collisionBytes = await readFile(join(directory, descriptor.collisionFile));
  assert.ok(collisionBytes.byteLength <= WORLD_RESOURCE_LIMITS.collisionBytes);
  const physics = world.buildingAssets[instance.assetId];
  assert.equal(physics.colliders.length, 1);
  for (const c of physics.colliders) {
    assert.equal(c.kind, 'mesh', 'Old physical slab must be absent');
    if (c.kind === 'mesh') collisionTriangles += c.indices.length / 3;
  }
}
assert.ok(Math.abs(groundArea - 600 * 876) < 0.01, `Ground coverage ${groundArea}`);
assert.ok(maxColorError < 1e-6 && maxNormalError < 1e-6);
for (const l of layers) {
  assert.ok(
    Math.abs(l.actualArea - l.expectedArea) < Math.max(0.02, l.expectedArea * 2e-5),
    `Coverage changed: ${l.id} ${l.actualArea - l.expectedArea}`,
  );
  l.coverage.evidence();
}
for (const cell of release.manifest.cells)
  assert.ok(
    (await readFile(join(directory, cell.file))).byteLength <= WORLD_RESOURCE_LIMITS.cellBytes,
  );

const wasm = await loadServerWasm();
const groundWorld = await createPhysicsWorld(
  {
    ...world,
    entities: [],
    initialItems: [],
    buildings: groundInstances,
    buildingAssets: Object.fromEntries(
      groundInstances.map((b) => [b.assetId, world.buildingAssets[b.assetId]]),
    ),
  },
  wasm,
  false,
);
let rays = 0,
  maxRayError = 0;
const routes = [];
try {
  // Every terrain model edge and corner, including splits and the last one-metre row.
  for (const instance of groundInstances) {
    const b = world.buildingAssets[instance.assetId].bounds;
    for (const edgeX of [b.min.x, (b.min.x + b.max.x) / 2, b.max.x])
      for (const edgeZ of [b.min.z, (b.min.z + b.max.z) / 2, b.max.z]) {
        // Open control points at the outer perimeter: an exact mesh silhouette ray
        // has ambiguous edge ownership in Havok. Internal seams remain exact.
        const x = Math.max(world.bounds.min.x + 0.001, Math.min(world.bounds.max.x - 0.001, edgeX));
        const z = Math.max(world.bounds.min.z + 0.001, Math.min(world.bounds.max.z - 0.001, edgeZ));
        const hit = groundWorld.surfaceRay({ x, y: 2, z }, { x, y: -4, z });
        assert.ok(hit, `Missing ground ${x},${z}`);
        rays++;
        maxRayError = Math.max(maxRayError, Math.abs(hit.point.y));
      }
  }
  assert.ok(maxRayError <= 0.01);
  for (const sprint of [false, true])
    for (const diagonal of [false, true])
      for (const direction of [-1, 1]) {
        const seam = { x: -144, z: -120 };
        const start = {
          x: seam.x - direction * 2,
          y: 0.92,
          z: diagonal ? seam.z - direction * 2 : seam.z + 20,
        };
        const p = groundWorld.createCharacter('probe', start);
        p.input = {
          moveX: direction * (diagonal ? Math.SQRT1_2 : 1),
          moveZ: diagonal ? direction * Math.SQRT1_2 : 0,
          sprint,
        };
        let maxVerticalDrift = 0;
        for (let i = 0; i < (sprint ? 45 : 150); i++) {
          groundWorld.advance(1 / 60);
          maxVerticalDrift = Math.max(
            maxVerticalDrift,
            Math.abs(groundWorld.state('probe').position.y - start.y),
          );
        }
        const state = groundWorld.state('probe');
        assert.ok(direction * (state.position.x - seam.x) > 1);
        if (diagonal) assert.ok(direction * (state.position.z - seam.z) > 1);
        assert.ok(
          state.grounded && maxVerticalDrift < 0.001,
          JSON.stringify({ sprint, diagonal, direction, state, maxVerticalDrift }),
        );
        routes.push({
          sprint,
          diagonal,
          direction,
          maxVerticalDrift,
          position: { ...state.position },
        });
        groundWorld.removeCharacter('probe');
      }
} finally {
  groundWorld.dispose();
}
const city = await createPhysicsWorld({ ...world, initialItems: [] }, wasm, false);
let supportedSpawns = 0;
try {
  for (const spawn of world.spawnPoints) {
    assert.ok(city.findSpawn(undefined, spawn));
    supportedSpawns++;
  }
} finally {
  city.dispose();
}
const result = {
  status: 'passed',
  spacing: release.terrain!.grid.spacing,
  profileFixture,
  geometry: {
    groundArea,
    graphicTriangles,
    collisionTriangles,
    maxColorError,
    maxNormalError,
    layers: layers.map(({ coverage, ...layer }) => ({
      ...layer,
      spatialCoverage: coverage.evidence(),
    })),
  },
  physics: { rays, maxRayError, outerBoundaryInsetMetres: 0.001, routes, supportedSpawns },
  limits: WORLD_RESOURCE_LIMITS,
  fullGameplayAcceptance: false,
};
await writeFile(join(directory, 'acceptance-report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    status: result.status,
    spacing: result.spacing,
    graphicTriangles,
    collisionTriangles,
    rays,
    supportedSpawns,
  }),
);
