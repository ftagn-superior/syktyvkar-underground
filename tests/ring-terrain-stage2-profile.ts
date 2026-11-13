/** Sequential hardware comparison; consumes prepared releases, never builds or opens a database. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from '../packages/world-release/src/index.js';
import { validateWorldLayoutSnapshot } from '../packages/contracts/src/index.js';
import { prepareRingProfilePublication } from './helpers/ring-terrain-profile.js';

const output = resolve(
  process.env.SU_RING_STAGE2_PROFILE_OUTPUT ?? 'output/ring-terrain-stage2/hardware-profile',
);
const required = (name: string) => {
  assert.ok(process.env[name], `${name} must identify an already prepared release`);
  return resolve(process.env[name]!);
};
const source = required('SU_RING_BASELINE_SOURCE_RELEASE');
const candidates = [
  { kind: 'legacy', directory: undefined },
  { kind: 'flat-2m', directory: required('SU_RING_STAGE2_FLAT_2M_RELEASE') },
  { kind: 'flat-4m', directory: required('SU_RING_STAGE2_FLAT_4M_RELEASE') },
];
const layoutFile = resolve(process.env.SU_RING_BASELINE_LAYOUT ?? 'data/map-layout.json');
const exportBytes = await readFile(layoutFile);
assert.equal(
  hash(exportBytes),
  'f4419053c7b40d2f6262a05a690ede725e4c879938e8806f8b85e918d4bad193',
  'Stage 2 comparison must use the accepted revision 5214 export bytes',
);
const snapshot = JSON.parse(exportBytes.toString());
validateWorldLayoutSnapshot(snapshot);
assert.equal(snapshot.revision, 5214);
assert.equal(snapshot.instances.length, 3709);
assert.ok(snapshot.instances.every((instance) => instance.enabled));
await mkdir(output, { recursive: true });
const scripts: { sourcePath: string; archivePath: string; sha256: string }[] = [];
for (const [sourcePath, archivedName] of [
  ['tests/ring-terrain-baseline.ts', 'measured-benchmark.ts'],
  ['tests/helpers/ring-terrain-profile.ts', 'measured-profile-fixture.ts'],
  ['tests/ring-terrain-stage2-profile.ts', 'measured-profile-runner.ts'],
]) {
  const bytes = await readFile(sourcePath);
  const archivePath = join(output, archivedName);
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
const preflight = [];
for (const candidate of candidates) {
  const prepared = await prepareRingProfilePublication(source, snapshot, candidate.directory);
  assert.equal(prepared.profileFixture.kind, candidate.kind);
  preflight.push({
    kind: candidate.kind,
    mapVersion: prepared.publication.manifest.mapVersion,
    profileFixture: prepared.profileFixture,
  });
}
await writeFile(join(output, 'preflight.json'), JSON.stringify(preflight, null, 2) + '\n');

const reports: any[] = [];
for (const candidate of candidates) {
  await verifyScripts();
  const directory = join(output, candidate.kind);
  // Each variant owns one browser and one server; no overlapping CPU/GPU workloads.
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/ring-terrain-baseline.ts'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        SU_RING_BASELINE_LAYOUT: layoutFile,
        SU_RING_BASELINE_OUTPUT: directory,
        SU_RING_BASELINE_SOURCE_RELEASE: source,
        SU_RING_BASELINE_CANDIDATE_RELEASE: candidate.directory ?? '',
      },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${candidate.kind} hardware profile failed: ${signal ?? code}`)),
    );
  });
  const report = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert.equal(report.status, 'measured');
  assert.equal(report.profileFixture.kind, candidate.kind);
  assert.equal(report.mapVersion, preflight.find((p) => p.kind === candidate.kind)!.mapVersion);
  assert.equal(report.profileFixture.enabledInstances, 3709);
  assert.equal(report.layoutSha256, hash(exportBytes));
  assert.equal(report.unchanged.layout, true);
  assert.equal(report.unchanged.oldDistManifest, true);
  assert.equal(report.unchanged.benchmark, true);
  assert.equal(report.unchanged.profileFixture, true);
  assert.equal(report.benchmarkSha256, scripts[0].sha256);
  assert.equal(report.profileFixtureSha256, scripts[1].sha256);
  reports.push(report);
}

const baseline = reports[0];
for (const report of reports.slice(1)) {
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
    assert.deepEqual(report[key], baseline[key], `Incomparable profile conditions: ${key}`);
  assert.deepEqual(report.initial.rendering.renderer, baseline.initial.rendering.renderer);
  assert.deepEqual(report.profileFixture.source, baseline.profileFixture.source);
  assert.equal(report.profileFixture.instancesSha256, baseline.profileFixture.instancesSha256);
}
const max = (values: number[]) => values.reduce((a, b) => Math.max(a, b), 0);
const limit = (reference: number) => Math.max(1.2 * reference, reference + 1);
const variants = reports.map((report) => ({
  kind: report.profileFixture.kind,
  mapVersion: report.mapVersion,
  assetReleaseVersion: report.assetReleaseVersion,
  world: report.world,
  preparationMs: report.preparationMs,
  profileFixture: report.profileFixture,
  phases: report.phases.map((phase: any, index: number) => {
    const original = baseline.phases[index];
    assert.equal(phase.kind, original.kind);
    const frameP95LimitMs = limit(original.summary.frameMs.p95);
    const physicsP95LimitMs = limit(original.summary.physicsStepMs.p95);
    const states = [phase.before, ...phase.diagnostics, phase.after];
    return {
      ...phase.summary,
      maxima: {
        bodies: max(states.map((s) => s.physics.bodies)),
        meshes: max(states.map((s) => s.rendering.meshes)),
        activeTriangles: max(states.map((s) => s.activeIndices / 3)),
        jsHeapUsedBytes: max(states.map((s) => s.jsHeap?.usedJSHeapSize ?? 0)),
        wasmReservedBytes: max(states.map((s) => s.wasmReservedBytes)),
        resourceCacheBytes: max(states.map((s) => s.resources.cacheBytes)),
        graphicsCells: max(states.map((s) => s.streaming.graphicsActive.length)),
        physicsCells: max(states.map((s) => s.streaming.physicsActive.length)),
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
  layoutSha256: hash(exportBytes),
  layoutRevision: snapshot.revision,
  scripts,
  strictFrameP95BudgetMs: 16.7,
  relativeBudget: 'max(1.2 * legacy p95, legacy p95 + 1 ms), separately for frame and physics',
  fullGameplayAcceptance: { assessed: false, passed: false },
  variants,
};
assert.equal(
  hash(await readFile(layoutFile)),
  hash(exportBytes),
  'Export changed during comparison',
);
await verifyScripts();
await writeFile(join(output, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
console.log(JSON.stringify(comparison, null, 2));
