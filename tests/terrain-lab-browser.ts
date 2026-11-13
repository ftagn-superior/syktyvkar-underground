import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { cpus, platform } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import type { Page } from 'playwright';
import { buildWorld } from '../tools/world-build/src/index.js';
import {
  loadWorldBundle,
  PROTOCOL_VERSION,
  WORLD_FORMAT_VERSION,
  type Vec3,
  type InventorySlot,
} from '../packages/contracts/src/index.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { terrainPhysicsScenarios } from './terrain/physics-scenarios.js';
import { terrainGeometryEvidence } from './terrain/geometry-evidence.js';
import { launchTestBrowser } from './helpers/browser.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { createGameServer } from './helpers/game-server.js';
import { createDelayRelay } from './helpers/tcp-delay.js';
import { hudClick } from './helpers/hud.js';
import { rotateCamera } from './helpers/camera.js';

if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('SU_TEST_DATABASE_URL is required (disposable schemas).');
const output = resolve(process.env.SU_TERRAIN_OUTPUT ?? 'output/playwright/terrain-lab');
const smoke = process.env.SU_TERRAIN_SMOKE === '1';
const onlyVariant = process.env.SU_TERRAIN_VARIANT;
assert.ok(!onlyVariant || onlyVariant === 'flat' || onlyVariant === 'hill');
const skipProbe = process.env.SU_TERRAIN_SKIP_PROBE === '1';
const hitchMs = Number(process.env.SU_TERRAIN_HITCH_MS ?? 0);
assert.ok(Number.isFinite(hitchMs) && hitchMs >= 0 && hitchMs <= 1000);
const warmup = Number(process.env.SU_TERRAIN_WARMUP_SECONDS ?? (smoke ? 0 : 60));
const measure = Number(process.env.SU_TERRAIN_SAMPLE_SECONDS ?? (smoke ? 1 : 60));
assert.ok(Number.isFinite(warmup) && warmup >= 0 && Number.isFinite(measure) && measure > 0);
const fullDuration =
  !smoke && !onlyVariant && !skipProbe && !hitchMs && warmup >= 60 && measure >= 60;
const quality =
  process.env.SU_TERRAIN_QUALITY ??
  (process.env.SU_TEST_RENDERER === 'hardware' ? 'standard' : 'economy');
assert.ok(quality === 'standard' || quality === 'economy');
await mkdir(output, { recursive: true });
const wasm = await loadServerWasm();
const grid = JSON.parse(await readFile('content/worlds/terrain-lab/terrain.json', 'utf8'));
const browser = await launchTestBrowser({
  renderer: process.env.SU_TEST_RENDERER === 'hardware' ? 'default' : 'software',
});
const snapshot = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const report = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.report());
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const percentile = (v: number[], p: number) =>
  [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) * p)] ?? 0;
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const errors: string[] = [];
const result: any = {
  date: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  protocolVersion: PROTOCOL_VERSION,
  worldFormatVersion: WORLD_FORMAT_VERSION,
  node: process.version,
  browser: browser.version(),
  platform: platform(),
  cpu: cpus()[0].model,
  viewport: { width: 800, height: 600 },
  evidenceViewport: { width: 1280, height: 800 },
  quality,
  environment: { frozenHour: 12 },
  warmupSeconds: warmup,
  sampleSeconds: measure,
  fullDuration,
  smoke,
  onlyVariant,
  skipProbe,
  hitchMs,
  hitches: 0,
  browserConsole: [] as unknown[],
  variants: {},
  failures: [] as { variant?: string; phase: string; error: string }[],
  errors,
};

const held = new Map<Page, string[]>();
const motionTrace: unknown[] = [];
let nextHitch = 0;
async function keys(page: Page, next: string[]) {
  const before = held.get(page) ?? [];
  for (const key of before) if (!next.includes(key)) await page.keyboard.up(key);
  for (const key of next) if (!before.includes(key)) await page.keyboard.down(key);
  held.set(page, next);
}
function axisKeys(x: number, z: number) {
  return Math.abs(x) > Math.abs(z)
    ? x > 0
      ? ['d', 's']
      : ['w', 'a']
    : z > 0
      ? ['a', 's']
      : ['w', 'd'];
}
async function navigate(
  page: Page,
  x: number,
  z: number,
  sprint = false,
  observe?: () => Promise<void>,
) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await snapshot(page);
    motionTrace.push({
      at: Date.now(),
      target: { x, z },
      sprint,
      connection: state.connection,
      authoritative: state.authoritative?.position,
      predicted: state.predicted?.position,
      velocity: state.authoritative?.velocity,
      grounded: state.authoritative?.grounded,
      pendingInputs: state.pendingInputs,
      stalled: state.stalled,
    });
    if (motionTrace.length > 1200) motionTrace.shift();
    if (hitchMs && Date.now() >= nextHitch) {
      nextHitch = Date.now() + 2500;
      result.hitches++;
      await page.evaluate((ms) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          /* induced main-thread hitch */
        }
      }, hitchMs);
      continue;
    }
    if (state.connection === 'waiting') {
      await keys(page, []);
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
        undefined,
        { timeout: 10000 },
      );
      continue;
    }
    assert.equal(state.connection, 'playing');
    if (!state.predicted || !state.authoritative) {
      await keys(page, []);
      await delay(50);
      continue;
    }
    const pos = state.predicted.position,
      dx = x - pos.x,
      dz = z - pos.z,
      d = Math.hypot(dx, dz);
    if (d < 0.2) {
      await keys(page, []);
      await delay(150);
      await observe?.();
      return;
    }
    const next = axisKeys(dx, dz);
    if (sprint && d > 4) next.push('Shift');
    await keys(page, next);
    await delay(35);
    await observe?.();
  }
  await keys(page, []);
  throw new Error(
    `Terrain keyboard route stuck at ${x},${z}: ${JSON.stringify((await snapshot(page)).predicted)}`,
  );
}
const route = [
  [-4, 5],
  [-2, 2],
  [6, -2],
  [8, -6],
  [8, -17],
  [8, -19],
  [19, -19],
  [19, -10],
  [18, -10],
  [19, -10],
  [19, -19],
  [8, -19],
  [8, -17],
  [8, -6],
  [6, -2],
  [-2, 2],
  [-4, 5],
  [-4, 17],
];

async function runGame(variant: 'flat' | 'hill', directory: string) {
  const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL!);
  let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
  let relay: Awaited<ReturnType<typeof createDelayRelay>> | undefined;
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: result.viewport })),
  );
  for (const context of contexts)
    await context.addInitScript(
      (value) => localStorage.setItem('su:render-quality:v1', value),
      quality,
    );
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const observations: any[] = [];
  motionTrace.length = 0;
  try {
    app = await createGameServer({
      port: 0,
      accounts: fixture,
      worldDirectory: directory,
      itemCreationEnabled: true,
      testDiagnostics: true,
    });
    const port = Number(new URL(app.url).port);
    relay = await createDelayRelay(new URL(app.url), {
      name: 'rtt100-jitter20',
      rttMs: 100,
      jitterMs: 20,
    });
    fixture.config.publicOrigin = relay.url;
    const initialBall = [...app.room.state.items.values()].find(
      (i) => i.typeId === 'watermelon-ball',
    )!;
    const ballMotion = {
      start: { x: initialBall.x, y: initialBall.y, z: initialBall.z },
      minX: initialBall.x,
      maxZ: initialBall.z,
    };
    for (const page of pages) {
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', async (message) => {
        if (message.type() !== 'error') return;
        const args = await Promise.all(
          message
            .args()
            .map((h) =>
              h
                .evaluate((v) =>
                  v instanceof Error
                    ? { name: v.name, message: v.message, stack: v.stack }
                    : String(v),
                )
                .catch(() => null),
            ),
        );
        const record = { variant, client: pages.indexOf(page), text: message.text(), args };
        result.browserConsole.push(record);
        console.error(JSON.stringify(record));
      });
      page.setDefaultTimeout(90000);
    }
    await pages[0].goto(relay.url);
    await pages[0].locator('#telegram-login').click();
    await pages[0].locator('#profile-form').waitFor({ state: 'visible' });
    for (const page of pages) {
      await page.bringToFront();
      await page.goto(relay.url + '/?diagnostics=1');
      await page.locator('#join:not([disabled])').waitFor({ timeout: 90000 });
      await page.locator('#join').click();
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
      );
      console.log(`Terrain ${variant}: client ${pages.indexOf(page) + 1} entered`);
    }
    const owner = pages[0],
      observer = pages[1];
    await owner.bringToFront();
    // Main now has a 24-minute day/night cycle. Hold both variants at the
    // same sun position through the real, replicated room-clock controls.
    for (const time of ['stop', '12:00']) {
      await hudClick(owner, '#chat-toggle');
      await owner.locator('#chat-input').fill(`/time ${time}`);
      await owner.locator('#chat-send:not([disabled])').click();
      await owner.waitForFunction(
        () => document.querySelector<HTMLInputElement>('#chat-input')?.value === '',
      );
      await owner.keyboard.press('Escape');
      await delay(1100);
    }
    assert.equal(app.room.state.dayFrozenHour, 12);
    for (const page of pages)
      await page.waitForFunction(
        () => document.querySelector('#clock-text')?.textContent === '12:00',
      );
    await owner.locator('#world').focus();
    console.log(`Terrain ${variant}: two clients ready; warmup ${warmup}s`);
    const warmStart = Date.now();
    while (Date.now() - warmStart < warmup * 1000) {
      for (const [x, z] of route) await navigate(owner, x, z, true);
    }
    await keys(owner, []);
    await delay(500);
    const histories = pages.map(() => ({ sequence: 0, values: [] as number[] }));
    for (let i = 0; i < pages.length; i++)
      histories[i].sequence = (await snapshot(pages[i])).correctionCount;
    const rtts: number[] = [],
      stalledObservations = [0, 0];
    const sample = async () => {
      const states = await Promise.all(pages.map(snapshot));
      const ball = states[0].items.find((i: any) => i.typeId === 'watermelon-ball');
      if (ball) {
        ballMotion.minX = Math.min(ballMotion.minX, ball.position.x);
        ballMotion.maxZ = Math.max(ballMotion.maxZ, ball.position.z);
      }
      for (let i = 0; i < pages.length; i++) {
        const history = await pages[i].evaluate(() => (window as any).__SU_DEBUG__.corrections());
        for (let j = 0; j < history.samples.length; j++) {
          const seq = history.firstSequence + j;
          if (seq > histories[i].sequence) {
            histories[i].values.push(history.samples[j]);
            histories[i].sequence = seq;
          }
        }
        if (states[i].stalled) stalledObservations[i]++;
        rtts.push(states[i].rttMs);
      }
    };
    for (const page of pages)
      await page.evaluate(`(() => {
      const data={start:performance.now(),last:performance.now(),frames:[],active:true};
      window.__TERRAIN_FRAMES__=data;
      const tick=(now)=>{if(!data.active)return;data.frames.push(now-data.last);data.last=now;requestAnimationFrame(tick);};
      requestAnimationFrame(tick);
    })()`);
    const measuredStart = Date.now();
    console.log(`Terrain ${variant}: measuring ${measure}s and walking the complete route`);
    // Walk and sprint both directions through each internal seam, then measure stopping.
    for (const sprint of [false, true]) {
      for (const [x, z] of smoke
        ? [
            [-4, 5],
            [-4, 17],
          ]
        : route) {
        await navigate(owner, x, z, sprint, sample);
        const own = await snapshot(owner),
          remote = await snapshot(observer);
        const seen = remote.entities.find((p: any) => p.entityId === own.authoritative.entityId);
        assert.ok(
          seen && distance(seen.position, own.authoritative.position) < 0.35,
          'two clients agree on XYZ',
        );
        observations.push({
          sprint,
          target: { x, z },
          position: own.authoritative.position,
          observer: seen.position,
          camera: (await report(owner)).rendering.camera.target,
        });
      }
    }
    while (Date.now() - measuredStart < measure * 1000) {
      await sample();
      await delay(50);
    }
    await keys(owner, []);
    await delay(500);
    await sample();
    const timing = await Promise.all(
      pages.map((p) =>
        p.evaluate(() => {
          const d = (window as any).__TERRAIN_FRAMES__;
          d.active = false;
          return { frames: d.frames, elapsedSeconds: (performance.now() - d.start) / 1000 };
        }),
      ),
    );
    const metrics = app.room.diagnostics();
    const rendering = (await report(owner)).rendering;
    const corrections = histories.map((h) => ({
      count: h.values.length,
      p95: percentile(h.values, 0.95),
      max: Math.max(0, ...h.values),
    }));
    for (const c of corrections) {
      assert.ok(c.count > 20);
      if (c.p95 > 0.2)
        result.failures.push({
          variant,
          phase: 'network',
          error: `terrain correction p95 ${JSON.stringify(c)}`,
        });
    }
    const performanceResult = {
      frames: timing.map((t) => ({
        samples: t.frames.length,
        seconds: t.elapsedSeconds,
        p95Ms: percentile(t.frames, 0.95),
        maxMs: Math.max(...t.frames),
      })),
      physics: metrics.cpu.physics,
      drawCalls: rendering.drawCalls,
      bodies: metrics.bodies,
      meshes: rendering.meshes,
      renderer: rendering.renderer,
      corrections,
      rtt: { p50: percentile(rtts, 0.5), p95: percentile(rtts, 0.95) },
      observations,
      ballMotion,
      stalledObservations,
    };
    result.variants[variant].profile = performanceResult;
    await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`Terrain ${variant}: route and network measured; checking entrance and placement`);
    await owner.screenshot({ path: join(output, `${variant}-game-lower.png`) });
    // Approach the rigid house on the slope, using the authored path and real keyboard input.
    for (const [x, z] of [
      [-4, 5],
      [-2, 2],
      [6, -2],
      [8, -6],
      [8, -17],
      [1, -17],
      [1, -15],
      [1, -8.5],
    ])
      await navigate(owner, x, z);
    const inside = await snapshot(owner),
      slopeFloor = app.room.state.players.get(inside.sessionId)!.y - 0.9;
    await delay(800);
    assert.ok(
      Math.abs((await report(owner)).rendering.camera.target.y - slopeFloor) < 0.1,
      'camera follows foot height at the entrance',
    );
    await owner.screenshot({ path: join(output, `${variant}-game-entrance.png`) });
    for (const [x, z] of [
      [1, -15],
      [1, -17],
      [8, -17],
      [8, -19],
      [19, -19],
      [19, -10],
      [18, -10],
    ])
      await navigate(owner, x, z, true);
    await delay(800);
    const summit = await snapshot(owner);
    assert.ok(Math.abs(summit.authoritative.position.y - 0.9 - (variant === 'hill' ? 6 : 0)) < 0.1);
    assert.ok(
      Math.abs((await report(owner)).rendering.camera.target.y - (variant === 'hill' ? 6 : 0)) <
        0.1,
    );
    // Place through the inventory UI; all preview and validation queries use live colliders.
    const place = async (typeId: string) => {
      await hudClick(owner, '#chat-toggle');
      await owner.locator('#chat-input').fill(`/giveme ${typeId}`);
      await owner.locator('#chat-send').click();
      await owner.waitForFunction(
        (id) =>
          (window as any).__SU_DEBUG__
            .snapshot()
            .inventory.slots.some((s: InventorySlot) => s.items.some((item) => item.typeId === id)),
        typeId,
      );
      await owner.keyboard.press('Escape');
      await owner.keyboard.press('x');
      await owner.locator(`.inventory-choice[data-type-id="${typeId}"]`).click();
      await owner.locator('#item-placement').waitFor({ state: 'visible' });
      const confirm = owner.getByRole('button', { name: 'Поставить', exact: true });
      let found = false;
      for (const dy of [0, 20, 40, 60, 80, -20]) {
        for (const dx of [-30, 0, 30, -60, 60, -90, 90]) {
          const x = result.viewport.width / 2 + dx,
            y = result.viewport.height / 2 + dy;
          await owner.mouse.move(x, y);
          await delay(40);
          if (await confirm.isEnabled()) {
            found = true;
            break;
          }
        }
        if (found) break;
      }
      assert.ok(found, `supported ${typeId} placement preview`);
      await owner.screenshot({ path: join(output, `${variant}-place-${typeId}.png`) });
      await confirm.click();
      await owner.waitForFunction(
        () => document.querySelector<HTMLElement>('#item-placement')?.hidden === true,
      );
      const sql = await fixture.pool.query(
        `SELECT request, result FROM item_operations WHERE request->'action'->>'kind'='place' ORDER BY created_at DESC LIMIT 1`,
      );
      assert.equal(sql.rows[0].result.ok, true);
      const placedId = sql.rows[0].request.action.itemId;
      await observer.waitForFunction(
        (id) => (window as any).__SU_DEBUG__.snapshot().items.some((i: any) => i.entityId === id),
        placedId,
      );
      const states = await Promise.all(pages.map(snapshot));
      const seen = states.map((s) => s.items.find((i: any) => i.entityId === placedId));
      assert.ok(
        seen.every(Boolean) && distance(seen[0].position, seen[1].position) < 0.3,
        'both clients observe placed item',
      );
      return sql.rows[0];
    };
    const placedCrate = await place('wooden-crate');
    // Respawn from the upper level is measured separately from ordinary corrections.
    const oldRevision = (await snapshot(owner)).authoritative.revision;
    await hudClick(owner, '#respawn');
    await owner.waitForFunction(
      (r) => (window as any).__SU_DEBUG__.snapshot().authoritative.revision > r,
      oldRevision,
    );
    await owner.keyboard.press('Escape');
    await owner.locator('#world').focus();
    await navigate(owner, -4, 5);
    await navigate(owner, -2, 2);
    await navigate(owner, 6, -2);
    await navigate(owner, 8, -4);
    await owner.waitForFunction(() => {
      const v = (window as any).__SU_DEBUG__.snapshot().authoritative.velocity;
      return Math.hypot(v.x, v.y, v.z) < 0.01;
    });
    const stop = (await snapshot(owner)).authoritative.position;
    await delay(2500);
    assert.ok(
      distance(stop, (await snapshot(owner)).authoritative.position) < 0.05,
      'no drift while stopped on slope',
    );
    const placedBall = await place('watermelon-ball');
    const beforeRotate = (await snapshot(owner)).authoritative.position;
    await rotateCamera(owner, Math.PI / 2);
    await rotateCamera(owner, -Math.PI / 2);
    assert.ok(distance(beforeRotate, (await snapshot(owner)).authoritative.position) < 0.05);
    const slopeRevision = (await snapshot(owner)).authoritative.revision;
    await hudClick(owner, '#respawn');
    await owner.waitForFunction(
      (r) => (window as any).__SU_DEBUG__.snapshot().authoritative.revision > r,
      slopeRevision,
    );
    await owner.keyboard.press('Escape');
    await delay(1000);
    assert.ok(
      (await snapshot(owner)).authoritative.position.y < 1.1,
      'return from slope to lower spawn',
    );
    await owner.waitForFunction(
      () =>
        Math.abs(
          (window as any).__SU_DEBUG__.report().rendering.camera.target.y -
            ((window as any).__SU_DEBUG__.snapshot().predicted.position.y - 0.9),
        ) < 0.1,
    );
    for (const page of pages) await hudClick(page, '#leave');
    await app.close();
    app = undefined;
    const saved = (
      await fixture.pool.query(
        'SELECT id,physical FROM item_instances WHERE world_id=$1 ORDER BY id',
        ['terrain-lab'],
      )
    ).rows;
    app = await createGameServer({
      port,
      accounts: fixture,
      worldDirectory: directory,
      itemCreationEnabled: true,
    });
    const restored = [...app.room.state.items.values()].sort((a, b) =>
      a.entityId.localeCompare(b.entityId),
    );
    assert.deepEqual(
      restored.map((i) => i.entityId),
      saved.map((i) => i.id),
    );
    const poseErrors = restored.map((item, i) =>
      distance({ x: item.x, y: item.y, z: item.z }, saved[i].physical.position),
    );
    assert.ok(
      poseErrors.every((e) => e < 0.1),
      'same release restores item poses',
    );
    await owner.goto(relay.url + '/?diagnostics=1');
    await owner.locator('#join:not([disabled])').click();
    await owner.waitForFunction(
      () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
    );
    assert.equal((await snapshot(owner)).items.length, saved.length);
    return {
      ...performanceResult,
      placements: { summit: placedCrate, slope: placedBall },
      respawns: { summit: true, slope: true },
      restart: { itemIds: saved.map((i) => i.id), poseErrors, reentered: true },
      relay: relay.metrics(),
    };
  } catch (error) {
    console.error(`Terrain ${variant}: ${error instanceof Error ? error.stack : String(error)}`);
    await writeFile(
      join(output, `${variant}-motion-failure.json`),
      JSON.stringify(motionTrace, null, 2),
    );
    for (let i = 0; i < pages.length; i++) {
      await pages[i]
        .screenshot({ path: join(output, `${variant}-failure-${i}.png`) })
        .catch(() => {});
      await writeFile(
        join(output, `${variant}-failure-${i}.json`),
        JSON.stringify(await snapshot(pages[i]).catch(() => null), null, 2),
      );
      await writeFile(
        join(output, `${variant}-failure-dom-${i}.json`),
        JSON.stringify(
          await pages[i]
            .evaluate(() => ({
              join: document.querySelector('#join')?.outerHTML,
              body: document.body.innerText,
              report: (window as any).__SU_DEBUG__?.report(),
            }))
            .catch(() => null),
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
    await relay?.close();
    await app?.close();
    await fixture.close();
  }
}

try {
  for (const variant of onlyVariant
    ? [onlyVariant as 'flat' | 'hill']
    : smoke
      ? (['hill'] as const)
      : (['flat', 'hill'] as const)) {
    console.log(`Terrain ${variant}: building`);
    const directory = join(output, variant, 'world');
    const manifest = await buildWorld('content/worlds/terrain-lab/world.json', directory, {
      terrainVariant: variant,
    });
    const world = await loadWorldBundle(manifest, (file) => readFile(join(directory, file)));
    const variantGrid = {
      ...grid,
      heights: variant === 'flat' ? grid.heights.map(() => 0) : grid.heights,
    };
    const nodePhysics = await terrainPhysicsScenarios(world, variantGrid, wasm);
    const surfaces = JSON.parse(
      await readFile('content/worlds/terrain-lab/surfaces.json', 'utf8'),
    ).layers;
    const geometry = await terrainGeometryEvidence(variantGrid, world, manifest, surfaces, (file) =>
      readFile(join(directory, file)),
    );
    assert.equal(geometry.groundTopTriangles, 3200);
    assert.ok(geometry.maxCoverError <= 0.001 && geometry.foundation.maxError <= 0.001);
    result.variants[variant] = {
      mapVersion: manifest.mapVersion,
      simulationConfigHash: manifest.simulationConfigHash,
      resources: {
        files: Object.keys(manifest.files).length,
        bytes: (
          await Promise.all(
            Object.keys(manifest.files).map(
              async (p) => (await readFile(join(directory, p))).byteLength,
            ),
          )
        ).reduce((a, b) => a + b, 0),
      },
      nodePhysics,
      geometry,
    };
    const harness = await createServer({
      root: process.cwd(),
      cacheDir: join(output, '.vite'),
      configFile: false,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: {
        entries: ['tests/terrain/browser-probe.ts', 'tests/terrain/physics-scenarios.ts'],
      },
      plugins: [
        {
          name: 'terrain-lab-harness',
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url === '/terrain-test') {
                res.setHeader('content-type', 'text/html');
                res.end('<!doctype html><title>Terrain lab evidence</title><body></body>');
              } else if (req.url === '/terrain-manifest') res.end(JSON.stringify(manifest));
              else if (req.url === '/terrain-grid') res.end(JSON.stringify(variantGrid));
              else if (req.url === '/terrain-world') res.end(JSON.stringify(world));
              else if (req.url === '/terrain-wasm') res.end(wasm);
              else if (req.url?.startsWith('/terrain-assets/')) {
                const path = req.url.slice('/terrain-assets/'.length);
                if (!Object.hasOwn(manifest.files, path)) {
                  res.statusCode = 404;
                  res.end();
                  return;
                }
                res.end(await readFile(join(directory, path)));
              } else next();
            });
          },
        },
      ],
    });
    const page = await browser.newPage({ viewport: result.evidenceViewport });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(`Terrain ${variant} probe: ${message.text()}`);
    });
    page.on('requestfailed', (request) => {
      console.error(
        `Terrain ${variant} probe request: ${request.url()} ${request.failure()?.errorText}`,
      );
    });
    page.on('response', async (response) => {
      if (response.status() >= 400)
        console.error(
          `Terrain ${variant} probe HTTP ${response.status()}: ${response.url()} ${(await response.text().catch(() => '')).slice(0, 1200)}`,
        );
    });
    try {
      await harness.listen();
      await harness.environments.client.depsOptimizer?.scanProcessing;
      console.log(`Terrain ${variant}: comparing Node and Chromium physics`);
      await page.goto(harness.resolvedUrls!.local[0] + 'terrain-test');
      const crossRuntime = await page.evaluate(async () => {
        const url = '/tests/terrain/physics-scenarios.ts';
        const { terrainPhysicsScenarios } = await import(/* @vite-ignore */ url);
        return terrainPhysicsScenarios(
          await (await fetch('/terrain-world')).json(),
          await (await fetch('/terrain-grid')).json(),
          await (await fetch('/terrain-wasm')).arrayBuffer(),
        );
      });
      assert.deepEqual(crossRuntime, nodePhysics, 'Node and Chromium terrain physics agree');
      if (variant === 'hill' && !skipProbe) {
        console.log(`Terrain ${variant}: checking 20 resource cycles and reference views`);
        await page.evaluate(async () => {
          const url = '/tests/terrain/browser-probe.ts';
          (window as any).__TERRAIN_PROBE__ = await (
            await import(/* @vite-ignore */ url)
          ).createTerrainProbe();
        });
        result.lifecycle = await page.evaluate(() => ({
          cycles: (window as any).__TERRAIN_PROBE__.cycles,
          empty: (window as any).__TERRAIN_PROBE__.empty,
        }));
        for (const name of [
          'general',
          'top',
          'side',
          'foundation-high',
          'foundation-low',
          'coverage-seam',
        ]) {
          await page.evaluate((n) => (window as any).__TERRAIN_PROBE__.capture(n), name);
          await page.screenshot({ path: join(output, `${name}.png`) });
        }
        result.rendering = await page.evaluate(() =>
          (window as any).__TERRAIN_PROBE__.diagnostics(),
        );
        await page.evaluate(() => (window as any).__TERRAIN_PROBE__.dispose());
      }
    } finally {
      await page.close();
      await harness.close();
    }
    result.variants[variant].browserPhysics = crossRuntimeSummary(nodePhysics);
    try {
      result.variants[variant].game = await runGame(variant, directory);
    } catch (error) {
      result.failures.push({ variant, phase: 'game', error: String(error) });
    }
    await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  }
  if (result.variants.flat?.profile && result.variants.hill?.profile) {
    const flat = result.variants.flat.profile,
      hill = result.variants.hill.profile;
    result.performanceComparison = {
      frame: {
        flat: flat.frames[0].p95Ms,
        hill: hill.frames[0].p95Ms,
        limit: Math.max(flat.frames[0].p95Ms * 1.2, flat.frames[0].p95Ms + 1),
      },
      physics: {
        flat: flat.physics.p95Ms,
        hill: hill.physics.p95Ms,
        limit: Math.max(flat.physics.p95Ms * 1.2, flat.physics.p95Ms + 1),
      },
    };
    for (const [name, m] of Object.entries(result.performanceComparison) as [string, any][])
      if (m.hill > m.limit)
        result.failures.push({
          phase: 'performance',
          error: `${name} performance budget ${JSON.stringify(m)}`,
        });
  }
  if (errors.length) result.failures.push({ phase: 'browser', error: JSON.stringify(errors) });
  result.status = result.failures.length
    ? 'failed'
    : fullDuration
      ? 'passed'
      : 'partial-short-duration';
  if (result.failures.length) process.exitCode = 1;
  console.log(
    JSON.stringify(
      { status: result.status, comparison: result.performanceComparison, output },
      null,
      2,
    ),
  );
} catch (error) {
  result.status = 'failed';
  result.failure = String(error);
  throw error;
} finally {
  const sourceFiles = [
    'packages/contracts/src/terrain.ts',
    'packages/contracts/src/world-types.ts',
    'tools/world-build/src/index.ts',
    'tools/world-build/src/terrain.ts',
    'tools/world-build/src/terrain-authoring.ts',
    'packages/simulation/src/physics-world.ts',
    'apps/client/src/rendering/world-view.ts',
    'tests/terrain-lab-browser.ts',
    'tests/terrain/browser-probe.ts',
    'content/worlds/terrain-lab/world.json',
    'content/worlds/terrain-lab/anchors.json',
    'content/buildings/terrain-lab/tree/source.json',
  ];
  result.sourceHashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (p) => [
        p,
        createHash('sha256')
          .update(await readFile(p))
          .digest('hex'),
      ]),
    ),
  );
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  await browser.close();
}
function crossRuntimeSummary(value: unknown) {
  return { identicalToNode: true, result: value };
}
