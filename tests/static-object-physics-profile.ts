/** Local comparison, not the server's hardware/AOI/network acceptance benchmark. */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cpus, platform, arch } from 'node:os';
import { createPhysicsWorld } from '../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { type WorldDefinition } from '../packages/contracts/src/index.js';
import { oldExtractionWorld, readRelease, sha256 } from './helpers/static-extraction.js';

const output = process.argv[2] ?? 'output/static-object-physics-profile.json';
const beforeDirectory = process.argv[3];
const afterDirectory = process.argv[4] ?? 'dist/worlds/ring-block';
const wasm = await loadServerWasm();
const definitions = {
  before: beforeDirectory ? (await readRelease(beforeDirectory)).world : await oldExtractionWorld(),
  after: (await readRelease(afterDirectory)).world,
};
const warmupTicks = 600;
const sampleTicks = 1800;
const percentile = (values: number[], quantile: number) =>
  values[Math.floor((values.length - 1) * quantile)];
async function measure(definition: WorldDefinition) {
  const started = performance.now();
  const world = await createPhysicsWorld(definition, wasm, false);
  const constructionMs = performance.now() - started;
  try {
    for (let i = 0; i < 8; i++) {
      const position = world.findSpawn(undefined, definition.spawnPoints[i]);
      if (!position) throw new Error(`Profile spawn ${i} is blocked`);
      world.createCharacter(`profile-${i}`, position);
    }
    const samples: number[] = [];
    for (let tick = 0; tick < warmupTicks + sampleTicks; tick++) {
      for (let i = 0; i < 8; i++) {
        const phase = (Math.floor(tick / 120) + i) % 4;
        world.characters.get(`profile-${i}`)!.input = {
          moveX: [1, 0, -1, 0][phase],
          moveZ: [0, 1, 0, -1][phase],
          sprint: i % 2 === 1,
        };
      }
      const start = performance.now();
      world.advance(1 / 60);
      if (tick >= warmupTicks) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return {
      constructionMs,
      statics: world.staticDiagnostics(),
      stepMs: {
        mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
        p50: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        p99: percentile(samples, 0.99),
        max: samples.at(-1),
      },
      finalPositions: Array.from({ length: 8 }, (_, i) => world.state(`profile-${i}`).position),
    };
  } finally {
    world.dispose();
  }
}
const runs = [];
// Reverse the order on the second pair to expose, rather than hide, JIT/order noise.
for (const label of ['before', 'after', 'after', 'before'] as const) {
  runs.push({ world: label, ...(await measure(definitions[label])) });
}
async function resources(directory: string) {
  const { manifest } = await readRelease(directory);
  const files = await Promise.all(
    Object.keys(manifest.files).map(async (path) => ({
      path,
      bytes: (await stat(resolve(directory, path))).size,
    })),
  );
  const sum = (suffix: string) =>
    files
      .filter((file) => file.path.endsWith(suffix))
      .reduce((total, file) => total + file.bytes, 0);
  return {
    mapVersion: manifest.mapVersion,
    models: Object.keys(manifest.assets).length,
    files: files.length,
    resourceBodyBytes: files.reduce((total, file) => total + file.bytes, 0),
    modelBytes: sum('/model.glb'),
    collisionBytes: sum('/colliders.json'),
    partsBytes: sum('/parts.json'),
    maximumCellBytes: Math.max(
      ...files.filter((file) => file.path.startsWith('cells/')).map((file) => file.bytes),
    ),
  };
}
const profile = {
  description:
    'Same-process Babylon NullEngine + Havok full static ring-block, eight moving controllers and current initial items. PhysicsWorld.advance only; excludes server AOI, encoding, database and networking. No target-hardware acceptance claim.',
  environment: {
    node: process.version,
    babylon: '9.35.0',
    havok: '1.3.14',
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
  },
  warmupTicks,
  sampleTicks,
  tickRate: 60,
  fixtureSha256: sha256(await readFile('tests/fixtures/static-extraction/world.json.gz')),
  resources: {
    ...(beforeDirectory ? { before: await resources(beforeDirectory) } : {}),
    after: await resources(afterDirectory),
  },
  runs,
};
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(output, JSON.stringify(profile, null, 2) + '\n');
console.log(
  JSON.stringify({
    output,
    resources: profile.resources,
    runs: runs.map(({ world, constructionMs, statics, stepMs }) => ({
      world,
      constructionMs,
      statics,
      stepMs,
    })),
  }),
);
