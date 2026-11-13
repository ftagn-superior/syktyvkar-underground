/** Isolated full-map publication authoring; never deploys or accesses the database. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, validateTerrainGrid } from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { validateFoundationSupportRule } from '../packages/terrain-build/src/private-data.js';
import { buildRingTerrainCandidate } from './world-build/src/ring-terrain-build.js';
import {
  readRingEntranceCatalog,
  readRingEntranceSupportOverrides,
  assertRingEntranceReleaseMatchesEvidence,
  RING_ENTRANCE_CATALOG_FILE,
  type RingEntranceCatalog,
} from './world-build/src/ring-entrance-authoring.js';

const args = process.argv.slice(2);
const packFlag = args.indexOf('--physics-packs');
const physicsPacks = packFlag >= 0;
if (physicsPacks) args.splice(packFlag, 1);
const entranceFlag = args.indexOf('--entrances');
const entrances = entranceFlag >= 0;
if (entrances) args.splice(entranceFlag, 1);
const strictFlag = args.indexOf('--require-physical-acceptance');
const requirePhysicalAcceptance = strictFlag >= 0;
if (requirePhysicalAcceptance) args.splice(strictFlag, 1);
assert.ok(
  args.length <= 2 &&
    args.every((arg) => !arg.startsWith('--')) &&
    !(entrances && args[1]) &&
    (!requirePhysicalAcceptance || entrances),
  'Usage: [output] [support-overrides.json | --entrances] [--physics-packs] [--require-physical-acceptance]',
);
const gridFile = 'content/worlds/ring-block/terrain-candidate/full-grid-ready.json';
const gridBytes = await readFile(gridFile);
const grid = validateTerrainGrid(JSON.parse(gridBytes.toString()));
const provenance = JSON.parse(
  await readFile(
    'content/worlds/ring-block/terrain-candidate/full-terrain-provenance.json',
    'utf8',
  ),
);
assert.equal(provenance.output.sha256, hash(gridBytes), 'Full terrain bytes changed');
assert.equal(provenance.gridSha256, hash(canonicalJson(grid)), 'Full terrain geometry changed');
assert.equal(provenance.status, 'support-geometry-candidate-ready');
for (const [file, digest] of Object.entries(provenance.inputs))
  assert.equal(hash(await readFile(file)), digest, `Stale full terrain input: ${file}`);
let supportOverrides = args[1]
  ? JSON.parse(await readFile(args[1], 'utf8')).map(validateFoundationSupportRule)
  : [];
let entranceCatalog: RingEntranceCatalog | undefined;
if (entrances) {
  const catalog = await readRingEntranceCatalog();
  entranceCatalog = catalog;
  const snapshotBytes = await readFile(
    'output/ring-terrain-stage5/intermediate/target-static-snapshot.json',
  );
  assert.equal(
    hash(snapshotBytes),
    catalog.sourcePlacementSnapshotSha256,
    'Entrance reference placements changed',
  );
  const sourceManifest = JSON.parse(
    await readFile('output/ring-terrain-stage5/intermediate/export-world/manifest.json', 'utf8'),
  );
  assert.equal(
    sourceManifest.mapVersion,
    catalog.sourceWorldMapVersion,
    'Entrance reference publication changed',
  );
  supportOverrides = await readRingEntranceSupportOverrides(JSON.parse(snapshotBytes.toString()), {
    requirePhysicalAcceptance,
  });
}
const output = args[0] ?? 'output/ring-terrain-stage5/intermediate';
const result = await buildRingTerrainCandidate({
  gridFile,
  output,
  landmarks: true,
  supportOverrides,
  physicsPacks,
  boundaryInsetMetres: 0.02,
});
let stamp: object | undefined;
if (requirePhysicalAcceptance && result.status === 'static-candidate-built') {
  // Source pins alone do not prove that today's compiler produced the physically checked map.
  assertRingEntranceReleaseMatchesEvidence(entranceCatalog!, result.mapVersion);
  stamp = {
    status: 'accepted-exact-map',
    mapVersion: result.mapVersion,
    catalogSha256: hash(await readFile(RING_ENTRANCE_CATALOG_FILE)),
    scope:
      'Exact publication matches the terrain-bound entrance physics evidence; network, migration and performance acceptance remain separate.',
  };
  await writeFile(
    join(output, 'physical-acceptance-stamp.json'),
    JSON.stringify(stamp, null, 2) + '\n',
  );
  const reportFile = join(output, 'build-report.json');
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  await writeFile(
    reportFile,
    JSON.stringify({ ...report, physicalAcceptance: stamp }, null, 2) + '\n',
  );
}
console.log(
  JSON.stringify({ ...result, ...(stamp ? { physicalAcceptance: stamp } : {}) }, null, 2),
);
if (result.status === 'blocked') process.exitCode = 1;
