/** Offline acceptance of two immutable authoring releases. Never opens a database. */
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  canonicalJson,
  sampleTerrain,
  terrainCellTriangles,
  terrainNormal,
  transformWorldPoint,
  type BuildingInstance,
  validateGraphicsCoverage,
  type TerrainGrid,
} from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { readWorldDirectory } from '../apps/server/src/world-bundle.js';
import {
  readAuthoringRelease,
  terrainSupportId,
  type AuthoringRelease,
} from '../apps/server/src/layout/release.js';
import { selectSupportRule } from '../packages/terrain-build/src/supports.js';
import { createPhysicsWorld } from '../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import {
  RING_TERRAIN_EXPRESSIVENESS_ROUTES,
  measureTerrainProfile,
} from '../tools/world-build/src/ring-terrain-expressiveness.js';
import {
  cityTerrainAcceptance,
  type CityAcceptanceControls,
  type CityPoint,
} from './terrain/city-acceptance.js';

const paths = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  assert.ok(
    [
      '--source-world',
      '--target-world',
      '--published-world',
      '--source-published-world',
      '--report',
    ].includes(key) &&
      !paths.has(key) &&
      value &&
      !value.startsWith('--'),
    `Invalid argument: ${key}`,
  );
  paths.set(key, resolve(value));
}
for (const key of ['--source-world', '--target-world', '--report'])
  assert.ok(paths.has(key), `Required argument: ${key}`);
paths.set(
  '--published-world',
  paths.get('--published-world') ??
    join(dirname(paths.get('--target-world')!), 'candidate-published'),
);
paths.set(
  '--source-published-world',
  paths.get('--source-published-world') ??
    join(dirname(paths.get('--source-world')!), 'source-published'),
);
const publishedDirectory = paths.get('--published-world')!;
const sourcePublishedDirectory = paths.get('--source-published-world')!;
const reportFile = paths.get('--report')!;
for (const key of [
  '--source-world',
  '--target-world',
  '--published-world',
  '--source-published-world',
]) {
  const rel = relative(paths.get(key)!, reportFile);
  assert.ok(
    rel === '..' || rel.startsWith('..' + sep),
    'Report must be outside immutable releases',
  );
}
const [source, target, published, sourcePublished] = await Promise.all([
  readAuthoringRelease(paths.get('--source-world')!),
  readAuthoringRelease(paths.get('--target-world')!),
  readWorldDirectory(publishedDirectory),
  readWorldDirectory(sourcePublishedDirectory),
]);
const world = published.definition,
  manifest = published.manifest;
assert.ok(source.terrain && target.terrain, 'Both releases require verified private terrain');
const before = source.terrain.grid,
  after = target.terrain.grid;
const issues: { scenario: string; message: string }[] = [];
const check = (scenario: string, action: () => void) => {
  try {
    action();
  } catch (error) {
    issues.push({ scenario, message: error instanceof Error ? error.message : String(error) });
  }
};
check('grid-and-world-contract', () => {
  assert.deepEqual({ ...before, heights: [], bottom: 0 }, { ...after, heights: [], bottom: 0 });
  assert.equal(after.spacing, 20, 'Keep the coarse surface');
  assert.deepEqual(source.manifest.grid, manifest.grid);
  for (const axis of ['x', 'z'] as const) {
    assert.equal(source.definition.bounds.min[axis], world.bounds.min[axis]);
    assert.equal(source.definition.bounds.max[axis], world.bounds.max[axis]);
  }
  assert.deepEqual(source.definition.simulation, world.simulation);
  assert.notEqual(source.metadata.assetReleaseVersion, target.metadata.assetReleaseVersion);
});
const editable = (release: AuthoringRelease) => {
  const fixed = new Set(release.metadata.fixedInstanceIds);
  return release.definition.buildings.filter(
    (owner) => !fixed.has(owner.entityId) && !release.manifest.generatedSupports?.[owner.entityId],
  );
};
const beforeOwners = editable(source),
  afterOwners = editable(target);
const afterOwnerById = new Map(afterOwners.map((owner) => [owner.entityId, owner]));
check('editable-model-and-plan-preservation', () => {
  const projected = (owners: typeof beforeOwners) =>
    owners
      .map(({ position, ...owner }) => ({ ...owner, position: { x: position.x, z: position.z } }))
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
  assert.deepEqual(projected(beforeOwners), projected(afterOwners));
  for (const assetId of new Set(beforeOwners.map((owner) => owner.assetId))) {
    assert.deepEqual(
      source.definition.buildingAssets[assetId],
      world.buildingAssets[assetId],
      `Editable physics changed: ${assetId}`,
    );
    assert.equal(
      source.manifest.assets[assetId].version,
      manifest.assets[assetId].version,
      `Editable visual changed: ${assetId}`,
    );
  }
});
check('published-seed-poses', () => {
  for (const [release, runtime] of [
    [source, sourcePublished],
    [target, published],
  ] as const) {
    const fixed = new Set(release.metadata.fixedInstanceIds);
    const rows = runtime.definition.buildings.filter(
      (owner) =>
        !fixed.has(owner.entityId) && !runtime.manifest.generatedSupports?.[owner.entityId],
    );
    const sorted = (owners: BuildingInstance[]) =>
      [...owners].sort((a, b) => a.entityId.localeCompare(b.entityId));
    assert.deepEqual(
      sorted(rows),
      sorted(editable(release)),
      'Runtime publication must contain exact adapted authoring seed poses',
    );
  }
});
check('near-far-coverage', () => {
  assert.ok(manifest.graphics);
  validateGraphicsCoverage(world, manifest.grid, manifest.graphics.groups);
  assert.equal(manifest.graphics.groups.length, source.manifest.graphics?.groups.length);
});

const controls: CityAcceptanceControls = JSON.parse(
  await readFile('tests/fixtures/ring-terrain-city-controls.json', 'utf8'),
);
const routes: { id: string; points: CityPoint[] }[] = [
  {
    id: 'expressiveness-oplesnina-hill',
    points: [
      [-610.38, -525.11],
      [-436.06, -555.93],
      [-232.28, -591.67],
      [-103.3, -614.64],
      [65.91, -644.08],
      [202.64, -668.02],
      [304.79, -685.91],
    ],
  },
  {
    id: 'expressiveness-dimitrova-ascent',
    points: [
      [125.01, 406],
      [47.68, 450.47],
      [-24.12, 491.75],
      [-148.9, 563.47],
      [-264.7, 630.1],
      [-390.08, 702],
      [-492.24, 760.69],
      [-608.31, 827.86],
    ],
  },
  {
    id: 'expressiveness-river-west',
    points: [
      [503.83, -252.67],
      [671.78, -335.16],
      [687.82, -341.39],
      [756.42, -376.32],
      [853.81, -423.9],
    ],
  },
  {
    id: 'expressiveness-river-east',
    points: [
      [1146.45, -578.67],
      [1195.99, -604.49],
      [1244.47, -629.76],
      [1315.48, -664.72],
      [1397.86, -705.28],
    ],
  },
];
controls.routes.push(...routes);
controls.openRayPoints.push(
  [-232.28, -591.67],
  [-390.08, 702],
  [853.81, -423.9],
  [1244.47, -629.76],
);
controls.restPoints.push([-232.28, -591.67], [-390.08, 702], [1244.47, -629.76]);
const publishedById = new Map(world.buildings.map((owner) => [owner.entityId, owner]));
const approachAudits: {
  ownerId: string;
  approachId: string;
  supportId: string;
  sourceLength?: number;
  targetLength: number;
  routePoints: CityPoint[];
  routeScope: string;
  topTriangles?: number;
  maximumSlopeDegrees?: number;
  maximumRayErrorMetres?: number;
}[] = [];
const toWorld = (owner: BuildingInstance, point: CityPoint): CityPoint => {
  const p = transformWorldPoint({ x: point[0], y: 0, z: point[1] }, owner.position, owner.rotation);
  return [p.x, p.z];
};
for (const owner of afterOwners) {
  const rule = selectSupportRule(target.terrain.supports, owner);
  const oldRule = selectSupportRule(source.terrain.supports, owner);
  for (const approach of rule?.approaches ?? []) {
    const supportId = terrainSupportId(world.worldId, owner.entityId, `approach:${approach.id}`);
    check(`approach-publication:${owner.entityId}:${approach.id}`, () => {
      assert.ok(
        publishedById.has(supportId),
        'Retained approach is missing from actual publication',
      );
      assert.deepEqual(manifest.generatedSupports?.[supportId], {
        ownerId: owner.entityId,
        role: `approach:${approach.id}`,
      });
    });
    const middle: CityPoint = [
      (approach.edge[0][0] + approach.edge[1][0]) / 2,
      (approach.edge[0][1] + approach.edge[1][1]) / 2,
    ];
    const at = (distance: number) =>
      toWorld(owner, [
        middle[0] + approach.outward[0] * distance,
        middle[1] + approach.outward[1] * distance,
      ]);
    const legacy =
      owner.entityId === 'osm-way-1291799392' && approach.id === 'osm-way-1291799392-facade-0-0-1';
    const routePoints: CityPoint[] = legacy
      ? [
          [-62.84950644719729, -45.08421697131294],
          [-54.82787410324662, -28.97045221758502],
        ]
      : [at(Math.max(approach.length, 1.5) + 0.7), at(0.7)];
    controls.routes.push({ id: `approach:${owner.entityId}:${approach.id}`, points: routePoints });
    approachAudits.push({
      ownerId: owner.entityId,
      approachId: approach.id,
      supportId,
      sourceLength: oldRule?.approaches?.find((a) => a.id === approach.id)?.length,
      targetLength: approach.length,
      routePoints,
      routeScope: legacy
        ? 'Reviewed existing exterior shopfront route. Decorative door/corridor is blocked in the unchanged source model; interior access is not asserted.'
        : 'Full-city actual generated approach corridor',
    });
  }
}
check('retained-approach-coverage', () => {
  const targetKeys = new Set(approachAudits.map((row) => `${row.ownerId}:${row.approachId}`));
  let sourceCount = 0;
  for (const owner of beforeOwners) {
    for (const approach of selectSupportRule(source.terrain!.supports, owner)?.approaches ?? []) {
      sourceCount++;
      assert.ok(
        targetKeys.has(`${owner.entityId}:${approach.id}`),
        `Existing approach was omitted: ${owner.entityId}:${approach.id}`,
      );
    }
  }
  assert.ok(sourceCount > 0, 'Source must contain the existing reviewed approaches');
});
async function verifyApproachCaps() {
  const ids = new Set(approachAudits.map((row) => row.supportId));
  const buildings = world.buildings.filter((owner) => ids.has(owner.entityId));
  const physics = await createPhysicsWorld(
    {
      ...world,
      entities: [],
      initialItems: [],
      buildings,
      buildingAssets: Object.fromEntries(
        buildings.map((owner) => [owner.assetId, world.buildingAssets[owner.assetId]]),
      ),
    },
    await loadServerWasm(),
    false,
  );
  let capRays = 0;
  try {
    for (const record of approachAudits)
      check(`approach-cap:${record.ownerId}:${record.approachId}`, () => {
        const owner = publishedById.get(record.supportId);
        assert.ok(owner);
        const asset = world.buildingAssets[owner.assetId];
        let topTriangles = 0,
          maximumSlopeDegrees = 0,
          maximumRayErrorMetres = 0;
        for (const collider of asset.colliders) {
          assert.equal(collider.kind, 'mesh');
          if (collider.kind !== 'mesh') continue;
          for (let i = 0; i < collider.indices.length; i += 3) {
            const triangle = collider.indices.slice(i, i + 3).map((id) => {
              const local = transformWorldPoint(
                {
                  x: collider.vertices[id * 3],
                  y: collider.vertices[id * 3 + 1],
                  z: collider.vertices[id * 3 + 2],
                },
                collider.position,
                collider.rotation,
              );
              return transformWorldPoint(local, owner.position, owner.rotation);
            }) as [
              { x: number; y: number; z: number },
              { x: number; y: number; z: number },
              { x: number; y: number; z: number },
            ];
            const normal = terrainNormal(triangle);
            if (normal.y <= 1e-10) continue;
            const slope = (Math.atan2(Math.hypot(normal.x, normal.z), normal.y) * 180) / Math.PI;
            const center = {
              x: (triangle[0].x + triangle[1].x + triangle[2].x) / 3,
              y: (triangle[0].y + triangle[1].y + triangle[2].y) / 3,
              z: (triangle[0].z + triangle[1].z + triangle[2].z) / 3,
            };
            const hit = physics.surfaceRay(
              { ...center, y: center.y + 0.05 },
              { ...center, y: center.y - 0.05 },
            );
            assert.ok(
              hit && ids.has(hit.entityId!),
              `Missing actual Havok cap: ${JSON.stringify(center)}`,
            );
            maximumRayErrorMetres = Math.max(
              maximumRayErrorMetres,
              Math.abs(hit.point.y - center.y),
            );
            maximumSlopeDegrees = Math.max(maximumSlopeDegrees, slope);
            topTriangles++;
            capRays++;
          }
        }
        Object.assign(record, { topTriangles, maximumSlopeDegrees, maximumRayErrorMetres });
        assert.ok(topTriangles > 0, 'Approach has no upward cap triangles');
        assert.ok(
          maximumSlopeDegrees <= 12 + 1e-6,
          `Approach slope ${maximumSlopeDegrees} exceeds12degrees`,
        );
        assert.ok(
          maximumRayErrorMetres <= 0.01,
          `Actual cap error ${maximumRayErrorMetres} exceeds1cm`,
        );
      });
  } finally {
    physics.dispose();
  }
  return {
    approaches: approachAudits.length,
    capRays,
    scope:
      'Actual published cap solids isolated for mesh/ray agreement. Walk/sprint corridors use the entire city.',
  };
}
const approachCaps = await verifyApproachCaps();
const profiles = RING_TERRAIN_EXPRESSIVENESS_ROUTES.map((route) => ({
  id: route.id,
  label: route.label,
  source: measureTerrainProfile(before, route.points, 5),
  target: measureTerrainProfile(after, route.points, 5),
}));
check('expressive-control-profiles', () => {
  for (const { id, source, target } of profiles) {
    assert.ok(target.relief > source.relief, `Control relief did not increase: ${id}`);
    if (id === 'river')
      assert.ok(target.rise < -30, 'River descent must exceed 30m on the fixed 2450m control');
    if (id === 'dimitrova')
      assert.ok(target.rise >= 9, 'Dimitrova must rise at least 9m on the fixed route');
    if (id === 'oplesnina')
      assert.ok(
        target.relief >= 10,
        'Oplesnina hill must have at least 10m relief on the fixed route',
      );
  }
});
const slopes = (grid: TerrainGrid) => {
  const values: number[] = [];
  for (let row = 0; row < grid.rows - 1; row++)
    for (let col = 0; col < grid.columns - 1; col++)
      for (const triangle of terrainCellTriangles(grid, col, row)) {
        const normal = terrainNormal(triangle);
        values.push((Math.acos(normal.y) * 180) / Math.PI);
      }
  values.sort((a, b) => a - b);
  return {
    triangles: values.length,
    p50: values[Math.ceil(values.length * 0.5) - 1],
    p95: values[Math.ceil(values.length * 0.95) - 1],
    maximum: values.at(-1),
  };
};

/** Read actual far GLB triangles, including road offsets, rather than trusting only a manifest hash. */
async function verifyFarGround() {
  let triangleCount = 0,
    sampleCount = 0,
    maximumError = 0,
    checkedGroups = 0;
  const binaryValues = (bytes: Buffer, gltf: any, accessorId: number, stride: number) => {
    const accessor = gltf.accessors[accessorId],
      view = gltf.bufferViews[accessor.bufferView];
    assert.equal(accessor.type, stride === 3 ? 'VEC3' : 'SCALAR');
    assert.equal(accessor.componentType, stride === 3 ? 5126 : 5125);
    const offset =
      28 + bytes.readUInt32LE(12) + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    return Array.from({ length: accessor.count * stride }, (_, i) =>
      stride === 3
        ? bytes.readFloatLE(
            offset + Math.floor(i / stride) * (view.byteStride ?? stride * 4) + (i % stride) * 4,
          )
        : bytes.readUInt32LE(offset + i * (view.byteStride ?? 4)),
    );
  };
  for (const group of manifest.graphics!.groups) {
    let ground = false;
    for (const resource of group.far.resources) {
      const [bytes, partsBytes] = await Promise.all([
        readFile(join(publishedDirectory, resource.modelFile)),
        readFile(join(publishedDirectory, resource.partsFile)),
      ]);
      assert.equal(hash(bytes), manifest.files[resource.modelFile]);
      assert.equal(hash(partsBytes), manifest.files[resource.partsFile]);
      const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
      const parts = JSON.parse(partsBytes.toString('utf8'));
      for (const part of parts.parts.filter((part: { ground: boolean }) => part.ground)) {
        ground = true;
        const node = gltf.nodes[part.nodeIndex];
        assert.ok(
          !node.translation && !node.rotation && !node.scale && !node.matrix,
          'Far ground uses global coordinates',
        );
        for (const primitive of gltf.meshes[node.mesh].primitives) {
          const positions = binaryValues(bytes, gltf, primitive.attributes.POSITION, 3),
            indices = binaryValues(bytes, gltf, primitive.indices, 1);
          for (let i = 0; i < indices.length; i += 3) {
            triangleCount++;
            const vertices = indices
              .slice(i, i + 3)
              .map((id) => positions.slice(id * 3, id * 3 + 3));
            for (const barycentric of [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
              [1 / 3, 1 / 3, 1 / 3],
              [0.5, 0.5, 0],
              [0, 0.5, 0.5],
              [0.5, 0, 0.5],
            ]) {
              const p = [0, 1, 2].map((axis) =>
                vertices.reduce((sum, vertex, j) => sum + barycentric[j] * vertex[axis], 0),
              );
              const canonical = sampleTerrain(after, p[0], p[2]);
              assert.ok(canonical, `Far ground outside canonical grid: ${p}`);
              maximumError = Math.max(maximumError, Math.abs(p[1] - canonical.height));
              sampleCount++;
            }
          }
        }
      }
    }
    if (ground) checkedGroups++;
  }
  assert.ok(checkedGroups > 0 && triangleCount > 0);
  assert.ok(
    maximumError <= 0.25,
    `Far ground differs from canonical grid by ${maximumError}m (0.2m simplification + 0.04m coatings)`,
  );
  return {
    checkedGroups,
    triangleCount,
    sampleCount,
    maximumError,
    limitMetres: 0.25,
    method:
      'Every ground triangle: three vertices, three edge midpoints, centroid; canonical piecewise-linear grid. Sampled check supplements exact simplifier overlay tests.',
  };
}
let farGround: Awaited<ReturnType<typeof verifyFarGround>> | undefined;
try {
  farGround = await verifyFarGround();
} catch (error) {
  issues.push({
    scenario: 'far-ground-surface',
    message: error instanceof Error ? error.message : String(error),
  });
}
const statistics = async (
  release: Pick<AuthoringRelease, 'directory' | 'definition' | 'manifest'>,
) => {
  const groundAssets = new Set(
    release.definition.buildings
      .filter((owner) => owner.assetId.startsWith('ring-block-ground-'))
      .map((owner) => owner.assetId),
  );
  let groundTriangles = 0,
    groundModelBytes = 0;
  for (const id of groundAssets) {
    const asset = release.definition.buildingAssets[id];
    for (const collider of asset.colliders)
      if (collider.kind === 'mesh') groundTriangles += collider.indices.length / 3;
    const file = release.manifest.assets[id].modelFile;
    if (file) groundModelBytes += (await stat(join(release.directory, file))).size;
  }
  return {
    groundAssets: groundAssets.size,
    groundCollisionTriangles: groundTriangles,
    groundModelBytes,
    farGroups: release.manifest.graphics?.groups.length,
    farTriangles: release.manifest.graphics?.groups.reduce((n, g) => n + g.far.triangles, 0),
    farGeometryBytes: release.manifest.graphics?.groups.reduce(
      (n, g) => n + g.far.geometryBytes,
      0,
    ),
    farDrawUnits: release.manifest.graphics?.groups.reduce((n, g) => n + g.far.drawUnits, 0),
  };
};
const groundIds = world.buildings
  .filter((owner) => owner.assetId.startsWith('ring-block-ground-'))
  .map((owner) => owner.entityId);
assert.ok(groundIds.length, 'No canonical ground owners');
console.log(
  JSON.stringify({
    status: 'physical-acceptance-started',
    groundOwners: groundIds.length,
    routes: controls.routes.length,
  }),
);
const physical = await cityTerrainAcceptance(
  world,
  manifest,
  after,
  groundIds,
  controls,
  await loadServerWasm(),
);
issues.push(...physical.issues);
const result = {
  formatVersion: 1,
  status: issues.length ? 'failed' : 'passed',
  scope:
    'Actual runtime publication of the committed authoring seed, including derived foundations and approaches. Does not prove migration of current production placements, items or saved player positions; terrain-command plan/apply validates those at release time.',
  databaseAccess: false,
  source: {
    directory: source.directory,
    assetReleaseVersion: source.metadata.assetReleaseVersion,
    mapVersion: source.manifest.mapVersion,
    gridCanonicalSha256: hash(canonicalJson(before)),
    statistics: await statistics({ ...sourcePublished, directory: sourcePublishedDirectory }),
    authoringMapVersion: source.manifest.mapVersion,
    publishedDirectory: sourcePublishedDirectory,
    publishedMapVersion: sourcePublished.manifest.mapVersion,
    slopesDegrees: slopes(before),
  },
  target: {
    directory: target.directory,
    assetReleaseVersion: target.metadata.assetReleaseVersion,
    mapVersion: manifest.mapVersion,
    gridCanonicalSha256: hash(canonicalJson(after)),
    statistics: await statistics({ ...published, directory: publishedDirectory }),
    authoringMapVersion: target.manifest.mapVersion,
    publishedDirectory,
    publishedMapVersion: manifest.mapVersion,
    slopesDegrees: slopes(after),
  },
  editableOwners: {
    count: beforeOwners.length,
    changedY: beforeOwners.filter(
      (owner) => owner.position.y !== afterOwnerById.get(owner.entityId)?.position.y,
    ).length,
  },
  profiles,
  approachCaps,
  approachAudits,
  farGround,
  physical,
  issues,
};
await mkdir(dirname(reportFile), { recursive: true });
await writeFile(reportFile, JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    status: result.status,
    report: reportFile,
    issues,
    profiles: profiles.map(({ id, source, target }) => ({
      id,
      sourceRise: source.rise,
      targetRise: target.rise,
      sourceRelief: source.relief,
      targetRelief: target.relief,
    })),
  }),
);
if (result.status !== 'passed') process.exitCode = 1;
