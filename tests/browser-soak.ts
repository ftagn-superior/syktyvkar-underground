import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { Page } from 'playwright';

const url = process.env.SU_TEST_URL ?? 'http://127.0.0.1:2567';
const durationSeconds = Number(process.env.SU_SOAK_SECONDS ?? 1800);
assert.ok(Number.isFinite(durationSeconds) && durationSeconds >= 10);
await mkdir('output/validation', { recursive: true });
await mkdir('output/playwright', { recursive: true });
const bots = spawn(
  process.execPath,
  [
    '--import',
    'tsx',
    'tools/load-test/src/index.ts',
    '--url',
    url,
    '--clients',
    '6',
    '--seconds',
    String(durationSeconds + 120),
    '--scenario',
    'crowd',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
const botErrors: string[] = [];
bots.stderr.on('data', (data) => {
  if (botErrors.length < 30) botErrors.push(String(data));
});
// Drain output: a child must never block on a full stdout pipe during a long run.
bots.stdout.on('data', () => {});
const browser = await launchTestBrowser();
const errors: string[] = [];
const samples: any[] = [];
const held = [new Set<string>(), new Set<string>()];
const targets = [0, 2];
const route = [
  { x: -3, z: 3 },
  { x: 3, z: 3 },
  { x: 3, z: 8 },
  { x: -3, z: 8 },
];
const receivedBytes = [0, 0];
const contexts = await Promise.all(
  [0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })),
);
const pages = await Promise.all(contexts.map((context) => context.newPage()));
const snapshot = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
let started = 0;
try {
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', (error) => {
      if (errors.length < 30) errors.push(error.message);
    });
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        receivedBytes[index] +=
          typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
      }),
    );
    await page.goto(`${url}/?diagnostics=1`);
    await page.locator('#join:not([disabled])').waitFor();
    await page.locator('#join').click();
    await page.waitForFunction(
      () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    );
  }
  await pages[0].waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().occupancy === 8);
  console.log(`Started ${durationSeconds}s soak: 6 SDK clients + 2 rendered Chromium contexts.`);
  started = performance.now();
  let nextSample = 0,
    nextProgress = 60;
  while ((performance.now() - started) / 1000 < durationSeconds) {
    const elapsed = (performance.now() - started) / 1000;
    const states = await Promise.all(pages.map(snapshot));
    for (const [index, page] of pages.entries()) {
      const state = states[index];
      assert.equal(state.connection, 'playing');
      assert.equal(state.occupancy, 8);
      assert.ok(state.pendingInputs <= 32);
      const position = state.authoritative.position;
      let target = route[targets[index]];
      if (Math.hypot(target.x - position.x, target.z - position.z) < 0.8) {
        targets[index] = (targets[index] + 1) % route.length;
        target = route[targets[index]];
      }
      const dx = target.x - position.x,
        dz = target.z - position.z;
      const forward = -(dx + dz),
        right = dx - dz;
      const next = new Set<string>();
      if (Math.abs(forward) > 0.4) next.add(forward > 0 ? 'w' : 's');
      if (Math.abs(right) > 0.4) next.add(right > 0 ? 'd' : 'a');
      for (const key of held[index]) if (!next.has(key)) await page.keyboard.up(key);
      for (const key of next) if (!held[index].has(key)) await page.keyboard.down(key);
      held[index] = next;
    }
    if (elapsed >= nextSample) {
      const diagnostics = await fetch(`${url}/api/diagnostics`).then((r) => r.json());
      samples.push({
        elapsed,
        diagnostics,
        clients: states.map((state) => ({
          frameP95Ms: state.frameP95Ms,
          correctionP95: state.correctionP95,
          pendingInputs: state.pendingInputs,
          playerCount: state.playerCount,
          occupancy: state.occupancy,
          serverTick: state.serverTick,
        })),
        receivedBytes: [...receivedBytes],
      });
      nextSample = elapsed + 5;
    }
    if (elapsed >= nextProgress) {
      console.log(
        `${Math.floor(elapsed)}s: 8 connected, bounded queues, ${errors.length} browser errors.`,
      );
      nextProgress += 60;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const [index, page] of pages.entries())
    for (const key of held[index]) await page.keyboard.up(key);
  await pages[0].screenshot({ path: 'output/playwright/eight-players.png' });
  assert.deepEqual(errors, []);
  assert.deepEqual(botErrors, []);
  const elapsed = (performance.now() - started) / 1000;
  const report = {
    date: new Date().toISOString(),
    durationSeconds: elapsed,
    browser: browser.version(),
    renderer: 'SwiftShader software rendering; not a hardware FPS acceptance',
    clients: 8,
    networkClients: 6,
    browserClients: 2,
    result: 'passed',
    meanWebsocketKiBPerSecond: receivedBytes.map((n) => n / 1024 / elapsed),
    errors,
    botErrors,
    samples,
  };
  await writeFile('output/validation/soak.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        durationSeconds: elapsed,
        meanWebsocketKiBPerSecond: report.meanWebsocketKiBPerSecond,
        final: samples.at(-1)?.diagnostics,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    'output/validation/soak-failure.json',
    JSON.stringify(
      {
        error: String(error),
        elapsed: started ? (performance.now() - started) / 1000 : 0,
        errors,
        botErrors,
        samples,
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  for (const page of pages)
    await page
      .locator('#leave')
      .click({ timeout: 2000 })
      .catch(() => {});
  bots.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (bots.exitCode !== null) return resolve();
    const timeout = setTimeout(() => {
      bots.kill('SIGKILL');
    }, 3000);
    bots.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  await browser.close();
}
