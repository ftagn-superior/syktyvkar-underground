import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import {
  sampleTerrain,
  terrainNormal,
  validateWorld,
  validateTerrainGrid,
  type BuildingInstance,
  type Vec3,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import {
  generateSupportAssets,
  planSupportPlacement,
} from '../packages/terrain-build/src/supports.js';
import { generateTerrainTile } from '../packages/terrain-build/src/terrain.js';
import { compileGeneratedAsset } from '../packages/terrain-build/src/assets.js';
import type { FoundationSupportRuleV2 } from '../packages/terrain-build/src/private-data.js';
import { readRingModelSupportCatalog } from './world-build/src/ring-support-authoring.js';
import { readRingTerrainPilotWithPads } from './world-build/src/ring-pads.js';
import { generateFootprint } from './world-build/src/city.js';
import { createPhysicsWorld } from '../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';

type Candidate = {
  entityId: string;
  assetId: string;
  status: string;
  fixedOwnerY: number;
  door: { partId: string; index: number; thresholdHeightMetres: number };
  approach: NonNullable<FoundationSupportRuleV2['approaches']>[number];
  approachConflicts?: unknown[];
};
const directory = 'output/ring-terrain-stage4/entrance-approaches';
const gridPath = process.argv[2];
const snapshotPath = process.argv[3] ?? 'data/map-layout.json';
const preliminaryPath = process.argv[4] ?? `${directory}/preliminary.json`;
const outputPath = process.argv[5] ?? `${directory}/actual-geometry.json`;
const preliminary = JSON.parse(await readFile(preliminaryPath, 'utf8'));
const studyPath = 'content/worlds/ring-block/terrain-candidate/entrance-authoring-study.json';
const study = JSON.parse(await readFile(studyPath, 'utf8'));
const [grid, catalog] = await Promise.all([
  gridPath
    ? readFile(gridPath, 'utf8').then((text) => validateTerrainGrid(JSON.parse(text)))
    : readRingTerrainPilotWithPads(),
  readRingModelSupportCatalog(),
]);
const loaded = JSON.parse(await readFile(snapshotPath, 'utf8'));
const snapshot: WorldLayoutSnapshot = loaded.targetSnapshot ?? loaded;
const sourceWorld = JSON.parse(await readFile('content/worlds/ring-block/world.json', 'utf8'));
const results = [];

async function probe(
  candidate: Candidate,
  owner: BuildingInstance,
  rule: FoundationSupportRuleV2,
  supports: ReturnType<typeof generateSupportAssets>,
) {
  const a = candidate.approach;
  const middle = {
    x: owner.position.x + (a.edge[0][0] + a.edge[1][0]) / 2,
    z: owner.position.z + (a.edge[0][1] + a.edge[1][1]) / 2,
  };
  const at = (distance: number) => ({
    x: middle.x + a.outward[0] * distance,
    z: middle.z + a.outward[1] * distance,
  });
  const near = at(0.7),
    far = at(a.length + 0.7);
  const x0 = Math.max(grid.origin.x, Math.floor(Math.min(near.x, far.x) / 4) * 4 - 12);
  const z0 = Math.max(grid.origin.z, Math.floor(Math.min(near.z, far.z) / 4) * 4 - 12);
  const x1 = Math.min(
    grid.origin.x + (grid.columns - 1) * 4,
    Math.ceil(Math.max(near.x, far.x) / 4) * 4 + 12,
  );
  const z1 = Math.min(
    grid.origin.z + (grid.rows - 1) * 4,
    Math.ceil(Math.max(near.z, far.z) / 4) * 4 + 12,
  );
  const terrain = generateTerrainTile(
    'entrance-probe-ground',
    grid,
    [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ],
    [],
  );
  const model = catalog.models.find((m) => m.assetId === owner.assetId)!;
  const generated = generateFootprint(
    owner.assetId,
    JSON.parse(await readFile(model.source.recipeFile, 'utf8')),
  );
  const standalone = [terrain.physics, ...supports.map((s) => s.asset.physics)];
  const world = validateWorld({
    ...sourceWorld,
    entities: [],
    initialItems: [],
    itemCatalog: { version: '1', types: {} },
    buildingAssets: Object.fromEntries(
      [generated.physics, ...standalone].map((asset) => [asset.assetId, asset]),
    ),
    buildings: [
      owner,
      ...standalone.map((asset) => ({
        entityId: asset.assetId,
        assetId: asset.assetId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      })),
    ],
  });
  const physics = await createPhysicsWorld(world, await loadServerWasm(), false);
  const walks = [];
  try {
    for (const sprint of [false, true]) {
      const actor = physics.createCharacter('entrance-probe', {
        ...far,
        y: sampleTerrain(grid, far.x, far.z)!.height + 0.92,
      });
      for (let tick = 0; tick < 60; tick++) physics.advance(1 / 60);
      const milestones = [];
      for (const target of [near, far]) {
        let reached = false,
          tick = 0;
        for (; tick < 3000; tick++) {
          const state = physics.state('entrance-probe');
          const dx = target.x - state.position.x,
            dz = target.z - state.position.z,
            distance = Math.hypot(dx, dz);
          if (distance < 0.28) {
            reached = true;
            break;
          }
          actor.input = { moveX: dx / distance, moveZ: dz / distance, sprint };
          physics.advance(1 / 60);
        }
        assert.ok(
          reached,
          `Approach did not reach ${JSON.stringify({ candidate: candidate.entityId, target, state: physics.state('entrance-probe') })}`,
        );
        actor.input = { moveX: 0, moveZ: 0 };
        for (let rest = 0; rest < 90; rest++) physics.advance(1 / 60);
        const state = physics.state('entrance-probe');
        assert.ok(state.grounded);
        milestones.push({ target, ticks: tick, state });
      }
      walks.push({ sprint, milestones });
      physics.removeCharacter('entrance-probe');
    }
    return {
      scope:
        'Isolated Node Havok with actual building, structural foundation, approach and terrain. Final neighbouring kit placements and full-city clearance are not included.',
      fixedOwnerY: owner.position.y,
      approachTargetY: owner.position.y + rule.approaches![0].targetY,
      walks,
    };
  } finally {
    physics.dispose();
  }
}

for (const candidate of preliminary.doors.filter(
  (c: Candidate) => c.status === 'candidate-for-actual-geometry',
) as Candidate[]) {
  const saved = snapshot.instances.find((o) => o.entityId === candidate.entityId)!;
  const owner = { ...saved, position: { ...saved.position, y: candidate.fixedOwnerY } };
  const baseRule = catalog.rules.find((r) => r.assetId === candidate.assetId)!;
  const rule = { ...baseRule, ownerId: owner.entityId, approaches: [candidate.approach] };
  try {
    const plan = planSupportPlacement(grid, rule, owner);
    assert.ok(
      plan.minimumY <= owner.position.y + 1e-8,
      `Approach requires owner raise ${plan.minimumY - owner.position.y}`,
    );
    const supports = generateSupportAssets(grid, rule, owner, {
      foundation: 'entrance-probe-foundation',
      approaches: { [candidate.approach.id]: 'entrance-probe-ramp' },
    });
    const ramp = supports.find((s) => s.role !== 'foundation')!.asset;
    const compiled = compileGeneratedAsset('entrance-probe-ramp', ramp);
    let maxSlope = 0,
      triangles = 0;
    for (const collider of ramp.physics.colliders) {
      assert.equal(collider.kind, 'mesh');
      if (collider.kind !== 'mesh') continue;
      for (let index = 0; index < collider.indices.length; index += 3) {
        const points = collider.indices.slice(index, index + 3).map((i) => ({
          x: collider.vertices[i * 3],
          y: collider.vertices[i * 3 + 1],
          z: collider.vertices[i * 3 + 2],
        })) as [Vec3, Vec3, Vec3];
        const normal = terrainNormal(points);
        if (normal.y <= 1e-8) continue;
        maxSlope = Math.max(
          maxSlope,
          (Math.atan2(Math.hypot(normal.x, normal.z), normal.y) * 180) / Math.PI,
        );
        triangles++;
      }
    }
    const result: { [key: string]: unknown } = {
      entityId: candidate.entityId,
      door: candidate.door,
      approach: candidate.approach,
      fixedOwnerY: owner.position.y,
      maximumEmittedSlopeDegrees: maxSlope,
      maximumAllowedSlopeDegrees: study.maximumActualSlopeDegrees?.[candidate.entityId] ?? 8,
      topTriangles: triangles,
      modelBytes: compiled.model?.byteLength,
      status:
        maxSlope <= (study.maximumActualSlopeDegrees?.[candidate.entityId] ?? 8) &&
        (!candidate.approachConflicts?.length ||
          study.keepStraightAfterCoordinatedReplacement?.includes(candidate.entityId))
          ? 'geometry-candidate-needs-final-clearance'
          : 'geometry-needs-revision',
      approachConflicts: candidate.approachConflicts ?? [],
      coordinatedConflictsRequireFinalScreen: Boolean(
        candidate.approachConflicts?.length &&
        study.keepStraightAfterCoordinatedReplacement?.includes(candidate.entityId),
      ),
    };
    if (
      (candidate.entityId === 'osm-way-109234383' && candidate.door.index === 1) ||
      candidate.entityId === 'osm-way-92104661'
    )
      result.isolatedPhysics = await probe(candidate, owner, rule, supports);
    results.push(result);
  } catch (error) {
    results.push({
      entityId: candidate.entityId,
      door: candidate.door,
      status: 'rejected-actual-generator',
      error: String(error),
    });
  }
}
const summary = {
  checked: results.length,
  geometryCandidates: results.filter((r) => r.status === 'geometry-candidate-needs-final-clearance')
    .length,
  revisions: results.filter((r) => r.status === 'geometry-needs-revision').length,
  rejected: results.filter((r) => r.status === 'rejected-actual-generator').length,
  isolatedPhysics: results.filter((r) => 'isolatedPhysics' in r && r.isolatedPhysics).length,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  JSON.stringify(
    {
      formatVersion: 1,
      status: 'unapplied-actual-geometry-probes',
      inputs: await Promise.all(
        [
          gridPath ?? 'content/worlds/ring-block/terrain-candidate/pilot-grid-with-pads.json',
          snapshotPath,
          preliminaryPath,
        ].map(async (path) => ({
          path,
          sha256: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        })),
      ),
      summary,
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(summary));
