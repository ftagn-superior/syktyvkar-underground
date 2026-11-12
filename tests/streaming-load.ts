import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, cpus, totalmem, platform } from 'node:os';
import { Client } from '@colyseus/sdk';
import type { Page, CDPSession } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { startSdkLoad } from './helpers/sdk-load.js';
import { crowdTarget, spreadRoute, expectedInterest } from '../tools/load-test/src/routes.js';
import { launchTestBrowser } from './helpers/browser.js';
import { buildStreamingFixture, seedStreamingItemProfile } from './helpers/streaming-world.js';
import { createDatabaseFixture } from './helpers/database-fixture.js';
import { worldCellAt } from '../packages/contracts/src/index.js';
import { createDelayRelay } from './helpers/tcp-delay.js';
import { hash } from './large-map/content.js';

const content = process.env.SU_STREAMING_CONTENT ?? 'streaming-lab';
const itemProfile = process.env.SU_STREAMING_ITEMS ?? 'existing';
assert.ok(content === 'streaming-lab' || content === 'ring-block');
assert.ok(itemProfile === 'existing' || itemProfile === 'all-types');
assert.ok(
  process.env.SU_TEST_DATABASE_URL,
  'SU_TEST_DATABASE_URL is required for an isolated load-test schema',
);
const zoom = Number(process.env.SU_STREAMING_ZOOM ?? 1);
assert.ok([1, 30].includes(zoom), 'Measure normal and 30× views separately');
const scenario = process.env.SU_STREAMING_SCENARIO ?? 'spread';
assert.ok(scenario === 'spread' || scenario === 'crowd');
const clients = Number(process.env.SU_STREAMING_CLIENTS ?? 8);
const seconds = Number(process.env.SU_STREAMING_SECONDS ?? 60);
const warmupSeconds = Number(process.env.SU_STREAMING_WARMUP ?? 60);
const rttMs = Number(process.env.SU_STREAMING_RTT ?? 100);
const netem = process.env.SU_STREAMING_NETEM === '1';
const renderer = process.env.SU_STREAMING_RENDERER ?? 'software';
const quality = process.env.SU_STREAMING_QUALITY ?? 'economy';
const width = Number(process.env.SU_STREAMING_WIDTH ?? 960),
  height = Number(process.env.SU_STREAMING_HEIGHT ?? 640);
assert.ok(
  [seconds, warmupSeconds, width, height].every(Number.isFinite) &&
    ['software', 'default'].includes(renderer) &&
    ['standard', 'economy'].includes(quality) &&
    width >= 360 &&
    height >= 300,
);
if (netem)
  assert.ok(
    process.env.SU_TEST_HOST_NETNS &&
      (await readlink('/proc/self/ns/net')) !== process.env.SU_TEST_HOST_NETNS,
    'netem requires a separate network namespace',
  );
assert.ok(
  [2, 4, 8].includes(clients) &&
    seconds >= 10 &&
    warmupSeconds >= 0 &&
    [0, 100, 200].includes(rttMs),
);
const output =
  process.env.SU_STREAMING_OUTPUT ??
  `output/dynamic-map/load-${content}-${scenario}-${itemProfile}-${clients}-zoom${zoom}`;
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'su-streaming-load-'));
const fixture = await buildStreamingFixture(directory, scenario, { content, items: itemProfile });
const startFixture = async () => {
  const database = await createDatabaseFixture();
  let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
  let relay: Awaited<ReturnType<typeof createDelayRelay>> | undefined;
  let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
  try {
    const itemEvidence = await seedStreamingItemProfile(database.pool, fixture);
    app = await createGameServer({
      port: 0,
      pool: database.pool,
      worldDirectory: fixture.worldDirectory,
      testDiagnostics: true,
    });
    relay = await createDelayRelay(new URL(app.url), {
      name: `rtt${rttMs}-jitter20`,
      rttMs: netem ? 0 : rttMs,
      jitterMs: netem ? 0 : rttMs ? 20 : 0,
    });
    browser = await launchTestBrowser({ renderer: renderer as 'software' | 'default' });
    return { database, itemEvidence, app, relay, browser };
  } catch (error) {
    await browser?.close();
    await relay?.close();
    try {
      await app?.close();
    } finally {
      await database.close();
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};
const { database, itemEvidence, app, relay, browser } = await startFixture();
let load: Awaited<ReturnType<typeof startSdkLoad>> | undefined;
const pages: Page[] = [];
const inspectors: CDPSession[] = [];
const coldHttp: { bytes: number; cells: string[]; resources: (typeof traffic)[0]['http'] }[] = [];
const held = [new Set<string>(), new Set<string>()];
const errors: string[] = [];
const traffic = [0, 1].map(() => ({
  stateBytes: 0,
  allBytes: 0,
  http: [] as { url: string; status: number; bodyBytes: number; headersBytes: number }[],
}));
const browserStats = [0, 1].map(() => ({
  distance: 0,
  last: undefined as { x: number; z: number } | undefined,
  cells: new Set<string>(),
  target: 0,
  route: [] as { x: number; z: number }[],
  interestChecks: 0,
  previous: new Set<string>(),
  lastCorrection: 0,
  corrections: [] as number[],
  waitingAt: undefined as number | undefined,
  completedRoutes: 0,
  resourceBaselines: new Map<string, unknown>(),
  resourceRecurrences: 0,
}));
const samples: any[] = [];
let started = 0,
  measuredAt = 0;
const state = (page: Page): Promise<any> =>
  page.evaluate(() => {
    const snapshot = (window as any).__SU_DEBUG__.snapshot();
    // Full bounded traces belong in the report, not in every navigation poll.
    if (snapshot.streaming) {
      delete snapshot.streaming.operations;
      delete snapshot.streaming.resources.http;
    }
    return snapshot;
  });
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
const keys = async (page: Page, index: number, next: Set<string>) => {
  for (const key of held[index]) if (!next.has(key)) await page.keyboard.up(key);
  for (const key of next) if (!held[index].has(key)) await page.keyboard.down(key);
  held[index] = next;
};
try {
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript((quality) => {
      localStorage.setItem('su:render-quality:v1', quality);
      performance.setResourceTimingBufferSize(4096);
      const probe = { count: 0, maxMs: 0, samples: [] as number[] };
      (window as any).__SU_LONG_TASKS__ = probe;
      new PerformanceObserver((list) => {
        for (const task of list.getEntries()) {
          probe.count++;
          probe.maxMs = Math.max(probe.maxMs, task.duration);
          probe.samples.push(task.duration);
          if (probe.samples.length > 3600) probe.samples.shift();
        }
      }).observe({ type: 'longtask', buffered: true });
    }, quality);
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', (error) => {
      if (errors.length < 40) errors.push(error.message);
    });
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const bytes = typeof payload === 'string' ? Buffer.from(payload) : payload;
        traffic[i].allBytes += bytes.length;
        if ([14, 15].includes(bytes[0] & 31)) traffic[i].stateBytes += bytes.length;
      }),
    );
    page.on('response', (response) => {
      void response
        .request()
        .sizes()
        .then((sizes) => {
          if (traffic[i].http.length < 4096)
            traffic[i].http.push({
              url: new URL(response.url()).pathname,
              status: response.status(),
              bodyBytes: sizes.responseBodySize,
              headersBytes: sizes.responseHeadersSize,
            });
        })
        .catch(() => {});
    });
    await page.goto(relay.url + '/?diagnostics=1');
    await page.locator('#join:not([disabled])').click();
    await page.waitForFunction(
      () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
      undefined,
      { timeout: 22000 },
    );
    inspectors.push(await context.newCDPSession(page));
    const initial = await state(page);
    const initialHttp = [...traffic[i].http];
    const bytes = initialHttp.reduce((sum, request) => sum + request.bodyBytes, 0);
    const cellRequests = initialHttp
      .filter((request) => request.url.includes('/cells/'))
      .map((request) => request.url);
    assert.ok(bytes > 0 && bytes <= 8 * 1024 * 1024, `Cold transfer ${bytes} bytes`);
    assert.ok(new Set(cellRequests).size <= fixture.manifest.cells.length);
    assert.ok(initial.streaming.criticalReady);
    coldHttp.push({ bytes, cells: cellRequests, resources: initialHttp });
    if (zoom === 30) {
      await page.locator('#world').dispatchEvent('wheel', { deltaY: 10000 });
      await page.waitForFunction(
        () => {
          const r = (window as any).__SU_DEBUG__.report().rendering;
          return r.camera.zoom === 30 && r.streaming.shownRadius >= r.streaming.drawRadius - 1;
        },
        undefined,
        { timeout: 60000 },
      );
    }
    if (scenario === 'spread')
      browserStats[i].route = spreadRoute(
        fixture.header,
        (await state(page)).authoritative.position,
      );
  }
  if (clients > 2)
    load = await startSdkLoad({
      url: relay.url,
      diagnosticsUrl: app.url,
      clients: clients - 2,
      scenario,
    });
  await pages[0].waitForFunction(
    (count) => (window as any).__SU_DEBUG__.snapshot().occupancy === count,
    clients,
  );
  const info = await (await fetch(app.url + '/api/world')).json();
  if (clients === 8) await assert.rejects(new Client(app.url).joinById(info.roomId, info));
  if (netem)
    execFileSync('tc', [
      'qdisc',
      'replace',
      'dev',
      'lo',
      'root',
      'netem',
      'delay',
      '100ms',
      '10ms',
      'loss',
      '1%',
    ]);
  started = performance.now();
  let nextSample = 0,
    nextProgress = 0;
  let cadenceWindow: Awaited<ReturnType<NonNullable<typeof load>['sample']>> | undefined;
  let measureTraffic = traffic.map((entry) => ({ ...entry }));
  let measureSdk: Awaited<ReturnType<NonNullable<typeof load>['report']>> | undefined;
  console.log(
    `Streaming ${scenario}: ${clients} clients (2 Chromium), ${warmupSeconds}s warmup + ${seconds}s measurement.`,
  );
  while (!measuredAt || performance.now() - measuredAt < seconds * 1000) {
    const elapsed = (performance.now() - started) / 1000;
    const states = await Promise.all(pages.map(state));
    for (const [i, page] of pages.entries()) {
      const current = states[i],
        stats = browserStats[i];
      assert.ok(
        ['playing', 'preparing', 'waiting'].includes(current.connection),
        `Lost browser ${i}: ${current.connection}`,
      );
      assert.equal(current.occupancy, clients);
      if (current.connection === 'playing') stats.waitingAt = undefined;
      else {
        stats.waitingAt ??= performance.now();
        assert.ok(performance.now() - stats.waitingAt < 15000, 'Area preparation stalled for 15s');
      }
      assert.ok(current.pendingInputs <= 32 && current.historyInputs <= 30);
      assert.ok(
        current.streaming.resources.cacheBytes <= 64 * 1024 * 1024 &&
          current.streaming.resources.httpPeak <= 4,
      );
      assert.ok(current.physics.entities <= current.streaming.entities);
      assert.equal(
        current.physics.bodies,
        current.physics.entities + 1 + current.physics.remotePlayers + current.physics.items,
        'Unexpected native body count',
      );
      const position = current.authoritative.position;
      assert.ok(position.y > 0.8, 'Browser fell through ground');
      if (stats.last)
        stats.distance += Math.hypot(position.x - stats.last.x, position.z - stats.last.z);
      stats.last = position;
      const id = worldCellAt(fixture.manifest.bounds, fixture.manifest.grid, position);
      assert.ok(id, 'Browser left the declared world');
      stats.cells.add(id);
      const navigate = current.predicted?.position ?? position;
      let target;
      if (scenario === 'spread') {
        target = stats.route[stats.target];
        if (Math.hypot(target.x - navigate.x, target.z - navigate.z) < 0.65) {
          stats.target = (stats.target + 1) % stats.route.length;
          if (stats.target === 0) stats.completedRoutes++;
          target = stats.route[stats.target];
        }
      } else
        target = crowdTarget(
          current.items.find((item: any) => item.typeId === 'wooden-crate')?.position ??
            fixture.header.initialItems[0].position,
          i + 6,
          elapsed,
        );
      const dx = target.x - navigate.x,
        dz = target.z - navigate.z;
      const next = new Set<string>();
      if (current.connection === 'playing' && Math.hypot(dx, dz) > 0.45) {
        for (const key of Math.abs(dx) > Math.abs(dz)
          ? dx > 0
            ? ['d', 's']
            : ['w', 'a']
          : dz > 0
            ? ['a', 's']
            : ['w', 'd'])
          next.add(key);
      }
      await keys(page, i, next);
    }
    if (!measuredAt && elapsed >= warmupSeconds) {
      measuredAt = performance.now();
      measureTraffic = traffic.map((entry) => ({ ...entry }));
      measureSdk = await load?.report();
      for (const [index, stats] of browserStats.entries()) {
        stats.corrections = [];
        stats.lastCorrection = states[index].correctionCount;
      }
    }
    if (elapsed >= nextSample) {
      const sdk = await load?.sample();
      if (sdk) {
        if (!cadenceWindow) cadenceWindow = sdk;
        else if (sdk.elapsed - cadenceWindow.elapsed >= 60) {
          const duration = sdk.elapsed - cadenceWindow.elapsed;
          sdk.clients.forEach((peer, index) => {
            const before = cadenceWindow!.clients[index];
            const actual = (peer.sent - before.sent) / duration;
            const scheduled =
              (peer.sent + peer.backpressureTicks - before.sent - before.backpressureTicks) /
              duration;
            assert.ok(
              scheduled >= 56 && scheduled <= 61 && (netem || actual >= 56),
              `SDK ${index} 60-second cadence: sent ${actual}, scheduled ${scheduled}`,
            );
          });
          cadenceWindow = sdk;
        }
      }
      const diagnostics = await (await fetch(app.url + '/api/diagnostics')).json();
      assert.equal(diagnostics.players, clients);
      assert.equal(diagnostics.sessions, clients);
      assert.ok(diagnostics.maxQueue <= 32);
      const compact = [];
      for (const [i, page] of pages.entries()) {
        // One JS task: an intervening render/prediction frame must not mix a
        // finished old cell set with meshes already attached for the next one.
        const { current, corrections, rendering } = await page.evaluate(() => {
          const debug = (window as any).__SU_DEBUG__;
          return {
            current: debug.snapshot(),
            corrections: debug.corrections(),
            rendering: debug.report().rendering,
          };
        });
        const stats = browserStats[i];
        // Capture before the delayed HTTP read so its publication is already in server history.
        const observed = states[i];
        const truth = diagnostics.testPublications.find(
          (entry: any) => entry.tick === observed.serverTick,
        );
        if (truth) {
          const ids = observed.entities
            .map((entry: any) => entry.entityId)
            .concat(observed.items.map((item: any) => item.entityId));
          const expected = expectedInterest(
            truth.entities,
            observed.authoritative.entityId,
            stats.previous,
          );
          assert.deepEqual(
            [...expected].sort(),
            ids.sort(),
            `Browser ${i} AOI at tick ${observed.serverTick}`,
          );
          stats.previous = new Set(ids);
          stats.interestChecks++;
        }
        corrections.samples.forEach((value: number, index: number) => {
          const seq = corrections.firstSequence + index;
          if (seq > stats.lastCorrection && measuredAt) stats.corrections.push(value);
        });
        stats.lastCorrection = corrections.firstSequence + corrections.samples.length - 1;
        const stable =
          current.streaming.requested.length === 0 &&
          current.streaming.retained.length === 0 &&
          current.streaming.backgroundReady;
        if (measuredAt && stable) {
          const key = JSON.stringify([
            current.streaming.physicsRequired.slice().sort(),
            current.streaming.graphicsRequired.slice().sort(),
            current.trackedEntities.slice().sort(),
          ]);
          const counts = {
            meshes: rendering.meshes,
            materials: rendering.materials,
            geometries: rendering.geometries,
            nodes: rendering.nodes,
            textures: rendering.textures,
            bodies: current.physics.bodies,
            shapes: current.physics.buildings.shapes,
          };
          const previous = stats.resourceBaselines.get(key);
          if (previous) {
            assert.deepEqual(
              counts,
              previous,
              'A repeated settled area accumulated rendering or native resources',
            );
            stats.resourceRecurrences++;
          } else {
            assert.ok(stats.resourceBaselines.size < 256);
            stats.resourceBaselines.set(key, counts);
          }
        }
        assert.ok(
          rendering.shadowCasters <= rendering.meshes,
          'Shadow references exceed live meshes',
        );
        compact.push({
          heap: await inspectors[i].send('Runtime.getHeapUsage'),
          connection: current.connection,
          frameP95Ms: current.frameP95Ms,
          frameSamples: current.frameSampleCount,
          pending: current.pendingInputs,
          historyInputs: current.historyInputs,
          historyAgeMs: current.historyMaxAgeMs,
          pauses: current.predictionPauses,
          replaySteps: current.replaySteps,
          correctionCount: current.correctionCount,
          correctionP95: current.correctionP95,
          physics: current.physics,
          streaming: {
            required: current.streaming.required,
            active: current.streaming.active,
            retained: current.streaming.retained,
            historyRequired: current.streaming.historyRequired,
            entities: current.streaming.entities,
            cacheBytes: current.streaming.resources.cacheBytes,
            pending: current.streaming.resources.pending,
            downloads: current.streaming.resources.downloads,
            httpBodyBytes: current.streaming.resources.responseBodyBytes,
            peakPumpMs: current.streaming.peakPumpMs,
            peakOperationMs: current.streaming.peakOperationMs,
          },
          resources: {
            meshes: rendering.meshes,
            materials: rendering.materials,
            geometries: rendering.geometries,
            nodes: rendering.nodes,
            textures: rendering.textures,
            shadowCasters: rendering.shadowCasters,
            dynamic: rendering.dynamicEntities.length,
          },
          position: current.authoritative.position,
          received: { stateBytes: traffic[i].stateBytes, allBytes: traffic[i].allBytes },
        });
      }
      const { testPublications: _history, ...server } = diagnostics;
      const itemMotion = [...app.room.state.items.values()].map((item) => ({
        entityId: item.entityId,
        typeId: item.typeId,
        position: { x: item.x, y: item.y, z: item.z },
        speed: Math.hypot(item.vx, item.vy, item.vz),
        angularSpeed: Math.hypot(item.avx, item.avy, item.avz),
      }));
      samples.push({
        elapsed,
        items: {
          count: itemMotion.length,
          moving: itemMotion.filter((item) => item.speed > 0.03 || item.angularSpeed > 0.03).length,
          snapshots: itemMotion,
        },
        measured: !!measuredAt,
        server,
        browsers: compact,
        sdk: sdk?.clients,
      });
      await writeFile(
        join(output, 'progress.json'),
        JSON.stringify(
          { elapsed, scenario, clients, samples: samples.length, errors, last: samples.at(-1) },
          null,
          2,
        ) + '\n',
      );
      nextSample = elapsed + 5;
    }
    if (elapsed >= nextProgress) {
      console.log(
        `${scenario} ${clients}: ${Math.floor(elapsed)}s, cells ${browserStats.map((s) => s.cells.size).join('/')}, queues bounded, errors ${errors.length}.`,
      );
      nextProgress = elapsed + 30;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const [i, page] of pages.entries()) await keys(page, i, new Set());
  await load?.sample();
  const sdk = await load?.report();
  const measuredSeconds = (performance.now() - measuredAt) / 1000;
  const browserResults = [];
  for (const [i, page] of pages.entries()) {
    const stats = browserStats[i];
    assert.ok(stats.distance > 3 && stats.interestChecks > 0);
    if (scenario === 'spread')
      assert.ok(stats.cells.size >= 2, 'Browser never crossed a cell boundary');
    if (scenario === 'spread' && seconds >= 1800)
      assert.ok(
        stats.completedRoutes >= 3 && stats.resourceRecurrences > 0,
        'Long spread did not repeat its physical route and settled resource set',
      );
    const diagnostics = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
    const heap = await inspectors[i].send('Runtime.getHeapUsage');
    browserResults.push({
      distance: stats.distance,
      cells: [...stats.cells],
      interestChecks: stats.interestChecks,
      completedRoutes: stats.completedRoutes,
      resourceRecurrences: stats.resourceRecurrences,
      resourceBaselines: Object.fromEntries(stats.resourceBaselines),
      stateKiBPerSecond:
        (traffic[i].stateBytes - measureTraffic[i].stateBytes) / 1024 / measuredSeconds,
      allWsKiBPerSecond:
        (traffic[i].allBytes - measureTraffic[i].allBytes) / 1024 / measuredSeconds,
      corrections: {
        count: stats.corrections.length,
        p95: percentile(stats.corrections, 0.95),
        max: Math.max(0, ...stats.corrections),
        samples: stats.corrections,
      },
      heap,
      longTasks: await page.evaluate(() => (window as any).__SU_LONG_TASKS__),
      http: traffic[i].http,
      diagnostics,
    });
  }
  if (sdk) {
    assert.deepEqual(sdk.errors, []);
    for (const peer of sdk.peers) {
      assert.ok(
        peer.scheduledHz >= 56 &&
          peer.scheduledHz <= 61 &&
          peer.inputHz <= 61 &&
          (netem || peer.inputHz >= 56),
        `Input cadence ${peer.inputHz}, scheduler ${peer.scheduledHz}`,
      );
      assert.ok(peer.lastAck > 0 && peer.distance > 1 && peer.interestChecks > 0);
      if (scenario === 'spread')
        assert.ok(peer.cells.length >= 2, 'SDK never crossed cell boundary');
    }
  }
  assert.deepEqual(errors, []);
  const memoryWindows = [];
  for (let from = warmupSeconds; from < warmupSeconds + seconds; from += 300) {
    const window = samples.filter(
      (sample) => sample.elapsed >= from && sample.elapsed < from + 300,
    );
    if (!window.length) continue;
    const summary = (values: number[]) => ({
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
    });
    memoryWindows.push({
      from,
      to: Math.min(from + 300, warmupSeconds + seconds),
      samples: window.length,
      server: {
        rss: summary(window.map((s) => s.server.memory.rss)),
        heapUsed: summary(window.map((s) => s.server.memory.heapUsed)),
        external: summary(window.map((s) => s.server.memory.external)),
      },
      browsers: [0, 1].map((i) => ({
        usedSize: summary(window.map((s) => s.browsers[i].heap.usedSize)),
        backingStorageSize: summary(window.map((s) => s.browsers[i].heap.backingStorageSize)),
        meshes: summary(window.map((s) => s.browsers[i].resources.meshes)),
        bodies: summary(window.map((s) => s.browsers[i].physics.bodies)),
        cacheBytes: summary(window.map((s) => s.browsers[i].streaming.cacheBytes)),
      })),
    });
  }
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        'apps/server/src/world-room.ts',
        'apps/server/src/interest.ts',
        'apps/server/src/metrics.ts',
        'apps/client/src/network/session.ts',
        'apps/client/src/streaming/cells.ts',
        'apps/client/src/streaming/resources.ts',
        'tools/load-test/src/runner.ts',
        'tools/load-test/src/routes.ts',
        'tests/streaming-load.ts',
        'tests/helpers/sdk-load.ts',
        'tools/load-test/src/worker.ts',
        'tests/helpers/streaming-world.ts',
        'content/items/catalog.json',
        `content/worlds/${content}/world.json`,
      ].map(async (path) => [path, hash(await readFile(path))]),
    ),
  );
  const report = {
    date: new Date().toISOString(),
    result: 'passed',
    scenario,
    clients,
    browserClients: 2,
    sdkClients: clients - 2,
    network: {
      rttMs,
      jitterMs: rttMs ? 20 : 0,
      ...relay.metrics(),
      packetLoss: netem ? '1% kernel netem; real TCP retransmission' : false,
      mode: netem
        ? 'isolated user/network namespace, impairment after initial HTTP'
        : 'ordered TCP latency relay',
    },
    warmupSeconds,
    measuredSeconds,
    soak: seconds >= 1800,
    hardwareAcceptance: false,
    environment: {
      node: process.version,
      browser: browser.version(),
      platform: platform(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      renderer,
      quality,
      zoom,
      viewport: { width, height },
      topology:
        'Two foreground contexts; server and browser driver share one process; SDK senders run in a separate child process on this host. Hardware budgets require the target GPU/2vCPU profile.',
      sdkProcessId: load?.pid,
      serverProcessId: process.pid,
    },
    versions: {
      protocol: info.protocolVersion,
      format: fixture.manifest.formatVersion,
      map: fixture.manifest.mapVersion,
      simulation: fixture.manifest.simulationConfigHash,
    },
    contentProfile: fixture.profile,
    itemProfile: itemEvidence,
    scene: fixture.profile.scene,
    errors,
    coldHttp,
    memoryWindows,
    browsers: browserResults,
    sdk,
    measurementStartSdk: measureSdk,
    sdkMeasuredRates: sdk?.peers.map((peer, index) => ({
      stateKiBPerSecond:
        (peer.stateBytes - (measureSdk?.peers[index].stateBytes ?? 0)) / 1024 / measuredSeconds,
      allWsKiBPerSecond:
        (peer.allBytes - (measureSdk?.peers[index].allBytes ?? 0)) / 1024 / measuredSeconds,
      inputHz: (peer.sent - (measureSdk?.peers[index].sent ?? 0)) / measuredSeconds,
      backpressureTicks: peer.backpressureTicks - (measureSdk?.peers[index].backpressureTicks ?? 0),
    })),
    samples,
    sourceHashes,
    byteDefinition:
      'WS state frames include timed input ACK prefix; app payload excludes WS/TCP headers. HTTP request sizes are encoded bodies and headers; HTTP/WS remain separate. Native Havok/WASM allocation is not separately exposed; process external/ArrayBuffers and browser heap are reported without relabeling them as native memory.',
  };
  await pages[0].screenshot({ path: join(output, 'final.png') });
  if (netem) {
    const counters = execFileSync('tc', ['-s', 'qdisc', 'show', 'dev', 'lo'], { encoding: 'utf8' });
    await writeFile(join(output, 'netem-counters.txt'), counters);
    assert.ok(Number(/dropped (\d+)/.exec(counters)?.[1]) > 0, 'No real packet loss observed');
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(join(output, 'failure.json'), { force: true });
  console.log(
    JSON.stringify(
      {
        result: report.result,
        scenario,
        clients,
        measuredSeconds,
        browsers: browserResults.map((r) => ({
          distance: r.distance,
          cells: r.cells.length,
          stateKiBPerSecond: r.stateKiBPerSecond,
          correctionP95: r.corrections.p95,
        })),
        sdk: sdk?.peers.map((p) => ({
          hz: p.inputHz,
          distance: p.distance,
          cells: p.cells.length,
          interest: p.interestChecks,
        })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify(
      {
        error: String(error),
        errors,
        elapsed: started ? (performance.now() - started) / 1000 : 0,
        samples,
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  await load?.stop();
  await browser.close();
  await relay.close();
  try {
    await app.close();
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
