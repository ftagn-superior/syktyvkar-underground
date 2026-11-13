import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  RING_TERRAIN_CANDIDATE_DIRECTORY as directory,
  RING_TERRAIN_SOURCE_SHA256,
  RING_TERRAIN_PILOT_TRANSITION,
  assertRingPilotCorePreserved,
  generateRingTerrainCandidate,
  readDiagnosticSourceGrid,
  ringTerrainGridStatistics,
} from './world-build/src/ring-terrain-candidate.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

// The pinned 2 m input is committed. Reproduction never needs ignored output/ or a network.
// node --import tsx tools/build-ring-terrain-candidate.ts [--check]
const check = process.argv.includes('--check');
assert.ok(
  process.argv.slice(2).every((arg) => arg === '--check'),
  'Only --check is supported',
);
const sourceFile = `${directory}/source-grid-2m.json`;
const sourceBytes = await readFile(sourceFile);
assert.equal(hash(sourceBytes), RING_TERRAIN_SOURCE_SHA256, 'Unreviewed approximate source grid');
const source = readDiagnosticSourceGrid(JSON.parse(sourceBytes.toString()));
const full = generateRingTerrainCandidate(source, 'full');
const pilot = generateRingTerrainCandidate(source, 'pilot');
const core = assertRingPilotCorePreserved(full, pilot);
const stage0File = 'reports/ring-terrain-stage0-evidence.json';
const groundFile = 'reports/ring-terrain-ground-evidence.json';
const stage0Bytes = await readFile(stage0File);
const groundBytes = await readFile(groundFile);
const stage0 = JSON.parse(stage0Bytes.toString());
const ground = JSON.parse(groundBytes.toString());
const generated = new Map<string, string>();
for (const [variant, grid] of [
  ['full', full],
  ['pilot', pilot],
] as const)
  generated.set(`${variant}-grid-4m.json`, JSON.stringify(grid) + '\n');
const files = [
  'tools/build-ring-terrain-candidate.ts',
  'tools/world-build/src/ring-terrain-candidate.ts',
  'packages/contracts/src/terrain.ts',
  'tools/estimate-ring-ground.py',
];
const provenance = {
  formatVersion: 1,
  status: 'unapplied-approximate-gameplay-candidate',
  acceptance:
    'Approximation permitted; geometric, state-migration and gameplay acceptance remain separate.',
  source: {
    file: 'source-grid-2m.json',
    sha256: hash(sourceBytes),
    originalPath: 'output/ring-terrain-stage0/ground-candidate-grid.json',
    originalStatus: 'diagnostic_candidate_not_approved_terrain',
    dataset: stage0.arcticdem.source,
    georeference: stage0.arcticdem.georeference,
    verticalReference: ground.groundEstimate.verticalReference,
    originalRasterInputs: stage0.arcticdem.assets,
    groundReconstruction: {
      method: ground.groundEstimate.method,
      parameters: ground.groundEstimate.parameters,
      inputs: ground.groundEstimate.inputs,
      candidateSampleCount: ground.groundEstimate.candidateSampleCount,
      anchorCount: ground.groundEstimate.anchorCount,
      limitations: ground.groundEstimate.limitations,
    },
    attribution: {
      provider:
        'Polar Geospatial Center, University of Minnesota; original imagery credited by the dataset',
      datasetDoi: 'https://doi.org/10.7910/DVN/3VDC4W',
      license: 'https://creativecommons.org/licenses/by/4.0/',
      changes:
        'Ground reconstruction, local coordinates and zero Y, 4 m resampling; pilot-only smoothstep transition to zero.',
    },
  },
  evidence: {
    [stage0File]: hash(stage0Bytes),
    [groundFile]: hash(groundBytes),
  },
  generator: {
    files: Object.fromEntries(
      await Promise.all(files.map(async (file) => [file, hash(await readFile(file))])),
    ),
    resampling:
      'Sample the contracts NW-SE triangle surface at 4 m nodes; nodes coincide with the pinned 2 m lattice. No extra smoothing, height clipping or geographic displacement.',
    transition: RING_TERRAIN_PILOT_TRANSITION,
    formula: '(1-smoothstep((x-3)/197))*smoothstep((z+481)/200)*(1-smoothstep((z+37)/168))',
    alignment:
      'Plateau expanded to outer adjacent 4 m nodes, preserving every triangle that intersects the original core. Western boundary is not flattened. X=200 zero-weight coordinate lies between nodes; the last changed triangle ends at X=201.',
    plannedHeightRangeY: [-1, 15],
    rangeAction: 'Diagnostic expectation only; values are never clipped.',
  },
  outputs: Object.fromEntries(
    [...generated].map(([file, bytes]) => [
      file,
      { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) },
    ]),
  ),
  diagnostics: {
    source2m: ringTerrainGridStatistics(source),
    full4m: ringTerrainGridStatistics(full),
    pilot4m: ringTerrainGridStatistics(pilot),
    corePreservation: core,
    boundaryRequirement:
      'West boundary obstacles must follow the new terrain. Existing flat boundary obstacles are insufficient; activation is not performed by this authoring tool.',
  },
};
generated.set('provenance.json', JSON.stringify(provenance, null, 2) + '\n');
await mkdir(directory, { recursive: true });
for (const [file, bytes] of generated) {
  const path = `${directory}/${file}`;
  if (check) assert.equal(await readFile(path, 'utf8'), bytes, `${path} is stale`);
  else await writeFile(path, bytes);
}
console.log(
  JSON.stringify({
    check,
    directory,
    full: provenance.diagnostics.full4m,
    pilot: provenance.diagnostics.pilot4m,
    core,
  }),
);
