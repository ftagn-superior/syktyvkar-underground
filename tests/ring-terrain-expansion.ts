/** Actual release geometry + Havok, without opening or changing a database. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  canonicalJson,
  sampleTerrain,
  validateTerrainGrid,
} from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { readAuthoringRelease, editableStaticAssetIds } from '../apps/server/src/layout/release.js';
import { createPhysicsWorld } from '../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';

const directory = process.argv[2] ?? 'output/ring-terrain-expansion/candidate-world';
const baselineDirectory = process.argv[3] ?? 'output/ring-terrain-expansion/baseline-world';
const release = await readAuthoringRelease(directory);
const baseline = await readAuthoringRelease(baselineDirectory);
assert.equal(release.metadata.seedVersion, baseline.metadata.seedVersion);
assert.deepEqual(release.seed, baseline.seed, 'Existing objects and all poses must be identical');
assert.deepEqual(editableStaticAssetIds(release), editableStaticAssetIds(baseline));
for (const id of editableStaticAssetIds(baseline))
  assert.equal(release.manifest.assets[id].version, baseline.manifest.assets[id].version, id);
for (const field of ['spawnPoints', 'initialItems', 'landmarks'] as const)
  assert.deepEqual(release.definition[field], baseline.definition[field]);
assert.deepEqual(release.terrain!.supports, baseline.terrain!.supports);
assert.equal(release.manifest.cells.length, 392);
const world = release.definition;
assert.deepEqual(
  [world.bounds.min.x, world.bounds.max.x, world.bounds.min.z, world.bounds.max.z],
  [-1500, 2000, -850, 850],
);
assert.ok(world.entities.every((e) => /^boundary-(north|south|east|west)-\d+$/.test(e.entityId)));
const grid = release.terrain!.grid;
const oldBytes = await readFile('content/worlds/ring-block/terrain-candidate/full-grid-ready.json');
const old = validateTerrainGrid(JSON.parse(oldBytes.toString()));
const dx = (old.origin.x - grid.origin.x) / grid.spacing;
const dz = (old.origin.z - grid.origin.z) / grid.spacing;
assert.ok(Number.isInteger(dx) && Number.isInteger(dz));
for (let r = 0; r < old.rows; r++)
  for (let c = 0; c < old.columns; c++)
    assert.equal(grid.heights[(r + dz) * grid.columns + c + dx], old.heights[r * old.columns + c]);
for (let z = old.origin.z; z < old.origin.z + (old.rows - 1) * old.spacing; z += 7.3)
  for (let x = old.origin.x; x < old.origin.x + (old.columns - 1) * old.spacing; x += 7.1)
    assert.ok(
      Math.abs(sampleTerrain(grid, x, z)!.height - sampleTerrain(old, x, z)!.height) < 1e-10,
    );
const fixed = new Set(release.metadata.fixedInstanceIds);
const terrain = world.buildings.filter((b) => fixed.has(b.entityId));
assert.equal(terrain.length, 392);
let area = 0,
  triangles = 0,
  maxGeometryHeightError = 0;
for (const b of terrain) {
  assert.deepEqual(b.position, { x: 0, y: 0, z: 0 });
  const asset = world.buildingAssets[b.assetId];
  for (const axis of ['x', 'z'] as const) {
    assert.ok(asset.bounds.min[axis] >= world.bounds.min[axis]);
    assert.ok(asset.bounds.max[axis] <= world.bounds.max[axis]);
  }
  for (const collider of asset.colliders) {
    assert.equal(collider.kind, 'mesh');
    if (collider.kind !== 'mesh') continue;
    const v = collider.vertices;
    for (let i = 0; i < v.length; i += 3) {
      if (v[i + 1] === grid.bottom) continue;
      const error = Math.abs(v[i + 1] - sampleTerrain(grid, v[i], v[i + 2])!.height);
      maxGeometryHeightError = Math.max(maxGeometryHeightError, error);
      assert.ok(error < 0.00001, 'Saved collision vertices changed the terrain surface');
    }
    for (let i = 0; i < collider.indices.length; i += 3) {
      const [a, b, c] = collider.indices.slice(i, i + 3).map((id) => id * 3);
      const crossY = (v[b + 2] - v[a + 2]) * (v[c] - v[a]) - (v[b] - v[a]) * (v[c + 2] - v[a + 2]);
      if (crossY > 0) {
        area += crossY / 2;
        triangles++;
      }
    }
  }
}
assert.ok(Math.abs(area - 5_950_000) < 0.01, `Missing or overlapping ground: ${area}`);
console.log(JSON.stringify({ phase: 'geometry passed', cells: terrain.length, area, triangles }));
const physics = await createPhysicsWorld(
  {
    ...world,
    entities: [],
    initialItems: [],
    buildings: terrain,
    buildingAssets: Object.fromEntries(
      terrain.map((b) => [b.assetId, world.buildingAssets[b.assetId]]),
    ),
  },
  await loadServerWasm(),
  false,
);
let rays = 0,
  maxRayError = 0;
const rayIssues: unknown[] = [];
const routes = [];
const boundaryRoutes = [];
try {
  const points: [number, number][] = [];
  for (const b of terrain) {
    const box = world.buildingAssets[b.assetId].bounds;
    for (const x of [box.min.x, (box.min.x + box.max.x) / 2, box.max.x])
      for (const z of [box.min.z, (box.min.z + box.max.z) / 2, box.max.z]) points.push([x, z]);
  }
  // Deliberately probe both sides and exactly on all former city boundaries.
  for (const x of [-269, 331])
    for (let z = -745; z <= 131; z += 12) for (const d of [-0.01, 0, 0.01]) points.push([x + d, z]);
  for (const z of [-745, 131])
    for (let x = -269; x <= 331; x += 12) for (const d of [-0.01, 0, 0.01]) points.push([x, z + d]);
  for (const [px, pz] of points) {
    const x = Math.max(-1499.999, Math.min(1999.999, px)),
      z = Math.max(-849.999, Math.min(849.999, pz));
    const y = sampleTerrain(grid, x, z)!.height;
    const hit = physics.surfaceRay({ x, y: y + 3, z }, { x, y: y - 3, z });
    assert.ok(hit, `Missing physical ground at ${x}, ${z}`);
    const error = Math.abs(hit.point.y - y);
    maxRayError = Math.max(maxRayError, error);
    rays++;
    // Saved triangles retain exact grid heights. Havok's runtime mesh queries
    // differ by up to 10.1 mm on this release; test their centimetre-scale
    // approximation separately from the exact source/geometry checks above.
    if (error >= 0.02) rayIssues.push({ x, z, expected: y, error, hit });
  }
  console.log(
    JSON.stringify({
      phase: 'rays',
      rays,
      maxRayError,
      issues: rayIssues.slice(0, 15),
      count: rayIssues.length,
    }),
  );
  assert.equal(rayIssues.length, 0, 'Terrain ray accuracy');
  for (const [x, z, mx, mz] of [
    [-1200, 0, 1, 0],
    [1500, 0, 1, 0],
    [0, -800, 0, 1],
    [0, 600, 0, -1],
    [327, 0, 1, 0],
    [-273, 0, 1, 0],
    [0, 127, 0, 1],
    [0, -749, 0, 1],
  ]) {
    const start = {
      x,
      y: sampleTerrain(grid, x, z)!.height + world.simulation.character.height / 2 + 0.02,
      z,
    };
    const p = physics.createCharacter('expansion-probe', start);
    p.input = { moveX: mx, moveZ: mz, sprint: false };
    for (let i = 0; i < 150; i++) physics.advance(1 / 60);
    const state = physics.state('expansion-probe');
    const progress = (state.position.x - x) * mx + (state.position.z - z) * mz;
    assert.ok(progress > 6, `Blocked expansion walk: ${x},${z}: ${progress}`);
    assert.ok(state.grounded, `Unsupported at ${x},${z}`);
    routes.push({
      from: [x, z],
      position: { ...state.position },
      grounded: state.grounded,
      progress,
    });
    physics.removeCharacter('expansion-probe');
  }
  for (const wall of world.entities) physics.retainStatic(wall, hash(canonicalJson(wall)));
  for (const [x, z, mx, mz] of [
    [-1498, 40, -1, 0],
    [1998, 40, 1, 0],
    [40, -848, 0, -1],
    [40, 848, 0, 1],
  ]) {
    const start = physics.spawnPosition({ x, y: sampleTerrain(grid, x, z)!.height, z });
    const player = physics.createCharacter('boundary-probe', start);
    player.input = { moveX: mx, moveZ: mz, sprint: true };
    for (let i = 0; i < 150; i++) physics.advance(1 / 60);
    const state = physics.state('boundary-probe');
    const progress = (state.position.x - x) * mx + (state.position.z - z) * mz;
    assert.ok(progress >= 0 && progress < 1.5, 'Expanded perimeter does not stop the player');
    assert.ok(state.grounded, 'No support beside the expanded perimeter');
    boundaryRoutes.push({ from: [x, z], position: { ...state.position }, progress });
    physics.removeCharacter('boundary-probe');
  }
} finally {
  physics.dispose();
}
const result = {
  status: 'passed',
  mapVersion: release.manifest.mapVersion,
  baselineMapVersion: baseline.manifest.mapVersion,
  sourceGridSha256: hash(oldBytes),
  preservedNodes: old.heights.length,
  seedVersion: release.metadata.seedVersion,
  editableInstances: release.seed.length,
  unchangedEditableModels: editableStaticAssetIds(release).length,
  bounds: world.bounds,
  cells: terrain.length,
  areaSquareMetres: area,
  triangles,
  maxGeometryHeightError,
  rays,
  maxRayError,
  physicalRayToleranceMetres: 0.02,
  routes,
  boundaryRoutes,
  noNewObjects: true,
  databaseAccess: false,
};
await writeFile(
  'output/ring-terrain-expansion/acceptance.json',
  JSON.stringify(result, null, 2) + '\n',
);
console.log(canonicalJson(result));
