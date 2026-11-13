/** Sequential hardware comparison of the proven flat reference and exact prepared pilot. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from '../packages/world-release/src/index.js';
import {
  validateWorldLayoutSnapshot,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import {
  prepareRingProfilePublication,
  readPreparedRingProfilePublication,
} from './helpers/ring-terrain-profile.js';

const output = resolve(
  process.env.SU_RING_STAGE4_PROFILE_OUTPUT ?? 'output/ring-terrain-stage4/hardware-profile',
);
const source = resolve('output/ring-terrain-stage0/source-world');
const flatDirectory = resolve('output/ring-terrain-stage2/flat-4m');
const authoringDirectory = resolve('output/ring-terrain-stage4/authoring-world');
const pilotDirectory = resolve('output/ring-terrain-stage4/export-world');
const layoutFile = resolve('data/map-layout.json');
const layoutBytes = await readFile(layoutFile);
assert.equal(hash(layoutBytes), 'f4419053c7b40d2f6262a05a690ede725e4c879938e8806f8b85e918d4bad193');
const snapshot = JSON.parse(layoutBytes.toString()) as WorldLayoutSnapshot;
validateWorldLayoutSnapshot(snapshot);
const preparation = JSON.parse(
  await readFile('output/ring-terrain-stage4/static-preflight.json', 'utf8'),
);
assert.deepEqual(preparation.issues, []);
const targetSnapshot = preparation.targetSnapshot as WorldLayoutSnapshot;
validateWorldLayoutSnapshot(targetSnapshot);
await mkdir(output, { recursive: true });
const targetSnapshotFile = join(output, 'prepared-snapshot.json');
await writeFile(targetSnapshotFile, JSON.stringify(targetSnapshot) + '\n');
const scripts: { sourcePath: string; archivePath: string; sha256: string }[] = [];
for (const [sourcePath, archiveName] of [
  ['tests/ring-terrain-baseline.ts', 'measured-benchmark.ts'],
  ['tests/helpers/ring-terrain-profile.ts', 'measured-profile-fixture.ts'],
  ['tests/ring-terrain-stage4-profile.ts', 'measured-profile-runner.ts'],
]) {
  const bytes = await readFile(sourcePath);
  const archivePath = join(output, archiveName);
  await writeFile(archivePath, bytes);
  scripts.push({ sourcePath, archivePath, sha256: hash(bytes) });
}
async function verifyScripts() {
  for (const script of scripts) {
    assert.equal(
      hash(await readFile(script.sourcePath)),
      script.sha256,
      `Profile source changed: ${script.sourcePath}`,
    );
    assert.equal(
      hash(await readFile(script.archivePath)),
      script.sha256,
      `Archived profile source changed: ${script.archivePath}`,
    );
  }
}
const flat = await prepareRingProfilePublication(source, snapshot, flatDirectory);
const pilot = await readPreparedRingProfilePublication(
  source,
  snapshot,
  authoringDirectory,
  targetSnapshot,
  pilotDirectory,
);
assert.equal(flat.profileFixture.kind, 'flat-4m');
assert.equal(flat.terrainGrid!.spacing, 4);
assert.equal(pilot.terrainGrid.spacing, 4);
assert.deepEqual(flat.publication.manifest.grid, pilot.publication.manifest.grid);
assert.deepEqual(flat.world.simulation, pilot.world.simulation);
assert.deepEqual(
  { x: flat.world.spawnPoints[0].x, z: flat.world.spawnPoints[0].z },
  { x: pilot.world.spawnPoints[0].x, z: pilot.world.spawnPoints[0].z },
  'The neutral local controller must use the same XZ',
);
const variants = [
  { kind: 'flat-4m', prepared: flat, directory: flatDirectory },
  { kind: 'terrain-pilot', prepared: pilot, directory: pilotDirectory },
];
const preflight: { kind: string; gridFile: string; mapVersion: string; profileFixture: unknown }[] =
  [];
for (const variant of variants) {
  const gridFile = join(output, variant.kind + '-grid.json');
  await writeFile(gridFile, JSON.stringify(variant.prepared.terrainGrid) + '\n');
  preflight.push({
    kind: variant.kind,
    gridFile,
    mapVersion: variant.prepared.publication.manifest.mapVersion,
    profileFixture: variant.prepared.profileFixture,
  });
}
await writeFile(join(output, 'preflight.json'), JSON.stringify(preflight, null, 2) + '\n');
const reports: any[] = [];
for (const variant of variants) {
  await verifyScripts();
  const directory = join(output, variant.kind);
  const proof = preflight.find((entry) => entry.kind === variant.kind)!;
  console.log(JSON.stringify({ phase: 'variant-start', kind: variant.kind, output: directory }));
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/ring-terrain-baseline.ts'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        SU_RING_BASELINE_LAYOUT: layoutFile,
        SU_RING_BASELINE_OUTPUT: directory,
        SU_RING_BASELINE_SOURCE_RELEASE: source,
        SU_RING_BASELINE_CANDIDATE_RELEASE: variant.kind === 'flat-4m' ? flatDirectory : '',
        SU_RING_BASELINE_PREPARED_AUTHORING:
          variant.kind === 'terrain-pilot' ? authoringDirectory : '',
        SU_RING_BASELINE_PREPARED_PUBLICATION:
          variant.kind === 'terrain-pilot' ? pilotDirectory : '',
        SU_RING_BASELINE_PREPARED_SNAPSHOT:
          variant.kind === 'terrain-pilot' ? targetSnapshotFile : '',
        SU_RING_BASELINE_TERRAIN_GRID: proof.gridFile,
        SU_RING_BASELINE_WARMUP_MS: '60000',
        SU_RING_BASELINE_SAMPLE_MS: '60000',
      },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${variant.kind} hardware profile failed: ${signal ?? code}`)),
    );
  });
  const report = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert.equal(report.status, 'measured');
  assert.equal(report.mapVersion, proof.mapVersion);
  assert.equal(report.profileFixture.kind, variant.kind);
  assert.equal(report.profileFixture.enabledInstances, 3709);
  assert.equal(report.layoutSha256, hash(layoutBytes));
  assert.equal(report.focusHeight.kind, 'terrain-grid');
  assert.ok(Object.values(report.unchanged).every((value) => value === true));
  assert.equal(report.benchmarkSha256, scripts[0].sha256);
  assert.equal(report.profileFixtureSha256, scripts[1].sha256);
  reports.push(report);
}
const baseline = reports[0];
for (const key of [
  'host',
  'browser',
  'viewport',
  'quality',
  'fixedHour',
  'route',
  'warmupMs',
  'sampleMs',
  'benchmarkSha256',
  'profileFixtureSha256',
  'layoutSha256',
  'layoutRevision',
])
  assert.deepEqual(reports[1][key], baseline[key], `Incomparable hardware conditions: ${key}`);
assert.deepEqual(reports[1].initial.rendering.renderer, baseline.initial.rendering.renderer);
assert.deepEqual(reports[1].profileFixture.source, baseline.profileFixture.source);
assert.equal(
  reports[1].profileFixture.originalInstancesSha256,
  baseline.profileFixture.instancesSha256,
);
const maximum = (values: number[]) => values.reduce((a, b) => Math.max(a, b), 0);
const relativeLimit = (reference: number) => Math.max(1.2 * reference, reference + 1);
const measured = reports.map((report) => ({
  kind: report.profileFixture.kind,
  mapVersion: report.mapVersion,
  assetReleaseVersion: report.assetReleaseVersion,
  world: report.world,
  profileFixture: report.profileFixture,
  focusHeight: report.focusHeight,
  phases: report.phases.map((phase: any, index: number) => {
    const reference = baseline.phases[index];
    assert.equal(phase.kind, reference.kind);
    const frameP95LimitMs = relativeLimit(reference.summary.frameMs.p95);
    const physicsP95LimitMs = relativeLimit(reference.summary.physicsStepMs.p95);
    const states = [phase.before, ...phase.diagnostics, phase.after];
    return {
      ...phase.summary,
      maxima: {
        bodies: maximum(states.map((s) => s.physics.bodies)),
        meshes: maximum(states.map((s) => s.rendering.meshes)),
        activeTriangles: maximum(states.map((s) => s.activeIndices / 3)),
        jsHeapUsedBytes: maximum(states.map((s) => s.jsHeap?.usedJSHeapSize ?? 0)),
        wasmReservedBytes: maximum(states.map((s) => s.wasmReservedBytes)),
        resourceCacheBytes: maximum(states.map((s) => s.resources.cacheBytes)),
        graphicsCells: maximum(states.map((s) => s.streaming.graphicsActive.length)),
        physicsCells: maximum(states.map((s) => s.streaming.physicsActive.length)),
      },
      relativeGates: {
        frameP95LimitMs,
        physicsP95LimitMs,
        framePassed: phase.summary.frameMs.p95 <= frameP95LimitMs,
        physicsPassed: phase.summary.physicsStepMs.p95 <= physicsP95LimitMs,
      },
    };
  }),
  gates: report.gates,
}));
await verifyScripts();
assert.equal(hash(await readFile(layoutFile)), hash(layoutBytes));
const comparison = {
  date: new Date().toISOString(),
  status: 'measured',
  scope: baseline.scope,
  host: baseline.host,
  browser: baseline.browser,
  renderer: baseline.initial.rendering.renderer,
  viewport: baseline.viewport,
  quality: baseline.quality,
  fixedHour: baseline.fixedHour,
  warmupMs: baseline.warmupMs,
  sampleMs: baseline.sampleMs,
  route: baseline.route,
  focusHeight:
    'Each variant samples its own verified terrain grid continuously at identical route XZ',
  layoutSha256: hash(layoutBytes),
  layoutRevision: snapshot.revision,
  scripts,
  strictFrameP95BudgetMs: 16.7,
  relativeBudget:
    'max(1.2 * flat-4m p95, flat-4m p95 + 1 ms), separately for frame and local physics',
  pilotGates: {
    strictFrameP95Passed: measured[1].phases.every((phase: any) => phase.p95Within16_7Ms),
    relativeFrameP95Passed: measured[1].phases.every(
      (phase: any) => phase.relativeGates.framePassed,
    ),
    relativePhysicsP95Passed: measured[1].phases.every(
      (phase: any) => phase.relativeGates.physicsPassed,
    ),
  },
  fullGameplayAcceptance: { assessed: false, passed: false },
  variants: measured,
};
await writeFile(join(output, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
console.log(
  JSON.stringify({
    status: comparison.status,
    pilotGates: comparison.pilotGates,
    report: join(output, 'comparison.json'),
  }),
);
