import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import type { Page } from 'playwright';
import { Client, type Room } from '@colyseus/sdk';
import { createGameServer } from '../apps/server/src/index.js';
import { buildWorld } from '../tools/world-build/src/index.js';
import { PROTOCOL_VERSION } from '../packages/contracts/src/index.js';
import { WorldState } from '../packages/protocol/src/index.js';
import { launchTestBrowser } from './helpers/browser.js';
import { prepareSdk } from './helpers/prepare.js';
import { createDelayRelay } from './helpers/tcp-delay.js';
import { interestProfile } from './large-map/interest-profile.js';
import { hash } from './large-map/content.js';
const output = process.env.SU_L4_OUTPUT ?? 'output/large-map/l4';
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'su-l4-browser-'));
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let relay: Awaited<ReturnType<typeof createDelayRelay>> | undefined;
let far: Room<WorldState> | undefined;
const browser = await launchTestBrowser();
const errors: string[] = [],
  logs: string[] = [],
  checks: string[] = [];
const phases: Record<string, any> = {};
let activePages: Page[] = [];
const held = new Map<Page, string[]>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const report = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.report());
async function keys(page: Page, next: string[]) {
  for (const key of held.get(page) ?? []) if (!next.includes(key)) await page.keyboard.up(key);
  for (const key of next) if (!(held.get(page) ?? []).includes(key)) await page.keyboard.down(key);
  held.set(page, next);
}
async function move(page: Page, x: number, z = 4) {
  const deadline = performance.now() + 22000;
  while (performance.now() < deadline) {
    const current = await state(page);
    if (current.connection !== 'playing' || !current.predicted) {
      await keys(page, []);
      await sleep(35);
      continue;
    }
    assert.ok(current.predicted.position.y > 0.8, 'Capsule fell through ground');
    assert.ok(current.pendingInputs <= 32 && current.historyInputs <= 30);
    const dx = x - current.predicted.position.x,
      dz = z - current.predicted.position.z;
    if (Math.hypot(dx, dz) < 0.16) {
      await keys(page, []);
      await sleep(220);
      return;
    }
    await keys(
      page,
      Math.abs(dx) > Math.abs(dz)
        ? dx > 0
          ? ['d', 's']
          : ['w', 'a']
        : dz > 0
          ? ['a', 's']
          : ['w', 'd'],
    );
    await sleep(35);
  }
  await keys(page, []);
  throw new Error(`L4 movement timed out at ${x},${z}`);
}
async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 22000 },
  );
}
async function visible(page: Page, yes: boolean, id: string) {
  await page.waitForFunction(
    ({ yes, id }) => {
      const debug = (window as any).__SU_DEBUG__,
        data = debug.snapshot(),
        rendering = debug.report().rendering;
      const remote = data.entities.some((entity: any) => entity.entityId === id);
      const rendered = rendering.dynamicEntities.some((entity: any) => entity.entityId === id);
      return (
        remote === yes &&
        rendered === yes &&
        !!data.crate === yes &&
        data.physics.crate === yes &&
        data.physics.remotePlayers === (yes ? 1 : 0)
      );
    },
    { yes, id },
    { timeout: 7000 },
  );
}
async function settled(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().streaming.cells.length === 9,
    undefined,
    { timeout: 10000 },
  );
  await sleep(100);
}
async function resources(page: Page) {
  const data = await state(page),
    rendering = (await report(page)).rendering;
  const labels = await page.locator('.player-label').count();
  return {
    meshes: rendering.meshes,
    materials: rendering.materials,
    geometries: rendering.geometries,
    nodes: rendering.nodes,
    textures: rendering.textures,
    shadows: rendering.shadowCasters,
    dynamic: rendering.dynamicEntities.length,
    labels,
    bodies: data.physics.bodies,
    remotePlayers: data.physics.remotePlayers,
    crate: data.physics.crate,
    tracked: data.trackedEntities.length,
    statics: data.physics.entities,
    cells: data.streaming.cells.length,
  };
}
const stage = (name: string) => console.log(`L4: ${name}`);
try {
  await cp('content', join(temporary, 'content'), { recursive: true });
  const source = join(temporary, 'content/worlds/streaming-lab/world.json');
  const header = JSON.parse(await readFile(source, 'utf8'));
  header.spawnPoints = [
    { x: -4, y: 0, z: 4 },
    { x: 77, y: 0, z: 4 },
    { x: -504, y: 0, z: -504 },
    { x: -996, y: 0, z: 4 },
    { x: -996, y: 0, z: 504 },
    { x: 504, y: 0, z: -996 },
    { x: -496, y: 0, z: 754 },
    { x: 754, y: 0, z: -496 },
  ];
  header.crate.position = { x: 77, y: 0.52, z: 10 };
  await writeFile(source, JSON.stringify(header));
  const manifest = await buildWorld(source, join(temporary, 'world'));
  app = await createGameServer({ port: 0, worldDirectory: join(temporary, 'world') });
  const profile = { name: 'rtt100-jitter20', rttMs: 100, jitterMs: 20 };
  relay = await createDelayRelay(new URL(app.url), profile);
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 960, height: 640 } })),
  );
  const pages = await Promise.all(
    contexts.map(async (context) => {
      await context.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
      return context.newPage();
    }),
  );
  activePages = pages;
  for (const page of pages) {
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type()))
        logs.push(
          message.text().replace(/([?&](?:reconnectionToken|token)=)[^&\s'"]+/g, '$1[redacted]'),
        );
    });
    await page.goto(relay.url + '/?diagnostics=1');
    await page.locator('#join:not([disabled])').waitFor();
    await page.locator('#join').click();
    await playing(page);
  }
  const [observer, actor] = pages;
  const info = await (await fetch(app.url + '/api/world')).json();
  far = await new Client(app.url).joinById<WorldState>(info.roomId, info, WorldState);
  far.reconnection.enabled = false;
  far.onMessage('problem', () => {});
  far.onMessage('resync', () => {});
  prepareSdk(far);
  await observer.waitForFunction(
    () =>
      (window as any).__SU_DEBUG__.snapshot().occupancy === 3 &&
      document.querySelector('#player-count')?.textContent === '3 / 8',
  );
  const initial = await state(observer);
  const remoteId = (await state(actor)).authoritative.entityId;
  const identity = initial.authoritative.entityId;
  assert.equal(initial.playerCount, 1);
  assert.equal(initial.crate, null);
  assert.equal(initial.physics.crate, false);
  assert.equal(initial.trackedEntities.length, 1);
  assert.equal(initial.physics.remotePlayers, 0);
  phases.initial = initial;
  const ack = initial.lastAck;
  await move(observer, -6);
  await move(observer, -4);
  assert.ok((await state(observer)).lastAck > ack);
  assert.equal((await state(observer)).crate, null);
  checks.push(
    'A far client plays and acknowledges input without the crate; occupancy stays global',
  );
  stage('no-crate control passed');
  await move(actor, 75);
  await move(observer, 0);
  await visible(observer, true, remoteId);
  await settled(observer);
  phases.near = { state: await state(observer), resources: await resources(observer) };
  const hiddenCycles: any[] = [],
    visibleCycles: any[] = [],
    freshSamples: any[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await move(observer, -26);
    await visible(observer, false, remoteId);
    await settled(observer);
    const hidden = await state(observer);
    assert.ok(
      !hidden.trackedEntities.includes(remoteId) &&
        !hidden.trackedEntities.includes(header.crate.entityId),
    );
    hiddenCycles.push(await resources(observer));
    await move(actor, cycle % 2 === 0 ? 76 : 75);
    await move(observer, -13);
    await visible(observer, false, remoteId);
    const capture = observer.evaluate(async (id) => {
      const deadline = performance.now() + 12000;
      while (performance.now() < deadline) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const debug = (window as any).__SU_DEBUG__,
          data = debug.snapshot();
        const raw = data.entities.find((entity: any) => entity.entityId === id);
        const smoothed = data.remotePoses.find((entity: any) => entity.entityId === id);
        const visual = debug
          .report()
          .rendering.dynamicEntities.find((entity: any) => entity.entityId === id);
        if (raw && smoothed && visual)
          return { raw, smoothed, visual, serverTick: data.serverTick };
      }
      throw new Error('Fresh appearance was not observed');
    }, remoteId);
    await move(observer, 0);
    const fresh = await capture;
    assert.ok(
      Math.abs(fresh.raw.position.x - fresh.smoothed.position.x) < 0.001,
      'Re-entry interpolated from stale entity history',
    );
    assert.ok(
      Math.abs(fresh.raw.position.x - fresh.visual.position.x) < 0.001,
      'Re-entry rendered an old position',
    );
    freshSamples.push(fresh);
    await visible(observer, true, remoteId);
    await settled(observer);
    visibleCycles.push(await resources(observer));
    stage(`visibility cycle ${cycle + 1} passed`);
  }
  assert.ok(
    hiddenCycles.every((value) => JSON.stringify(value) === JSON.stringify(hiddenCycles[0])),
    'Hidden resources accumulated',
  );
  assert.ok(
    visibleCycles.every((value) => JSON.stringify(value) === JSON.stringify(visibleCycles[0])),
    'Visible resources accumulated',
  );
  phases.cycles = { hiddenCycles, visibleCycles, freshSamples };
  checks.push(
    'Three 80/100m cycles clean views, proxies, labels, shadows/materials and smoothing; same IDs return with fresh positions',
  );
  await move(observer, -13);
  await visible(observer, true, remoteId);
  await contexts[0].setOffline(true);
  await observer.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
    undefined,
    { timeout: 12000 },
  );
  await sleep(200);
  await contexts[0].setOffline(false);
  await playing(observer);
  await visible(observer, false, remoteId);
  const restored = await state(observer);
  phases.reconnect = restored;
  assert.equal(restored.authoritative.entityId, identity);
  assert.equal(restored.occupancy, 3);
  checks.push(
    'Reconnection in the 80–100m band starts a fresh filtered view with the same own entity',
  );
  const cameraFrames = [];
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 360, height: 800 },
    { width: 3840, height: 720 },
  ]) {
    await observer.setViewportSize(size);
    for (let turn = 0; turn < 4; turn++) {
      await observer.keyboard.press('e');
      await observer.waitForFunction(
        () => !(window as any).__SU_DEBUG__.report().rendering.camera.turning,
      );
      const camera = (await report(observer)).rendering.camera;
      const radius = Math.hypot(
        camera.halfWidth,
        camera.halfHeight / Math.cos(camera.beta) + 2 * Math.tan(camera.beta),
      );
      assert.ok(radius < 80, 'Camera exposes dynamic positions beyond the enter radius');
      cameraFrames.push({ size, camera, radius });
    }
  }
  phases.camera = cameraFrames;
  checks.push(
    'Portrait/landscape/ultrawide and all camera turns keep the dynamic footprint inside the 80m enter radius',
  );
  await observer.setViewportSize({ width: 960, height: 640 });
  await move(observer, 0);
  await visible(observer, true, remoteId);
  await actor.locator('#leave').click();
  await observer.waitForFunction((id) => {
    const debug = (window as any).__SU_DEBUG__,
      data = debug.snapshot();
    return (
      !data.entities.some((entity: any) => entity.entityId === id) &&
      data.physics.remotePlayers === 0 &&
      !data.trackedEntities.includes(id) &&
      !debug.report().rendering.dynamicEntities.some((entity: any) => entity.entityId === id)
    );
  }, remoteId);
  phases.final = await state(observer);
  assert.equal(phases.final.predictionWorlds, 1);
  assert.ok(phases.final.replaySteps > 0);
  assert.equal(phases.final.crate.entityId, header.crate.entityId);
  assert.equal(app.room.diagnostics().players, 2);
  checks.push(
    'Consented leave removes the actor from all views, proxy bodies, smoothing and visual resources',
  );
  assert.deepEqual(errors, []);
  await observer.screenshot({ path: output + '/visibility.png' });
  const encoding = [interestProfile(false), interestProfile(true)];
  assert.ok(encoding[0].meanStateBytesPerClientPatch < encoding[1].meanStateBytesPerClientPatch);
  const sourceFiles = [
    'apps/server/src/interest.ts',
    'apps/server/src/world-room.ts',
    'packages/contracts/src/index.ts',
    'packages/protocol/src/index.ts',
    'apps/client/src/network/session.ts',
    'apps/client/src/main.ts',
    'apps/client/src/rendering/world-view.ts',
    'apps/client/src/rendering/camera-controller.ts',
    'packages/simulation/src/prediction.ts',
    'packages/simulation/src/physics-world.ts',
    'tests/large-map-l4.ts',
    'tests/large-map/interest-profile.ts',
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(sourceFiles.map(async (path) => [path, hash(await readFile(path))])),
  );
  const evidence = {
    date: new Date().toISOString(),
    result: 'passed',
    browser: browser.version(),
    cpu: cpus()[0].model,
    renderer: 'SwiftShader',
    profile,
    protocolVersion: PROTOCOL_VERSION,
    mapVersion: manifest.mapVersion,
    simulationConfigHash: manifest.simulationConfigHash,
    checks,
    phases,
    sourceHashes,
    encoding,
    errors,
    logs,
    relay: relay.metrics(),
    server: app.room.diagnostics(),
  };
  await writeFile(output + '/browser.json', JSON.stringify(evidence, null, 2) + '\n');
  await rm(output + '/failure.json', { force: true });
  console.log(
    JSON.stringify(
      {
        result: evidence.result,
        checks,
        hiddenCycles,
        visibleCycles,
        encoding: encoding.map(
          ({ profile, meanStateBytesPerClientPatch, selectionMs, encodingMs }) => ({
            profile,
            meanStateBytesPerClientPatch,
            selectionMs,
            encodingMs,
          }),
        ),
        server: evidence.server,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    output + '/failure.json',
    JSON.stringify(
      {
        error: String(error),
        errors,
        logs,
        phases,
        lastStates: await Promise.all(activePages.map((page) => state(page).catch(() => null))),
        server: app?.room.diagnostics(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await far?.leave().catch(() => {});
  await browser.close();
  await relay?.close();
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
