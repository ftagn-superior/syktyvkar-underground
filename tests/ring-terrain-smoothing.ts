/** Offline acceptance of the exact smoothed release and supplied saved layout; never opens a DB. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  canonicalJson,
  createWorldLayoutPatch,
  applyWorldLayoutPatch,
  sampleTerrain,
  type BuildingInstance,
  type BuildingPhysicsAsset,
  type TerrainGrid,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { readWorldDirectory } from '../apps/server/src/world-bundle.js';
import { readAuthoringRelease, terrainSupportId } from '../apps/server/src/layout/release.js';
import {
  planStaticTerrainPoses,
  type TerrainPoseRules,
} from '../apps/server/src/layout/terrain-poses.js';
import { planSupportPlacement, selectSupportRule } from '../packages/terrain-build/src/supports.js';
import { createPhysicsWorld } from '../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { generateFootprint } from '../tools/world-build/src/city.js';
import {
  cityTerrainAcceptance,
  type CityAcceptanceControls,
  type CityPoint,
} from './terrain/city-acceptance.js';

const base = 'output/terrain-smoothing-20261114';
const paths = new Map([
  ['--source-world', `${base}/source-world`],
  ['--source-export-world', `${base}/source-export-world`],
  ['--authoring-world', `${base}/authoring-world`],
  ['--export-world', `${base}/export-world`],
  ['--source-snapshot', 'data/map-layout.json'],
  ['--target-snapshot', `${base}/target-static-snapshot.json`],
  ['--rules', `${base}/terrain-pose-rules.json`],
  ['--report', `${base}/physical-acceptance.json`],
]);
const supplied = new Set<string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  assert.ok(
    paths.has(key) && !supplied.has(key) && value && !value.startsWith('--'),
    `Invalid argument ${key}`,
  );
  paths.set(key, value);
  supplied.add(key);
}
for (const [key, value] of paths) paths.set(key, resolve(value));
const reportFile = paths.get('--report')!;
for (const [key, input] of paths) {
  if (key === '--report') continue;
  assert.notEqual(reportFile, input, 'Report must not overwrite an input');
  if (key.endsWith('-world')) {
    const inside = relative(input, reportFile);
    assert.ok(
      inside === '..' || inside.startsWith(`..${sep}`),
      'Report must be outside immutable releases',
    );
  }
}
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8'));
const [source, target, published, sourceSnapshot, targetSnapshot, rules] = await Promise.all([
  readAuthoringRelease(paths.get('--source-world')!),
  readAuthoringRelease(paths.get('--authoring-world')!),
  readWorldDirectory(paths.get('--export-world')!),
  readJson<WorldLayoutSnapshot>(paths.get('--source-snapshot')!),
  readJson<WorldLayoutSnapshot>(paths.get('--target-snapshot')!),
  readJson<TerrainPoseRules>(paths.get('--rules')!),
]);
assert.ok(source.terrain?.formatVersion === 2 && target.terrain?.formatVersion === 2);
const targetTerrain = target.terrain;
const world = published.definition,
  grid = target.terrain.grid;
const issues: { scenario: string; message: string }[] = [];
const check = (scenario: string, action: () => void) => {
  try {
    action();
  } catch (error) {
    issues.push({ scenario, message: error instanceof Error ? error.message : String(error) });
  }
};
const inputs = await Promise.all(
  [...paths]
    .filter(([key]) => key !== '--report')
    .map(async ([key, path]) => ({
      key,
      path,
      sha256: hash(await readFile(key.endsWith('-world') ? join(path, 'manifest.json') : path)),
    })),
);
const sourceById = new Map(sourceSnapshot.instances.map((owner) => [owner.entityId, owner]));
const targetById = new Map(targetSnapshot.instances.map((owner) => [owner.entityId, owner]));
const publishedById = new Map(world.buildings.map((owner) => [owner.entityId, owner]));
const reseated = new Set((rules.disabledReseats ?? []).map((decision) => decision.entityId));
const legacyOwnerId = 'osm-way-1291799392';
const legacyApproachId = 'osm-way-1291799392-facade-0-0-1';
const legacyOuterRoute: CityPoint[] = [
  [-62.84950644719729, -45.08421697131294],
  [-54.82787410324662, -28.97045221758502],
];
const legacyChecks: unknown[] = [];
const withoutY = (owner: WorldLayoutSnapshot['instances'][number]) => ({
  ...owner,
  instanceRevision: 0,
  position: { ...owner.position, y: 0 },
});
check('snapshot-header', () => {
  assert.equal(sourceSnapshot.assetReleaseVersion, source.metadata.assetReleaseVersion);
  assert.equal(targetSnapshot.assetReleaseVersion, target.metadata.assetReleaseVersion);
  assert.equal(sourceSnapshot.worldId, targetSnapshot.worldId);
  assert.equal(targetSnapshot.worldId, world.worldId);
  assert.equal(sourceSnapshot.seedVersion, targetSnapshot.seedVersion);
  assert.equal(
    targetSnapshot.revision,
    sourceSnapshot.revision +
      sourceSnapshot.instances.filter(
        (owner) => owner.position.y !== targetById.get(owner.entityId)?.position.y,
      ).length +
      1,
    'Patch revisions plus the release transition',
  );
  assert.equal(sourceSnapshot.instances.length, targetSnapshot.instances.length);
  assert.equal(sourceById.size, sourceSnapshot.instances.length);
  assert.equal(targetById.size, targetSnapshot.instances.length);
});
for (const before of sourceSnapshot.instances)
  check(`pose:${before.entityId}`, () => {
    const after = targetById.get(before.entityId);
    assert.ok(after, 'Saved owner was removed');
    assert.deepEqual(withoutY(after), withoutY(before), 'A field other than Y changed');
    assert.equal(
      after.instanceRevision,
      before.instanceRevision + (after.position.y !== before.position.y ? 1 : 0),
      'Per-owner patch revision',
    );
    const actual = publishedById.get(before.entityId);
    if (after.enabled) {
      assert.ok(actual, 'Enabled owner is absent from publication');
      assert.equal(actual.assetId, after.assetId);
      assert.deepEqual(actual.position, after.position);
      assert.deepEqual(actual.rotation, after.rotation);
    } else {
      assert.equal(actual, undefined, 'Disabled owner was published');
      if (!reseated.has(before.entityId)) assert.deepEqual(after, before);
    }
    assert.equal(
      canonicalJson(source.definition.buildingAssets[before.assetId]),
      canonicalJson(target.definition.buildingAssets[before.assetId]),
      'Model collision geometry changed',
    );
  });
check('planner-reproduction', () => {
  const plan = planStaticTerrainPoses(
    {
      sourceRelease: source,
      targetRelease: target,
      sourceSnapshot,
      sourceWorld: source.definition,
      sourceItems: [],
      sourcePlayers: [],
    },
    rules,
  );
  assert.deepEqual(plan.issues, []);
  const patch = createWorldLayoutPatch(sourceSnapshot, {
    ...plan.targetSnapshot,
    assetReleaseVersion: sourceSnapshot.assetReleaseVersion,
  });
  const patched = applyWorldLayoutPatch(sourceSnapshot, patch);
  assert.equal(
    canonicalJson({
      ...patched,
      assetReleaseVersion: target.metadata.assetReleaseVersion,
      revision: patched.revision + 1,
    }),
    canonicalJson(targetSnapshot),
  );
});

const transform = (owner: BuildingInstance, point: readonly [number, number]): CityPoint => {
  const q = owner.rotation,
    norm = q.y * q.y + q.w * q.w;
  const c = (q.w * q.w - q.y * q.y) / norm,
    s = (2 * q.y * q.w) / norm;
  return [
    owner.position.x + c * point[0] + s * point[1],
    owner.position.z - s * point[0] + c * point[1],
  ];
};
/** All breakpoints of a line on the actual NW–SE terrain triangulation. */
function edgeTerrainHeights(terrain: TerrainGrid, a: CityPoint, b: CityPoint) {
  const cuts = new Set([0, 1]);
  for (const [start, end] of [
    [(a[0] - terrain.origin.x) / terrain.spacing, (b[0] - terrain.origin.x) / terrain.spacing],
    [(a[1] - terrain.origin.z) / terrain.spacing, (b[1] - terrain.origin.z) / terrain.spacing],
    [
      (a[0] - terrain.origin.x - a[1] + terrain.origin.z) / terrain.spacing,
      (b[0] - terrain.origin.x - b[1] + terrain.origin.z) / terrain.spacing,
    ],
  ]) {
    if (Math.abs(end - start) < 1e-12) continue;
    for (let k = Math.ceil(Math.min(start, end)); k <= Math.floor(Math.max(start, end)); k++) {
      const t = (k - start) / (end - start);
      if (t > 0 && t < 1) cuts.add(t);
    }
  }
  return [...cuts]
    .sort((a, b) => a - b)
    .map((t) => {
      const x = a[0] + t * (b[0] - a[0]),
        z = a[1] + t * (b[1] - a[1]);
      const sample = sampleTerrain(terrain, x, z);
      assert.ok(sample, 'Approach edge outside terrain');
      return { t, x, z, height: sample.height };
    });
}
function upwardFaces(asset: BuildingPhysicsAsset) {
  const faces: { center: { x: number; y: number; z: number }; slope: number }[] = [];
  for (const collider of asset.colliders) {
    assert.equal(collider.kind, 'mesh');
    if (collider.kind !== 'mesh') continue;
    assert.deepEqual(collider.position, { x: 0, y: 0, z: 0 });
    assert.deepEqual(collider.rotation, { x: 0, y: 0, z: 0, w: 1 });
    for (let i = 0; i < collider.indices.length; i += 3) {
      const [a, b, c] = collider.indices.slice(i, i + 3).map((id) => ({
        x: collider.vertices[id * 3],
        y: collider.vertices[id * 3 + 1],
        z: collider.vertices[id * 3 + 2],
      }));
      const ux = b.x - a.x,
        uy = b.y - a.y,
        uz = b.z - a.z,
        vx = c.x - a.x,
        vy = c.y - a.y,
        vz = c.z - a.z;
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      if (ny <= 1e-10) continue;
      faces.push({
        center: { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 },
        slope: (Math.atan2(Math.hypot(nx, nz), ny) * 180) / Math.PI,
      });
    }
  }
  return faces;
}
const controls: CityAcceptanceControls = await readJson(
  'tests/fixtures/ring-terrain-city-controls.json',
);
// Fixed controls from the provided OSM road context; do not select new points after a failed run.
controls.routes.push(
  {
    id: 'smoothing-oplesnina-hill',
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
    id: 'smoothing-dimitrova-ascent',
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
    id: 'smoothing-river-descent-west',
    points: [
      [503.83, -252.67],
      [671.78, -335.16],
      [687.82, -341.39],
      [756.42, -376.32],
      [853.81, -423.9],
    ],
  },
  {
    id: 'smoothing-river-descent-east',
    points: [
      [1146.45, -578.67],
      [1195.99, -604.49],
      [1244.47, -629.76],
      [1315.48, -664.72],
      [1397.86, -705.28],
    ],
  },
);
controls.openRayPoints.push(
  [-232.28, -591.67],
  [-390.08, 702],
  [853.81, -423.9],
  [1244.47, -629.76],
);
controls.restPoints.push([-232.28, -591.67], [-390.08, 702], [1244.47, -629.76]);
const approaches: {
  ownerId: string;
  assetId: string;
  approachId: string;
  retained: boolean;
  oldLength: number;
  newLength?: number;
  maximumThresholdMetres: number;
  maximumSlopeDegrees?: number;
  topTriangles?: number;
  maximumRayErrorMetres?: number;
  endpoint: CityPoint;
  authoredTargetY: number;
  actualEndpointSurfaceY?: number;
  endpointSurfaceId?: string;
  endpointHeightGap?: number;
  routeScope?: string;
  originalRoutePoints?: CityPoint[];
}[] = [];
const elevatedWalls: { entityId: string; assetId: string; visibleHeight: number; limit: number }[] =
  [];
const wallFoundationRays: {
  entityId: string;
  scope: string;
  rays: number;
  maximumError: number;
}[] = [];
const physics = await createPhysicsWorld(
  { ...world, initialItems: [] },
  await loadServerWasm(),
  false,
);
const legacyRecipe = await readJson<Parameters<typeof generateFootprint>[1]>(
  'content/buildings/ring-block/osm-way-1291799392/source.json',
);
const legacyDoors = generateFootprint(legacyOwnerId, { ...legacyRecipe, merge: false }).parts.find(
  (part) => part.partId === 'doors',
)!;
assert.ok(legacyDoors, 'Legacy decorative door mesh is required for baseline diagnosis');
const doorVertices = [...new Set(legacyDoors.indices.slice(12, 18))];
const doorBottom = Math.min(...doorVertices.map((id) => legacyDoors.positions[id * 3 + 1]));
const bottomVertices = doorVertices.filter(
  (id) => Math.abs(legacyDoors.positions[id * 3 + 1] - doorBottom) < 1e-8,
);
assert.equal(bottomVertices.length, 2);
const doorLocal: CityPoint = [
  (legacyDoors.positions[bottomVertices[0] * 3] + legacyDoors.positions[bottomVertices[1] * 3]) / 2,
  (legacyDoors.positions[bottomVertices[0] * 3 + 2] +
    legacyDoors.positions[bottomVertices[1] * 3 + 2]) /
    2,
];
const doorNormal: CityPoint = [
  legacyDoors.normals[doorVertices[0] * 3],
  legacyDoors.normals[doorVertices[0] * 3 + 2],
];
function probeLegacy(
  stage: 'source' | 'target',
  physical: typeof physics,
  terrain: TerrainGrid,
  owner: BuildingInstance,
) {
  const oldRule = selectSupportRule(source.terrain!.supports, owner)!;
  const approach = oldRule.approaches!.find((item) => item.id === legacyApproachId)!;
  const midpoint: CityPoint = [
    (approach.edge[0][0] + approach.edge[1][0]) / 2,
    (approach.edge[0][1] + approach.edge[1][1]) / 2,
  ];
  const oldStart = transform(owner, [
    midpoint[0] + approach.outward[0] * (approach.length + 0.7),
    midpoint[1] + approach.outward[1] * (approach.length + 0.7),
  ]);
  const height = sampleTerrain(terrain, ...oldStart)!.height;
  const oldStartCenter = physical.spawnPosition({ x: oldStart[0], y: height, z: oldStart[1] });
  const startCheck = physical.checkPlayerSpawnPosition(oldStartCenter);
  const decorativeDoor = transform(owner, [
    doorLocal[0] + doorNormal[0] * 0.7,
    doorLocal[1] + doorNormal[1] * 0.7,
  ]);
  const doorCenter = {
    x: decorativeDoor[0],
    y: owner.position.y + doorBottom + world.simulation.character.height / 2 + 0.02,
    z: decorativeDoor[1],
  };
  const doorCheck = physical.checkPlayerSpawnPosition(doorCenter);
  const record = {
    stage,
    ownerId: legacyOwnerId,
    approachId: legacyApproachId,
    oldStart,
    oldStartCenter,
    startCheck,
    decorativeDoor: { partId: 'doors', index: 2, center: doorCenter, check: doorCheck },
    outerRoute: legacyOuterRoute,
  };
  legacyChecks.push(record);
  check(`legacy-shopfront:${stage}`, () => {
    assert.deepEqual(
      startCheck,
      { ok: false, reason: 'BLOCKED' },
      'Reviewed legacy start diagnosis changed',
    );
    assert.deepEqual(
      doorCheck,
      { ok: false, reason: 'BLOCKED' },
      'Reviewed decorative door diagnosis changed',
    );
  });
}
try {
  probeLegacy('target', physics, grid, targetById.get(legacyOwnerId)!);
  for (const owner of targetSnapshot.instances.filter((owner) => owner.enabled)) {
    const before = sourceById.get(owner.entityId)!;
    const oldRule = selectSupportRule(source.terrain.supports, before);
    const newRule = selectSupportRule(target.terrain.supports, owner);
    if (!newRule) continue;
    if (owner.assetId === 'wall-3e76aad470cd519f' || owner.assetId === 'wall-6554fcd6f5196079') {
      check(`wall:${owner.entityId}`, () => {
        const placement = planSupportPlacement(grid, newRule, owner);
        const policy = targetTerrain.placementModels?.find(
          (model) => model.assetId === owner.assetId,
        )?.policy;
        assert.ok(policy && policy.kind === 'foundation');
        const visibleHeight = owner.position.y + newRule.jointY - placement.terrainMin;
        assert.ok(visibleHeight <= policy.maximumVisibleHeight + 1e-8);
        assert.ok(publishedById.has(terrainSupportId(world.worldId, owner.entityId, 'foundation')));
        elevatedWalls.push({
          entityId: owner.entityId,
          assetId: owner.assetId,
          visibleHeight,
          limit: policy.maximumVisibleHeight,
        });
      });
    }
    for (const old of oldRule?.approaches ?? []) {
      const current = newRule.approaches?.find((a) => a.id === old.id);
      const middle: CityPoint = [
        (old.edge[0][0] + old.edge[1][0]) / 2,
        (old.edge[0][1] + old.edge[1][1]) / 2,
      ];
      // Coordinates belong to the old explicit corridor; only owner Y changes.
      const at = (distance: number) =>
        transform(owner, [
          middle[0] + old.outward[0] * distance,
          middle[1] + old.outward[1] * distance,
        ]);
      const endpoint = at(0.7);
      const record: (typeof approaches)[number] = {
        ownerId: owner.entityId,
        assetId: owner.assetId,
        approachId: old.id,
        retained: !!current,
        oldLength: old.length,
        ...(current ? { newLength: current.length } : {}),
        maximumThresholdMetres:
          owner.position.y +
          old.targetY -
          Math.min(
            ...edgeTerrainHeights(
              grid,
              transform(owner, old.edge[0]),
              transform(owner, old.edge[1]),
            ).map((p) => p.height),
          ),
        endpoint,
        authoredTargetY: owner.position.y + old.targetY,
      };
      approaches.push(record);
      const originalPoints = [at(Math.max(old.length, current?.length ?? 0) + 0.7), endpoint];
      const legacy = owner.entityId === legacyOwnerId && old.id === legacyApproachId;
      if (legacy) {
        record.routeScope =
          'reviewed outer shopfront boundary; original decorative door is blocked in source and target';
        record.originalRoutePoints = originalPoints;
      }
      controls.routes.push({
        id: `old-approach:${owner.entityId}:${old.id}`,
        points: legacy ? legacyOuterRoute : originalPoints,
      });
      check(`approach:${owner.entityId}:${old.id}`, () => {
        const assetId = terrainSupportId(world.worldId, owner.entityId, `approach:${old.id}`);
        if (!current) {
          assert.equal(publishedById.get(assetId), undefined, 'Removed approach still exists');
          assert.ok(
            record.maximumThresholdMetres <= 0.18 + 1e-8,
            `Removed approach threshold ${record.maximumThresholdMetres} exceeds 0.18 m at final owner Y`,
          );
        } else {
          assert.ok(publishedById.has(assetId), 'Retained approach missing');
          const asset = world.buildingAssets[assetId];
          let triangles = 0,
            maximumSlope = 0,
            maximumError = 0;
          for (const { center, slope } of upwardFaces(asset)) {
            triangles++;
            maximumSlope = Math.max(maximumSlope, slope);
            const hit = physics.surfaceRay(
              { ...center, y: center.y + 0.05 },
              { ...center, y: center.y - 0.05 },
            );
            assert.ok(hit, `Missing Havok approach cap at ${JSON.stringify(center)}`);
            assert.equal(
              hit.entityId,
              assetId,
              'Approach cap is occluded by another static collider',
            );
            maximumError = Math.max(maximumError, Math.abs(hit.point.y - center.y));
          }
          record.topTriangles = triangles;
          record.maximumSlopeDegrees = maximumSlope;
          record.maximumRayErrorMetres = maximumError;
          assert.ok(triangles > 0, 'No upward approach faces');
          assert.ok(
            maximumSlope <= 12 + 1e-6,
            `Retained approach slope ${maximumSlope} exceeds 12 degrees at final owner Y`,
          );
          assert.ok(maximumError <= 0.01, `Havok cap ray error ${maximumError}`);
        }
      });
      const floor = physics.surfaceRay(
        { x: endpoint[0], y: record.authoredTargetY + 0.25, z: endpoint[1] },
        { x: endpoint[0], y: grid.bottom - 1, z: endpoint[1] },
      );
      if (floor) {
        record.actualEndpointSurfaceY = floor.point.y;
        record.endpointSurfaceId = floor.entityId;
        record.endpointHeightGap = record.authoredTargetY - floor.point.y;
      }
    }
  }
} finally {
  physics.dispose();
}
const sourcePublished = await readWorldDirectory(paths.get('--source-export-world')!);
const sourcePhysics = await createPhysicsWorld(
  { ...sourcePublished.definition, initialItems: [] },
  await loadServerWasm(),
  false,
);
try {
  probeLegacy('source', sourcePhysics, source.terrain.grid, sourceById.get(legacyOwnerId)!);
} finally {
  sourcePhysics.dispose();
}
const legacyBaseline = {
  formatVersion: 1,
  scope:
    'Pre-existing blocked decorative door and corridor, diagnosed in exact source and target publications. Exterior shopfront route is tested separately; no interior access is asserted.',
  sourceMapVersion: sourcePublished.manifest.mapVersion,
  targetMapVersion: published.manifest.mapVersion,
  modelColliderSha256: hash(canonicalJson(world.buildingAssets[legacyOwnerId])),
  checks: legacyChecks,
};
await mkdir(dirname(reportFile), { recursive: true });
await writeFile(
  join(dirname(reportFile), 'legacy-shopfront-baseline.json'),
  JSON.stringify(legacyBaseline, null, 2) + '\n',
);
// The wall bodies cover their own foundation caps. Compare those four exact
// generated solids in isolation; full-city movement is exercised separately.
const wallSupportIds = new Set(
  elevatedWalls.map((wall) => terrainSupportId(world.worldId, wall.entityId, 'foundation')),
);
const wallSupports = world.buildings.filter((owner) => wallSupportIds.has(owner.entityId));
const wallPhysics = await createPhysicsWorld(
  {
    ...world,
    entities: [],
    initialItems: [],
    buildings: wallSupports,
    buildingAssets: Object.fromEntries(
      wallSupports.map((owner) => [owner.assetId, world.buildingAssets[owner.assetId]]),
    ),
  },
  await loadServerWasm(),
  false,
);
try {
  for (const owner of wallSupports)
    check(`wall-foundation-rays:${owner.entityId}`, () => {
      const faces = upwardFaces(world.buildingAssets[owner.assetId]);
      assert.ok(faces.length);
      let maximumError = 0;
      for (const { center } of faces) {
        const hit = wallPhysics.surfaceRay(
          { ...center, y: center.y + 0.05 },
          { ...center, y: center.y - 0.05 },
        );
        assert.ok(hit && wallSupportIds.has(hit.entityId!), 'Missing actual wall foundation cap');
        maximumError = Math.max(maximumError, Math.abs(hit.point.y - center.y));
      }
      assert.ok(maximumError <= 0.01);
      wallFoundationRays.push({
        entityId: owner.entityId,
        scope: 'four-foundation-solids-only; wall bodies omitted',
        rays: faces.length,
        maximumError,
      });
    });
} finally {
  wallPhysics.dispose();
}
check('old-approach-count', () =>
  assert.equal(approaches.length, 116, 'Every previously authored approach must be assessed'),
);
check('elevated-wall-count', () => assert.equal(elevatedWalls.length, 4));
const partial = {
  formatVersion: 1,
  status: issues.length ? 'failed' : 'running',
  databaseAccess: false,
  scope:
    'Exact exported statics; synthetic capsule only. No saved dynamic items or players were supplied. Door routes stop outside solid facades and do not assert interior access.',
  mapVersion: published.manifest.mapVersion,
  inputs,
  runnerSha256: hash(await readFile(new URL(import.meta.url))),
  savedOwners: sourceSnapshot.instances.length,
  enabledOwners: sourceSnapshot.instances.filter((owner) => owner.enabled).length,
  disabledOwners: sourceSnapshot.instances.filter((owner) => !owner.enabled).length,
  approaches,
  elevatedWalls,
  wallFoundationRays,
  knownBaselineLimitations: legacyBaseline,
  issues,
};
await mkdir(dirname(reportFile), { recursive: true });
await writeFile(reportFile, JSON.stringify(partial, null, 2) + '\n');
console.log(
  JSON.stringify({
    stage: 'pose-and-supports',
    approaches: approaches.length,
    issues: issues.length,
    report: reportFile,
  }),
);
const city = await cityTerrainAcceptance(
  world,
  published.manifest,
  grid,
  rules.targetGroundIds,
  controls,
  await loadServerWasm(),
);
const result = {
  ...partial,
  status: issues.length || city.status !== 'passed' ? 'failed' : 'passed',
  city,
};
await writeFile(reportFile, JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    status: result.status,
    supportIssues: issues,
    cityIssues: city.issues,
    report: reportFile,
  }),
);
if (result.status !== 'passed') process.exitCode = 1;
