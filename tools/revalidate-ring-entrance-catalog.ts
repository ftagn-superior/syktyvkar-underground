/** Carry historical entrance geometry only across an unchanged active population,
 * then require new runtime-pinned executions for the exact fresh publication. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import {
  canonicalJson,
  validateWorldLayoutSnapshot,
  loadWorldBundle,
  validateWorldManifest,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { readRevalidatedRingTerrainInputs } from './world-build/src/ring-terrain-revalidation.js';
import {
  readRingEntranceSupportOverrides,
  ringEntrancePopulationPoseDigest,
  validateRingEntranceCatalog,
  type RingEntranceCatalog,
} from './world-build/src/ring-entrance-authoring.js';

const args = process.argv.slice(2);
const accept = args.includes('--accept-reports');
if (accept) args.splice(args.indexOf('--accept-reports'), 1);
assert.ok(args.length <= 3 && args.every((arg) => !arg.startsWith('--')));
const worldDirectory = args[0] ?? 'output/ring-terrain-stage6/candidate/export-world';
const snapshotFile = args[1] ?? 'output/ring-terrain-stage6/candidate/target-static-snapshot.json';
const output = args[2] ?? 'output/ring-terrain-stage6/entrance-approaches';
const outside = (root: string) => {
  const path = relative(resolve(root), resolve(output));
  return path === '..' || path.startsWith('../') || isAbsolute(path);
};
assert.ok(
  outside('output/ring-terrain-stage5') && outside('content'),
  'Historical acceptance must remain immutable',
);
const historicalFile = 'content/worlds/ring-block/terrain-candidate/full-entrance-catalog.json';
const historicalSnapshotFile = 'output/ring-terrain-stage5/final/target-static-snapshot.json';
const read = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const pin = async (file: string) => ({
  file: relative(process.cwd(), file),
  sha256: hash(await readFile(file)),
});
const historical = validateRingEntranceCatalog(await read(historicalFile));
const before: WorldLayoutSnapshot = await read(historicalSnapshotFile);
const snapshot: WorldLayoutSnapshot = await read(snapshotFile);
validateWorldLayoutSnapshot(before);
validateWorldLayoutSnapshot(snapshot);
const manifest = validateWorldManifest(await read(join(worldDirectory, 'manifest.json')));
const world = await loadWorldBundle(manifest, async (file, expectedHash) => {
  const bytes = await readFile(join(worldDirectory, file));
  assert.equal(hash(bytes), expectedHash);
  return bytes;
});
assert.equal(snapshot.worldId, historical.worldId);
assert.equal(manifest.worldId, snapshot.worldId);
const priorOwners = new Map(before.instances.map((owner) => [owner.entityId, owner]));
const samePose = (
  a: WorldLayoutSnapshot['instances'][number],
  b: WorldLayoutSnapshot['instances'][number],
) =>
  a.assetId === b.assetId &&
  ['x', 'y', 'z'].every(
    (axis) =>
      Math.abs(a.position[axis as 'x' | 'y' | 'z'] - b.position[axis as 'x' | 'y' | 'z']) <= 1e-8,
  ) &&
  canonicalJson(a.rotation) === canonicalJson(b.rotation);
const published = new Map(world.buildings.map((owner) => [owner.entityId, owner]));
for (const owner of snapshot.instances) {
  const actual = published.get(owner.entityId);
  if (!owner.enabled) assert.ok(!actual, `Disabled owner is published: ${owner.entityId}`);
  else
    assert.ok(
      actual &&
        samePose(owner, { ...actual, enabled: true, instanceRevision: owner.instanceRevision }),
      `Snapshot differs from publication: ${owner.entityId}`,
    );
}
for (const owner of snapshot.instances.filter((o) => o.enabled)) {
  const previous = priorOwners.get(owner.entityId);
  assert.ok(
    previous?.enabled && samePose(previous, owner),
    `Active obstacle population changed: ${owner.entityId}; a new geometry screen is required`,
  );
}
const doorIds = new Set(
  [...historical.owners, ...historical.directTerrainDoors].map((owner) => owner.entityId),
);
for (const id of doorIds) {
  const owner = snapshot.instances.find((instance) => instance.entityId === id);
  assert.ok(
    owner?.enabled && samePose(priorOwners.get(id)!, owner),
    `Authored door owner changed: ${id}`,
  );
}
for (const evidence of [...historical.evidence, historical.overrideArtifact])
  assert.equal(
    hash(await readFile(evidence.file)),
    evidence.sha256,
    `Historical geometry evidence changed: ${evidence.file}`,
  );
const current = await readRevalidatedRingTerrainInputs();
await mkdir(output, { recursive: true });
const revalidationFile = join(output, 'geometry-revalidation.json');
const revalidation = {
  formatVersion: 1,
  status: 'historical-geometry-revalidated-for-subset-of-unchanged-active-owners',
  historicalCatalog: await pin(historicalFile),
  historicalSnapshot: await pin(historicalSnapshotFile),
  targetSnapshot: await pin(snapshotFile),
  mapVersion: manifest.mapVersion,
  population: snapshot.instances.length,
  enabled: snapshot.instances.filter((owner) => owner.enabled).length,
  doorOwners: doorIds.size,
  justification:
    'All active obstacle and door poses are unchanged; only removals/disabled additions differ. Historical no-contact geometry remains conservative. Physical acceptance is rerun for the fresh map and current runtime.',
  sourceGeometry: current.evidence,
};
await writeFile(revalidationFile, JSON.stringify(revalidation, null, 2) + '\n');
const catalog: RingEntranceCatalog = structuredClone(historical);
catalog.status = 'geometry-checked-authoring-candidate';
catalog.sourceWorldMapVersion = manifest.mapVersion;
catalog.sourcePlacementSnapshotSha256 = hash(await readFile(snapshotFile));
catalog.populationPoseSha256 = ringEntrancePopulationPoseDigest(snapshot);
catalog.sourcePins = await Promise.all(historical.sourcePins.map(({ file }) => pin(file)));
catalog.sourcePins.push(
  await pin('tools/world-build/src/ring-terrain-revalidation.ts'),
  await pin('tools/revalidate-ring-entrance-catalog.ts'),
);
catalog.evidence = [...historical.evidence, await pin(revalidationFile)];
catalog.physicalEvidence = [];
catalog.physicalRuntimePins = [];
delete catalog.physicalMapVersion;
catalog.gates.fullCityRepresentativePhysics = 'pending';
catalog.gates.directTerrainDoorVolumes = 'pending';
for (const door of catalog.directTerrainDoors) door.status = 'direct-terrain-volume-check-pending';
if (accept) {
  const files = ['full-city-entrance-probes.json', 'low-door-volumes.json'].map((name) =>
    join(output, name),
  );
  const reports = await Promise.all(files.map(read));
  for (const report of reports) {
    assert.equal(report.mapVersion, manifest.mapVersion, 'Fresh physical report map differs');
    assert.equal(report.status, 'passed');
    assert.equal(report.failures, 0);
  }
  assert.ok(reports[0].physicalRuntimePins?.length, 'Missing runtime baseline');
  assert.equal(
    canonicalJson(reports[0].physicalRuntimePins),
    canonicalJson(reports[1].physicalRuntimePins),
  );
  catalog.physicalRuntimePins = reports[0].physicalRuntimePins;
  catalog.physicalEvidence = await Promise.all(files.map(pin));
  catalog.physicalMapVersion = manifest.mapVersion;
  catalog.status = 'physics-checked-authoring-candidate';
  catalog.gates.fullCityRepresentativePhysics = 'passed';
  catalog.gates.directTerrainDoorVolumes = 'passed';
  for (const door of catalog.directTerrainDoors)
    door.status = 'full-city-volume-walk-sprint-checked';
}
const catalogFile = join(output, 'full-entrance-catalog.json');
const temporary = join(dirname(catalogFile), 'catalog.next.json');
try {
  await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n');
  const overrides = await readRingEntranceSupportOverrides(snapshot, {
    file: temporary,
    requirePhysicalAcceptance: accept,
  });
  await rename(temporary, catalogFile);
  console.log(
    JSON.stringify({
      status: catalog.status,
      catalogFile,
      mapVersion: manifest.mapVersion,
      rules: overrides.length,
      population: snapshot.instances.length,
      enabled: snapshot.instances.filter((owner) => owner.enabled).length,
      runtimePins: catalog.physicalRuntimePins?.length,
    }),
  );
} finally {
  await rm(temporary, { force: true });
}
