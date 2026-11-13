/** Stage 3: actual saved city and pilot model, explicit offline placement only. */
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson, type WorldLayoutSnapshot } from '../packages/contracts/src/index.js';
import {
  hash,
  jsonBytes,
  writeAuthoringMetadata,
  writeWorldPublication,
} from '../packages/world-release/src/index.js';
import { planSupportPlacement } from '../packages/terrain-build/src/supports.js';
import { readPilotSupportRule } from '../tools/world-build/src/pilot-support.js';
import {
  createLayoutPublication,
  readAuthoringRelease,
  terrainSupportId,
  editableStaticAssetIds,
} from '../apps/server/src/layout/release.js';
import { prepareRingProfilePublication } from './helpers/ring-terrain-profile.js';
import { createPhysicsWorld } from '../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';

const output = resolve(process.argv[2] ?? 'output/ring-terrain-stage3');
const flatDirectory = resolve('output/ring-terrain-stage2/flat-4m');
const bytes = await readFile('data/map-layout.json');
assert.equal(hash(bytes), 'f4419053c7b40d2f6262a05a690ede725e4c879938e8806f8b85e918d4bad193');
const snapshot: WorldLayoutSnapshot = JSON.parse(bytes.toString());
await prepareRingProfilePublication(
  'output/ring-terrain-stage0/source-world',
  snapshot,
  flatDirectory,
);
const flat = await readAuthoringRelease(flatDirectory);
const rule = await readPilotSupportRule();
const owner = snapshot.instances.find((instance) => instance.entityId === 'osm-way-1258973447')!;
assert.ok(owner && owner.enabled);
assert.deepEqual(owner.rotation, { x: 0, y: 0, z: 0, w: 1 });
const supportPlan = planSupportPlacement(flat.terrain!.grid, rule, owner);
await mkdir(output, { recursive: true });
const sourceDirectory = join(output, 'source-world');
await cp(flatDirectory, sourceDirectory, { recursive: true });
await writeAuthoringMetadata(
  flat.definition,
  flat.manifest,
  flat.metadata.fixedInstanceIds,
  sourceDirectory,
  jsonBytes({
    ...flat.terrain,
    formatVersion: 2,
    generatorVersion: 'terrain-build/2',
    supports: [rule],
  }),
);
const release = await readAuthoringRelease(sourceDirectory);
const rebound = { ...snapshot, assetReleaseVersion: release.metadata.assetReleaseVersion };
await assert.rejects(createLayoutPublication(release, rebound), /height|minimum|low|pose/i);
// A deliberate stand fixture, never a rewrite of the saved export or an implicit migration.
const accepted = structuredClone(rebound);
const changed = accepted.instances.find((instance) => instance.entityId === owner.entityId)!;
changed.position.y = Math.max(supportPlan.minimumY, 0.6);
const built = await createLayoutPublication(release, accepted);
const worldDirectory = join(output, 'export-world');
await writeWorldPublication(built.publication, worldDirectory);
assert.deepEqual(editableStaticAssetIds(release), editableStaticAssetIds(flat));
assert.equal(canonicalJson(release.seed), canonicalJson(flat.seed));
assert.equal(hash(await readFile('data/map-layout.json')), hash(bytes));
const roles = ['foundation', ...(rule.approaches ?? []).map((a) => `approach:${a.id}`)];
const derived = roles.map((role) =>
  terrainSupportId(release.definition.worldId, owner.entityId, role),
);
assert.equal(
  built.world.buildings.length,
  flat.metadata.fixedInstanceIds.length + 3709 + derived.length,
);
const foundation = built.world.buildingAssets[derived[0]];
assert.ok(foundation && foundation.colliders.every((collider) => collider.kind === 'mesh'));
const physics = await createPhysicsWorld(
  { ...built.world, initialItems: [] },
  await loadServerWasm(),
  false,
);
const approaches = [];
try {
  for (const approach of rule.approaches ?? []) {
    const edgeCenter = {
      x: owner.position.x + (approach.edge[0][0] + approach.edge[1][0]) / 2,
      z: owner.position.z + (approach.edge[0][1] + approach.edge[1][1]) / 2,
    };
    const [nx, nz] = approach.outward;
    let maximumRayError = 0;
    for (const t of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const x = edgeCenter.x + nx * approach.length * t;
      const z = edgeCenter.z + nz * approach.length * t;
      const y = (changed.position.y + approach.targetY) * (1 - t);
      const ray = physics.surfaceRay({ x, y: 3, z }, { x, y: -2, z });
      assert.ok(ray, `Missing approach ${approach.id}/${t}`);
      maximumRayError = Math.max(maximumRayError, Math.abs(ray.point.y - y));
    }
    assert.ok(maximumRayError < 0.01, `Approach ray error ${maximumRayError}`);
    const routes = [];
    for (const sprint of [false, true]) {
      const start = {
        x: edgeCenter.x + nx * (approach.length + 0.5),
        y: 0.92,
        z: edgeCenter.z + nz * (approach.length + 0.5),
      };
      const actor = physics.createCharacter('support-route', start);
      actor.input = { moveX: -nx, moveZ: -nz, sprint };
      let reached = false;
      for (let tick = 0; tick < 900; tick++) {
        physics.advance(1 / 60);
        const state = physics.state('support-route');
        if (Math.hypot(state.position.x - edgeCenter.x, state.position.z - edgeCenter.z) <= 0.7) {
          reached = true;
          break;
        }
      }
      const end = physics.state('support-route');
      assert.ok(reached && end.grounded, `Approach route ${approach.id}: ${JSON.stringify(end)}`);
      actor.input = { moveX: 0, moveZ: 0, sprint: false };
      const stopped = { ...end.position };
      for (let tick = 0; tick < 120; tick++) physics.advance(1 / 60);
      const rest = physics.state('support-route');
      assert.ok(Math.hypot(rest.position.x - stopped.x, rest.position.z - stopped.z) < 0.02);
      actor.input = { moveX: nx, moveZ: nz, sprint };
      for (let tick = 0; tick < 900; tick++) {
        physics.advance(1 / 60);
        const p = physics.state('support-route').position;
        if ((p.x - edgeCenter.x) * nx + (p.z - edgeCenter.z) * nz >= approach.length + 0.3) break;
      }
      const returned = physics.state('support-route');
      assert.ok(
        (returned.position.x - edgeCenter.x) * nx + (returned.position.z - edgeCenter.z) * nz >=
          approach.length + 0.3,
      );
      routes.push({
        sprint,
        stopped,
        returned: { ...returned.position },
        grounded: returned.grounded,
      });
      physics.removeCharacter('support-route');
    }
    approaches.push({ id: approach.id, maximumRayError, routes, threshold: edgeCenter });
  }
} finally {
  physics.dispose();
}
const report = {
  status: 'passed',
  sourceExportSha256: hash(bytes),
  sourceRevision: snapshot.revision,
  sourceAssetReleaseVersion: snapshot.assetReleaseVersion,
  targetAssetReleaseVersion: release.metadata.assetReleaseVersion,
  mapVersion: built.publication.manifest.mapVersion,
  layoutHash: built.hash,
  enabledSavedOwners: 3709,
  supportPlan,
  explicitOfflinePoseChanges: [
    {
      entityId: owner.entityId,
      before: owner.position,
      after: changed.position,
      reason: 'Stage 3 foundation and entrance stand on the flat city; not a migration plan',
    },
  ],
  derived: derived.map((assetId) => ({
    assetId,
    bounds: built.world.buildingAssets[assetId].bounds,
    version: built.publication.manifest.assets[assetId].version,
  })),
  approaches,
  unchangedOriginalSnapshot: true,
  unchangedEditableCatalog: true,
  unchangedSeed: true,
  databaseAccess: false,
  fullGameplayAcceptance: false,
};
await writeFile(join(output, 'acceptance-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
