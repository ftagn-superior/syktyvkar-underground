import assert from 'node:assert/strict';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createServer } from 'vite';
import { canonicalJson, type WorldDefinition } from '../packages/contracts/src/index.js';
import { createAuthoritativeWorld, loadServerWasm } from '../packages/simulation/src/server.js';
import { readWorldDirectory } from '../apps/server/src/world-bundle.js';
import { createGameServer } from './helpers/game-server.js';
import { buildWorld } from '../tools/world-build/src/index.js';
import { launchTestBrowser } from './helpers/browser.js';
import { runStateViewProbe } from './large-map/state-view.js';
import { runStaticLifecycleProbe } from './large-map/physics.js';
import { prepareScene, localDefinition, hash, DENSE_CELL } from './large-map/content.js';

const output = resolve(process.env.SU_L0_OUTPUT ?? 'output/large-map');
await mkdir(output, { recursive: true });
const save = (file: string, value: unknown) =>
  writeFile(join(output, file), JSON.stringify(value, null, 2) + '\n');
const versions = Object.fromEntries(
  await Promise.all(
    [
      '@babylonjs/core',
      '@colyseus/core',
      '@colyseus/schema',
      '@colyseus/sdk',
      'playwright',
      'vite',
    ].map(async (name) => [
      name,
      JSON.parse(await readFile(join('node_modules', name, 'package.json'), 'utf8')).version,
    ]),
  ),
);
versions['@babylonjs/havok'] = JSON.parse(
  await readFile('packages/simulation/node_modules/@babylonjs/havok/package.json', 'utf8'),
).version;
async function optionalText(path: string) {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}
function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted.at(-1),
  };
}

async function simulationProfile(definition: WorldDefinition, wasm: Uint8Array) {
  const before = process.memoryUsage();
  const createStart = performance.now();
  const world = await createAuthoritativeWorld(definition, wasm);
  const createMs = performance.now() - createStart;
  try {
    for (let i = 0; i < 8; i++)
      assert.ok(world.addPlayer(`profile-${i}`, definition.spawnPoints[i]), `spawn ${i}`);
    const afterCreate = process.memoryUsage();
    const cpuStart = process.cpuUsage();
    const samplesMs = [];
    let groundedPlayerSteps = 0;
    const wallStart = performance.now();
    for (let tick = 0; tick < 4200; tick++) {
      const current = world.getSnapshot();
      for (let i = 0; i < 8; i++) {
        const player = current.players[i];
        const spawn = definition.spawnPoints[i];
        const angle = Math.floor(tick / 180) + i;
        const dx = spawn.x + 6 + Math.sin(angle) * 4 - player.position.x;
        const dz = spawn.z + 6 + Math.cos(angle) * 4 - player.position.z;
        const distance = Math.max(1, Math.hypot(dx, dz));
        world.setInput(player.entityId, { moveX: dx / distance, moveZ: dz / distance });
        if (tick >= 600) {
          assert.ok(
            player.position.y >= 0 && player.position.y < 2,
            'load participant fell away from ground',
          );
          assert.ok(
            player.position.x > definition.bounds.min.x &&
              player.position.x < definition.bounds.max.x &&
              player.position.z > definition.bounds.min.z &&
              player.position.z < definition.bounds.max.z,
            'load participant left world bounds',
          );
          groundedPlayerSteps += Number(player.grounded);
        }
      }
      const start = performance.now();
      world.step();
      if (tick >= 600) samplesMs.push(performance.now() - start);
    }
    assert.ok(
      groundedPlayerSteps / samplesMs.length / 8 >= 0.99,
      'load participants must remain supported by ground',
    );
    return {
      worldId: definition.worldId,
      participants: 8,
      warmupSteps: 600,
      measuredSteps: samplesMs.length,
      groundedPlayerSteps,
      groundedPlayerFraction: groundedPlayerSteps / samplesMs.length / 8,
      simulatedSeconds: 70,
      wallMs: performance.now() - wallStart,
      createMs,
      physicsStepMs: distribution(samplesMs),
      samplesMs,
      cpuMicroseconds: process.cpuUsage(cpuStart),
      memory: { before, afterCreate, afterRun: process.memoryUsage(), havokWasmBytes: null },
      diagnostics: world.diagnostics(),
      finalPlayers: world.getSnapshot().players,
    };
  } finally {
    world.dispose();
  }
}

const evidence: Record<string, unknown> = {
  date: new Date().toISOString(),
  node: process.version,
  versions,
  platform: {
    os: platform(),
    release: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    availableParallelism: availableParallelism(),
    memoryBytes: totalmem(),
    cgroupCpuMax: await optionalText('/sys/fs/cgroup/cpu.max'),
    cgroupMemoryMax: await optionalText('/sys/fs/cgroup/memory.max'),
  },
  lockHash: hash(await readFile('pnpm-lock.yaml')),
  sourceHashes: Object.fromEntries(
    await Promise.all(
      [
        'tests/large-map-l0.ts',
        'tests/large-map/content.ts',
        'tests/large-map/state-view.ts',
        'tests/large-map/physics.ts',
        'tests/large-map/browser.ts',
        'tools/world-build/src/streaming-lab.ts',
        'tools/world-build/src/index.ts',
        'packages/contracts/src/index.ts',
        'packages/contracts/src/world-grid.ts',
        'packages/contracts/src/world-bundle.ts',
        'packages/simulation/src/building-colliders.ts',
        'packages/simulation/src/physics-world.ts',
        'apps/client/src/rendering/buildings.ts',
        'apps/client/src/rendering/world-view.ts',
      ].map(async (file) => [file, hash(await readFile(file))]),
    ),
  ),
  baselineSkipped: process.argv.includes('--skip-baseline'),
};
await save('environment.json', evidence);
try {
  console.log('LM-T01: StateView over real WebSocket connections');
  const stateView = await runStateViewProbe();
  await save('state-view.json', stateView);
  evidence.stateView = {
    result: stateView.result,
    encoding: stateView.encoding.map(({ samplesMs: _, ...profile }) => profile),
  };

  console.log('LM-T02: native static resources and 500ms replay');
  const wasm = await loadServerWasm();
  const physics = await runStaticLifecycleProbe(wasm);
  const physicsMesh = await runStaticLifecycleProbe(wasm, 'arch');
  await save('physics-node.json', { compound: physics, mesh: physicsMesh });
  evidence.physicsNode = {
    result: physics.result,
    replayDrift: physics.replayDrift,
    final: physics.final,
  };

  console.log('LM-T04: fixed content, reproducible builds, full server geometry');
  const scene = await prepareScene(join(output, 'scene'));
  const second = await buildWorld(
    'content/worlds/streaming-lab/world.json',
    join(output, 'scene/repeat-release'),
  );
  assert.equal(canonicalJson(second), canonicalJson(scene.manifest));
  for (const file of Object.keys(second.files))
    assert.deepEqual(
      await readFile(join(output, 'scene/repeat-release', file)),
      await readFile(join(scene.output, file)),
    );
  await save('content-profile.json', { ...scene.profile, reproducible: true });
  evidence.content = scene.profile;
  const small = await readWorldDirectory('dist/worlds/physics-lab');
  const smallSimulation = await simulationProfile(small.definition, wasm);
  const largeSimulation = await simulationProfile(scene.definition, wasm);
  await save('simulation.json', { small: smallSimulation, large: largeSimulation });
  evidence.simulation = [smallSimulation, largeSimulation].map(
    ({ samplesMs: _, finalPlayers: __, ...profile }) => profile,
  );

  console.log('LM-T02/03: real Chromium, cell creation/release, camera coverage');
  const initialCells = scene.cells.filter((cell) => {
    const [x, z] = cell.cellId.split('_').map(Number);
    return x >= 7 && x <= 9 && z >= 7 && z <= 9;
  });
  const initialIds = new Set(initialCells.map((cell) => `ground-${cell.cellId}`));
  const profiles = [
    {
      name: 'sparse',
      definition: localDefinition(
        scene.definition,
        scene.cells.find((cell) => cell.cellId === '7_8')!,
      ),
    },
    {
      name: 'dense',
      definition: localDefinition(
        scene.definition,
        scene.cells.find((cell) => cell.cellId === DENSE_CELL)!,
      ),
    },
    {
      name: 'initial-3x3',
      definition: {
        ...scene.definition,
        buildings: initialCells.flatMap((cell) => cell.buildings),
        entities: scene.definition.entities.filter((entity) => initialIds.has(entity.entityId)),
        spawnPoints: [scene.definition.spawnPoints[0]],
      },
    },
  ];
  const harness = await createServer({
    root: process.cwd(),
    configFile: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'large-map-l0',
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url === '/large-map-probe') {
              response.setHeader('content-type', 'text/html');
              response.end('<!doctype html><title>Large map L0</title><body></body>');
            } else if (request.url === '/large-map-wasm') {
              response.setHeader('content-type', 'application/wasm');
              response.end(wasm);
            } else if (request.url === '/large-map-data') {
              response.setHeader('content-type', 'application/json');
              response.end(JSON.stringify({ manifest: scene.manifest, profiles }));
            } else if (request.url?.startsWith('/large-map-assets/')) {
              const file = request.url.slice('/large-map-assets/'.length);
              if (!Object.hasOwn(scene.manifest.files, file)) {
                response.statusCode = 404;
                response.end();
                return;
              }
              try {
                response.end(await readFile(join(scene.output, file)));
              } catch {
                response.statusCode = 500;
                response.end();
              }
            } else next();
          });
        },
      },
    ],
  });
  let browser;
  try {
    await harness.listen();
    browser = await launchTestBrowser();
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${harness.resolvedUrls!.local[0]}large-map-probe`);
    const result: Awaited<
      ReturnType<(typeof import('./large-map/browser.js'))['runBrowserProbe']>
    > = await page.evaluate(async () => {
      const moduleUrl = '/tests/large-map/browser.ts';
      const { runBrowserProbe } = await import(/* @vite-ignore */ moduleUrl);
      return runBrowserProbe();
    });
    assert.deepEqual(errors, []);
    assert.equal(result.hidden, false);
    assert.ok(Math.abs(result.physics.replayDrift - physics.replayDrift) < 0.001);
    assert.ok(Math.abs(result.physicsMesh.replayDrift - physicsMesh.replayDrift) < 0.001);
    evidence.browser = {
      version: browser.version(),
      result: result.result,
      physicsReplayDrift: result.physics.replayDrift,
      profiles: result.profiles.map(
        ({ name, placements, frameP95Ms, maxFrameMs, rendering, cycles }) => ({
          name,
          placements,
          frameP95Ms,
          maxFrameMs,
          rendering,
          cycles,
        }),
      ),
    };
    await save('browser.json', { browser: browser.version(), ...result, errors });
  } finally {
    await browser?.close();
    await harness.close();
  }

  const initialFiles = new Set(
    initialCells.map(
      (cell) => scene.manifest.cells.find((entry) => entry.cellId === cell.cellId)!.file,
    ),
  );
  initialFiles.add(scene.manifest.worldFile);
  const usedModels = new Set(
    initialCells.flatMap((cell) => cell.buildings.map((building) => building.assetId)),
  );
  for (const id of usedModels)
    for (const key of ['modelFile', 'partsFile', 'collisionFile'] as const)
      initialFiles.add(scene.manifest.assets[id][key]);
  const initialBytes = await Promise.all(
    [...initialFiles].map((file) => readFile(join(scene.output, file))),
  );
  evidence.initialResourceEstimate = {
    worldFiles: initialFiles.size,
    models: [...usedModels],
    rawBytes: initialBytes.reduce((sum, bytes) => sum + bytes.byteLength, 0),
    gzipBytes: initialBytes.reduce((sum, bytes) => sum + gzipSync(bytes).byteLength, 0),
    note: 'Spatial v3 resources only; excludes client JS/WASM/manifest. Actual streamed cold entry is LM-AC02.',
  };

  if (!process.argv.includes('--skip-baseline')) {
    console.log('LM-T04: original rendered physics-lab baseline, 60s warmup + 15s sample');
    const app = await createGameServer({ port: 0 });
    const baselineBrowser = await launchTestBrowser();
    try {
      const page = await baselineBrowser.newPage({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
      });
      const requests: { url: string; rawBytes: number; gzipBytes: number }[] = [];
      const pending = new Set<Promise<void>>();
      page.on('response', (response) => {
        const task = response
          .body()
          .then((bytes) => {
            requests.push({
              url: new URL(response.url()).pathname,
              rawBytes: bytes.length,
              gzipBytes: gzipSync(bytes).byteLength,
            });
          })
          .catch(() => {})
          .finally(() => pending.delete(task));
        pending.add(task);
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${app.url}/?diagnostics=1`);
      await page.locator('#join:not([disabled])').click();
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
      );
      const initialReport = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
      await page.waitForTimeout(60_000);
      // Keep tsx's function-name helper out of code serialized into the page.
      const samples: number[] = await page.evaluate(`new Promise((resolveSamples) => {
        const samples = [];
        const started = performance.now();
        let previous = started;
        function frame(now) {
          samples.push(now - previous);
          previous = now;
          if (now - started >= 15000) resolveSamples(samples);
          else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      })`);
      await Promise.allSettled(pending);
      const report = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
      assert.deepEqual(errors, []);
      const baseline = {
        measuredAt: new Date().toISOString(),
        browser: baselineBrowser.version(),
        viewport: { width: 1920, height: 1080 },
        participants: 1,
        warmupMs: 60_000,
        sampleMs: 15_000,
        frameMs: distribution(samples),
        samplesMs: samples,
        initialReport,
        report,
        requests,
        server: app.room.diagnostics(),
        errors,
        note: 'SwiftShader; comparative baseline, not target GPU acceptance.',
      };
      await page.screenshot({ path: join(output, 'baseline.png') });
      await save('baseline.json', baseline);
      evidence.baseline = {
        frameMs: baseline.frameMs,
        server: baseline.server,
        rawResourceBytes: requests.reduce((sum, request) => sum + request.rawBytes, 0),
        gzipEquivalentBytes: requests.reduce((sum, request) => sum + request.gzipBytes, 0),
      };
    } finally {
      await baselineBrowser.close();
      await app.close();
    }
  }
  evidence.result = 'passed';
  await save('summary.json', evidence);
  await rm(join(output, 'failure.json'), { force: true });
  console.log(
    JSON.stringify(
      { result: evidence.result, output, baselineSkipped: evidence.baselineSkipped },
      null,
      2,
    ),
  );
} catch (error) {
  await save('failure.json', {
    ...evidence,
    error: String(error),
    stack: error instanceof Error ? error.stack : null,
  });
  throw error;
}
