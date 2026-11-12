import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { runPhysicsScenarios } from './physics-scenarios.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const wasm = await loadServerWasm();
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'isolated-physics-test-harness',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url === '/physics-test') {
            res.setHeader('content-type', 'text/html');
            res.end(
              '<!doctype html><html><head><title>Physics integration harness</title></head><body>Physics integration harness</body></html>',
            );
          } else if (req.url === '/HavokPhysics.wasm') {
            res.setHeader('content-type', 'application/wasm');
            res.end(wasm);
          } else next();
        });
      },
    },
  ],
});
await server.listen();
let browser;
try {
  browser = await launchTestBrowser({ renderer: 'default' });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls!.local[0]}physics-test`);
  const nodeResult = await runPhysicsScenarios(wasm);
  const browserResult: Awaited<ReturnType<typeof runPhysicsScenarios>> = await page.evaluate(
    async () => {
      const moduleUrl = '/tests/physics-scenarios.ts';
      const { runPhysicsScenarios } = await import(/* @vite-ignore */ moduleUrl);
      const bytes = await (await fetch('/HavokPhysics.wasm')).arrayBuffer();
      return runPhysicsScenarios(bytes);
    },
  );
  assert.deepEqual(errors, [], 'browser has no uncaught errors');
  for (const result of [nodeResult, browserResult]) {
    for (const [index, expected] of [4, 14, 4, 0].entries()) {
      assert.ok(Math.abs(result.movement[index].speed - expected) < 0.001);
      assert.ok(Math.abs(result.movement[index].distance - expected / 2) < 0.01);
    }
    assert.equal(result.cadence.length, 3);
    for (const cadence of result.cadence) {
      assert.equal(cadence.steps, 180);
      assert.deepEqual(
        cadence.samples,
        result.cadence[0].samples,
        'render cadence must not affect physical time',
      );
    }
    assert.ok(
      result.maximumReplayDrift < 0.05,
      `controller replay drift: ${result.maximumReplayDrift}`,
    );
    assert.equal(result.buildings.length, 2);
    for (const building of result.buildings) {
      assert.ok(building.maximumReplayDrift < 0.05, `${building.kind}: contact replay drift`);
      const players = building.samples.at(-1)!.players;
      const blocked = players.find((player) => player.entityId === 'local')!;
      const pass = players.find((player) => player.entityId === 'pass')!;
      const contactX = building.kind === 'arch' ? 9.15 : 6.15;
      assert.ok(
        Math.abs(blocked.position.x - contactX) < 0.06,
        `${building.kind}: rotated contact`,
      );
      assert.ok(
        pass.position.z > (building.kind === 'arch' ? 8.8 : 11.8),
        `${building.kind}: open passage`,
      );
    }
  }
  let maximumCrossRuntimeDifference = 0;
  const compare = (a: unknown, b: unknown): void => {
    if (typeof a === 'number' && typeof b === 'number') {
      assert.ok(Number.isFinite(a) && Number.isFinite(b));
      maximumCrossRuntimeDifference = Math.max(maximumCrossRuntimeDifference, Math.abs(a - b));
    } else if (a && b && typeof a === 'object' && typeof b === 'object') {
      assert.deepEqual(Object.keys(a), Object.keys(b));
      for (const key of Object.keys(a))
        compare((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
    } else assert.equal(a, b);
  };
  compare(nodeResult.cadence, browserResult.cadence);
  compare(nodeResult.movement, browserResult.movement);
  compare(nodeResult.buildings, browserResult.buildings);
  assert.ok(
    maximumCrossRuntimeDifference < 0.001,
    `Node/browser discrepancy: ${maximumCrossRuntimeDifference}`,
  );
  const report = {
    check:
      'T01 browser/Node fixed step, walk/sprint transitions, T02 sprint replay, static compound and mesh buildings',
    date: new Date().toISOString(),
    node: process.version,
    browser: browser.version(),
    outerCadencesHz: [30, 60, 120],
    stepsPerCadence: 180,
    snapshotsPerCadence: 6,
    maximumCrossRuntimeDifference,
    movement: { node: nodeResult.movement, browser: browserResult.movement },
    replayDrift: { node: nodeResult.maximumReplayDrift, browser: browserResult.maximumReplayDrift },
    buildingReplayDrift: {
      node: nodeResult.buildings.map(({ kind, maximumReplayDrift }) => ({
        kind,
        maximumReplayDrift,
      })),
      browser: browserResult.buildings.map(({ kind, maximumReplayDrift }) => ({
        kind,
        maximumReplayDrift,
      })),
    },
    result: 'passed',
  };
  await mkdir(new URL('../output/playwright/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../output/playwright/physics-equivalence.json', import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
