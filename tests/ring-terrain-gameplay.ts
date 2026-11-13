/** City functional acceptance on exact saved statics; all accounts/dynamics are synthetic. */
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { build as buildClient, createServer } from 'vite';
import type { Page } from 'playwright';
import {
  canonicalJson,
  PROTOCOL_VERSION,
  type WorldLayoutSnapshot,
  type Vec3,
} from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import { readWorldDirectory } from '../apps/server/src/world-bundle.js';
import {
  readAuthoringRelease,
  editableStaticAssetIds,
  layoutHash,
} from '../apps/server/src/layout/release.js';
import { ItemStore } from '../apps/server/src/items/store.js';
import { WorldOwnership } from '../apps/server/src/world-ownership.js';
import { createDatabaseFixture } from './helpers/database-fixture.js';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { createDelayRelay } from './helpers/tcp-delay.js';

assert.ok(
  process.env.SU_TEST_DATABASE_URL,
  'SU_TEST_DATABASE_URL must select disposable PostgreSQL',
);
const authoringDirectory = resolve(process.argv[2] ?? 'output/ring-terrain-stage4/authoring-world');
const exportDirectory = resolve(process.argv[3] ?? 'output/ring-terrain-stage4/export-world');
const snapshotFile = resolve(
  process.argv[4] ?? 'output/ring-terrain-stage4/target-static-snapshot.json',
);
const baseOutput = resolve(process.argv[5] ?? 'output/ring-terrain-stage5/pilot-gameplay');
const phase = process.env.SU_CITY_PHASE ?? 'all';
assert.ok(['all', 'game', 'cold', 'lobby', 'resources'].includes(phase));
const acceptanceScope = process.env.SU_CITY_SCOPE ?? 'pilot';
assert.ok(['pilot', 'full-static-city'].includes(acceptanceScope));
const rttMs = Number(process.env.SU_CITY_RTT_MS ?? 100);
assert.ok(rttMs === 0 || rttMs === 100);
const output = join(baseOutput, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const snapshotBytes = await readFile(snapshotFile);
const staticSnapshot = JSON.parse(snapshotBytes.toString()) as WorldLayoutSnapshot;
const published = await readWorldDirectory(exportDirectory);
const manifestBytes = await readFile(join(exportDirectory, 'manifest.json'));
const report: any = {
  formatVersion: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  scope: `${acceptanceScope} functional acceptance; synthetic dynamics`,
  fullCityAcceptance: false,
  fullStaticCityFunctionalAcceptance: false,
  performanceAcceptance: false,
  userDatabaseAssessed: false,
  dynamicInput: 'two synthetic guest players; deliberately empty synthetic item state',
  staticInput: {
    file: snapshotFile,
    sha256: hash(snapshotBytes),
    owners: staticSnapshot.instances.length,
    enabled: staticSnapshot.instances.filter((o) => o.enabled).length,
  },
  mapVersion: published.manifest.mapVersion,
  protocolVersion: PROTOCOL_VERSION,
  phase,
  viewport: { width: 1280, height: 720 },
  quality: 'standard',
  networkProfile: { rttMs, jitterMs: rttMs ? 20 : 0 },
  output,
  errors: [] as unknown[],
  failures: [] as unknown[],
};
const save = async () => {
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(baseOutput, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const snapshot = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const rendering = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.report().rendering);
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0;
const browser = await launchTestBrowser({
  renderer: 'default',
  channel: 'chromium',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
report.browser = browser.version();

async function bootstrapDatabase(
  database: Awaited<ReturnType<typeof createDatabaseFixture>>,
  directory: string,
) {
  const authored = await readAuthoringRelease(directory);
  assert.equal(staticSnapshot.assetReleaseVersion, authored.metadata.assetReleaseVersion);
  const ownership = new WorldOwnership(database.pool, staticSnapshot.worldId, randomUUID());
  try {
    const items = new ItemStore(
      database.pool,
      { ...published.definition, initialItems: [] },
      ownership.epoch,
      ownership,
    );
    assert.deepEqual(await items.initialize(), []);
    const db = ownership.db;
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO world_layouts(world_id,asset_release_version,seed_version,asset_ids,fixed_entity_ids,revision,validated_revision,validated_hash)
        VALUES($1,$2,$3,$4,$5,$6,$6,$7)`,
        [
          staticSnapshot.worldId,
          staticSnapshot.assetReleaseVersion,
          staticSnapshot.seedVersion,
          editableStaticAssetIds(authored),
          [
            ...authored.metadata.fixedInstanceIds,
            ...authored.definition.entities.map((i) => i.entityId),
          ],
          staticSnapshot.revision,
          layoutHash(staticSnapshot),
        ],
      );
      // Import the exact exported revisions, solely into the fresh disposable fixture schema.
      await db.query('ALTER TABLE world_static_instances DISABLE TRIGGER USER');
      await db.query(
        `INSERT INTO world_static_instances(world_id,entity_id,asset_id,position_x,position_y,position_z,rotation_x,rotation_y,rotation_z,rotation_w,instance_revision,enabled,source_ref)
        SELECT $1,x->>'entityId',x->>'assetId',(x->'position'->>'x')::double precision,(x->'position'->>'y')::double precision,(x->'position'->>'z')::double precision,
        (x->'rotation'->>'x')::double precision,(x->'rotation'->>'y')::double precision,(x->'rotation'->>'z')::double precision,(x->'rotation'->>'w')::double precision,
        (x->>'instanceRevision')::integer,(x->>'enabled')::boolean,x->'sourceRef' FROM jsonb_array_elements($2::jsonb) x`,
        [staticSnapshot.worldId, canonicalJson(staticSnapshot.instances)],
      );
      await db.query('ALTER TABLE world_static_instances ENABLE TRIGGER USER');
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  } finally {
    await ownership.close();
  }
}

const held = new Map<Page, string[]>();
async function keys(page: Page, next: string[]) {
  for (const key of held.get(page) ?? []) if (!next.includes(key)) await page.keyboard.up(key);
  for (const key of next) if (!(held.get(page) ?? []).includes(key)) await page.keyboard.down(key);
  held.set(page, next);
}
async function navigate(page: Page, point: [number, number], sprint: boolean) {
  const first = (await snapshot(page)).predicted.position;
  const length = Math.hypot(point[0] - first.x, point[1] - first.z);
  const segments = Math.max(1, Math.ceil(length));
  let waypoint = 1;
  const deadline =
    Date.now() + Math.max(25000, Math.hypot(point[0] - first.x, point[1] - first.z) * 900);
  while (Date.now() < deadline) {
    // Poll only poses while steering; full snapshots remain at evidence/gate
    // boundaries and in the correction/pin observer below.
    const state = await page.evaluate(() => (window as any).__SU_DEBUG__.motion());
    if (state.connection === 'waiting') {
      await keys(page, []);
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__.motion().connection === 'playing',
        undefined,
        { timeout: 20000 },
      );
      continue;
    }
    assert.equal(state.connection, 'playing');
    const position = state.predicted?.position;
    assert.ok(position, 'Predicted character position is available');
    const along =
      length > 0
        ? ((position.x - first.x) * (point[0] - first.x) +
            (position.z - first.z) * (point[1] - first.z)) /
          length
        : 0;
    const lateral =
      length > 0
        ? Math.abs(
            (position.x - first.x) * (point[1] - first.z) -
              (position.z - first.z) * (point[0] - first.x),
          ) / length
        : 0;
    // At 14m/s a fixed step can pass a small intermediate target without landing
    // inside its radius. Crossing its plane advances the same straight segment.
    if (waypoint < segments && along >= (length * waypoint) / segments - 0.15 && lateral <= 0.6) {
      waypoint++;
      continue;
    }
    const targetX = first.x + ((point[0] - first.x) * waypoint) / segments;
    const targetZ = first.z + ((point[1] - first.z) * waypoint) / segments;
    const dx = targetX - position.x,
      dz = targetZ - position.z;
    if (Math.hypot(dx, dz) < 0.35) {
      if (waypoint < segments) {
        waypoint++;
        continue;
      }
      await keys(page, []);
      await delay(300);
      return (await snapshot(page)).authoritative.position;
    }
    const next =
      Math.abs(dx) > Math.abs(dz)
        ? dx > 0
          ? ['d', 's']
          : ['w', 'a']
        : dz > 0
          ? ['a', 's']
          : ['w', 'd'];
    if (sprint && Math.hypot(point[0] - position.x, point[1] - position.z) > 3) next.push('Shift');
    await keys(page, next);
    await delay(45);
  }
  await keys(page, []);
  throw new Error(
    `City route stuck at ${point}: ${JSON.stringify((await snapshot(page)).predicted)}`,
  );
}

async function installObserver(page: Page) {
  await page.evaluate(
    ({ grid, bounds }) => {
      const debug = (window as any).__SU_DEBUG__;
      const data: any = {
        active: true,
        network: false,
        frames: 0,
        samples: [],
        corrections: [],
        rtts: [],
        missingCorrections: 0,
        maxPending: 0,
        stalled: 0,
        historyFrames: 0,
        maxHistoryCells: 0,
        cells: [],
        minY: Infinity,
        maxY: -Infinity,
        violations: [],
      };
      let lastSequence = debug.snapshot().correctionCount,
        lastSample = 0;
      let previousRequired: string[] = [],
        previousActive: string[] = [];
      const cellAt = (p: any) =>
        `${Math.min(grid.columns - 1, Math.floor((p.x - grid.origin.x) / grid.cellSize))}_${Math.min(grid.rows - 1, Math.floor((p.z - grid.origin.z) / grid.cellSize))}`;
      const tick = () => {
        if (!data.active) return;
        const state = debug.snapshot(),
          stream = state.streaming;
        data.frames++;
        if (state.connection === 'playing' && stream && state.predicted && state.authoritative) {
          for (const p of [state.predicted.position, state.authoritative.position]) {
            const id = cellAt(p);
            if (
              p.x >= bounds.min.x &&
              p.x <= bounds.max.x &&
              p.z >= bounds.min.z &&
              p.z <= bounds.max.z &&
              !stream.physicsActive.includes(id)
            )
              data.violations.push({ kind: 'underfoot', id });
            if (!data.cells.includes(id)) data.cells.push(id);
          }
          for (const id of [...stream.required, ...stream.historyRequired])
            if (
              previousRequired.includes(id) &&
              previousActive.includes(id) &&
              !stream.physicsActive.includes(id)
            )
              data.violations.push({ kind: 'unloaded-pin', id });
          previousRequired = [...stream.required, ...stream.historyRequired];
          previousActive = [...stream.physicsActive];
          data.historyFrames += Number(stream.historyRequired.length > 0);
          data.maxHistoryCells = Math.max(data.maxHistoryCells, stream.historyRequired.length);
          if (data.network) {
            data.minY = Math.min(data.minY, state.authoritative.position.y);
            data.maxY = Math.max(data.maxY, state.authoritative.position.y);
            data.maxPending = Math.max(data.maxPending, state.pendingInputs);
            data.stalled += Number(state.stalled);
          }
        }
        if (performance.now() - lastSample >= 100) {
          const history = debug.corrections();
          if (data.network) {
            const fresh = history.samples.filter(
              (_v: number, i: number) => history.firstSequence + i > lastSequence,
            );
            const expected = state.correctionCount - lastSequence;
            if (fresh.length !== expected)
              data.missingCorrections += Math.abs(expected - fresh.length);
            data.corrections.push(...fresh);
            if (state.rttMs > 0) data.rtts.push(state.rttMs);
            data.samples.push({
              at: performance.now(),
              connection: state.connection,
              authoritative: state.authoritative?.position,
              predicted: state.predicted?.position,
              pending: state.pendingInputs,
              stalled: state.stalled,
            });
          }
          lastSequence = state.correctionCount;
          lastSample = performance.now();
        }
        requestAnimationFrame(tick);
      };
      data.setNetwork = (enabled: boolean) => {
        const state = debug.snapshot();
        if (data.network && !enabled) {
          const history = debug.corrections();
          const fresh = history.samples.filter(
            (_v: number, i: number) => history.firstSequence + i > lastSequence,
          );
          data.missingCorrections += Math.abs(state.correctionCount - lastSequence - fresh.length);
          data.corrections.push(...fresh);
        }
        lastSequence = state.correctionCount;
        data.network = enabled;
      };
      (window as any).__CITY_OBSERVER__ = data;
      requestAnimationFrame(tick);
    },
    { grid: published.manifest.grid, bounds: published.manifest.bounds },
  );
}
async function recordCamera(page: Page, label: string) {
  await page.bringToFront();
  await keys(page, []);
  await page.locator('#world').focus();
  await delay(900);
  const before = (await snapshot(page)).predicted.position;
  const overview = await rendering(page);
  assert.equal(overview.camera.mode, 'overview');
  assert.ok(
    Math.abs(
      overview.camera.target.y - (before.y - published.definition.simulation.character.height / 2),
    ) < 0.12,
    'Overview follows character foot height',
  );
  await page.screenshot({ path: join(output, `${label}-overview.png`) });
  await page.keyboard.press('v');
  for (let attempt = 0; attempt < 4; attempt++) {
    await delay(1000);
    const controls = await page.evaluate(() => (window as any).__SU_DEBUG__.controls());
    if (controls.pointerLocked) break;
    await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable);
    await page.locator('#world').click({ position: { x: 640, y: 360 } });
  }
  await page.waitForFunction(
    () =>
      !!document.pointerLockElement &&
      (window as any).__SU_DEBUG__.controls().view === 'first-person',
  );
  const firstPerson = await rendering(page);
  const pose = (await snapshot(page)).predicted.position;
  assert.ok(
    Math.abs(firstPerson.camera.position.y - pose.y - 0.7) < 0.12,
    'Perspective follows physical capsule eye height',
  );
  assert.ok(distance(before, pose) < 0.1, 'Switching cameras preserves position');
  await page.screenshot({ path: join(output, `${label}-first-person.png`) });
  await page.keyboard.press('v');
  await page.waitForFunction(
    () =>
      (window as any).__SU_DEBUG__.controls().view === 'overview' && !document.pointerLockElement,
  );
  await delay(500);
  return { label, position: before, overview: overview.camera, firstPerson: firstPerson.camera };
}

async function runGame() {
  console.log('City gameplay: copying isolated release and building isolated client');
  const directory = join(output, 'world'),
    clientDirectory = join(output, 'client');
  await cp(authoringDirectory, directory, {
    recursive: true,
    filter: (source) => source !== join(authoringDirectory, 'layouts'),
  });
  await buildClient({
    configFile: 'apps/client/vite.config.ts',
    logLevel: 'error',
    build: { outDir: clientDirectory, emptyOutDir: true },
  });
  const database = await createDatabaseFixture();
  report.database = { schema: database.schema, synthetic: true, removed: false };
  let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
  let relay: Awaited<ReturnType<typeof createDelayRelay>> | undefined;
  const contexts = await Promise.all(
    (phase === 'cold' || phase === 'lobby' ? [0] : [0, 1]).map(() =>
      browser.newContext({ viewport: report.viewport }),
    ),
  );
  // tsx keeps nested function names with this harmless helper in serialized test callbacks.
  for (const context of contexts)
    await context.addInitScript('globalThis.__name = (value) => value;');
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  try {
    await bootstrapDatabase(database, directory);
    app = await createGameServer({
      port: 0,
      pool: database.pool,
      worldDirectory: directory,
      clientDirectory,
      testDiagnostics: true,
    });
    app.room.state.dayFrozenHour = 12; // Explicit environment setup, not a movement/physics override.
    const info = await (await fetch(app.url + '/api/world')).json();
    assert.equal(info.protocolVersion, PROTOCOL_VERSION);
    report.servedWorld = {
      protocolVersion: info.protocolVersion,
      mapVersion: info.mapVersion,
      assetReleaseVersion: info.assetReleaseVersion,
      layoutRevision: info.layoutRevision,
    };
    assert.equal(
      info.mapVersion,
      published.manifest.mapVersion,
      'Game serves the exact exported static publication',
    );
    relay = await createDelayRelay(new URL(app.url), {
      name: 'rtt100-jitter20',
      rttMs,
      jitterMs: rttMs ? 20 : 0,
    });
    for (const [index, page] of pages.entries()) {
      await contexts[index].addInitScript(() =>
        localStorage.setItem('su:render-quality:v1', 'standard'),
      );
      await contexts[index].addInitScript(() => {
        const trace: any = { active: true, resources: [], samples: [] };
        (window as any).__CITY_LOADING__ = trace;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            if (entry.name.includes('/worlds/')) trace.resources.push(entry.toJSON());
        }).observe({ type: 'resource', buffered: true });
        setInterval(() => {
          const debug = (window as any).__SU_DEBUG__;
          if (!trace.active || !debug) return;
          const state = debug.snapshot(),
            stream = state.streaming;
          if (!stream) return;
          trace.samples.push({
            at: performance.now(),
            connection: state.connection,
            preparations: state.preparations,
            areaResults: state.areaResults,
            criticalReady: stream.criticalReady,
            backgroundReady: stream.backgroundReady,
            required: stream.required,
            physicsActive: stream.physicsActive,
            parsedPhysicsCells: stream.parsedPhysicsCells,
            parsedCollisionBytes: stream.parsedCollisionBytes,
            requested: stream.requested,
            cells: stream.cells.map((c: any) => ({
              id: c.id,
              state: c.state,
              preparedMs: c.preparedMs,
              physicsReady: c.physicsReady,
              graphicsReady: c.graphicsReady,
            })),
            resources: { ...stream.resources, http: undefined },
          });
        }, 200);
      });
      page.setDefaultTimeout(120000);
      page.on('pageerror', (error) =>
        report.errors.push({ phase: 'game', client: index, message: error.message }),
      );
      page.on('requestfailed', (request) => {
        report.requestFailures ??= [];
        report.requestFailures.push({
          client: index,
          path: new URL(request.url()).pathname,
          type: request.resourceType(),
          error: request.failure()?.errorText,
        });
      });
      await page.goto(relay.url + '/?diagnostics=1');
      await page.locator('#join:not([disabled])').waitFor();
      // Loading acceptance is separate: warm the ordinary graphical lobby before
      // measuring movement. Any normal prepare rejection remains explicit evidence.
      if (phase === 'lobby')
        await page.waitForFunction(() => {
          const stream = (window as any).__SU_DEBUG__.snapshot().streaming;
          const errors = stream.cells.filter((cell: any) => cell.error);
          if (errors.length) throw new Error(JSON.stringify(errors));
          return stream.backgroundReady;
        });
      if (phase === 'lobby') {
        const loading = await page.evaluate(() => {
          const trace = (window as any).__CITY_LOADING__;
          trace.active = false;
          return trace;
        });
        await writeFile(
          join(output, `client-${index}-loading.json`),
          JSON.stringify(loading, null, 2) + '\n',
        );
        return {
          status: 'passed',
          relay: relay.metrics(),
          streaming: (await snapshot(page)).streaming,
        };
      }
      const attempts = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = (await snapshot(page)).areaResults.length;
        const began = performance.now();
        await page.locator('#join').click();
        await page.waitForFunction((count) => {
          const state = (window as any).__SU_DEBUG__.snapshot();
          return (
            state.connection === 'playing' ||
            (state.areaResults.length > count && state.areaResults.at(-1)?.ok === false)
          );
        }, before);
        const state = await snapshot(page);
        attempts.push({
          attempt,
          elapsedMs: performance.now() - began,
          connection: state.connection,
          result: state.areaResults.at(-1),
          preparations: state.preparations,
        });
        console.log(
          `City gameplay: client ${index + 1} entry ${attempt + 1}: ${state.connection}, ${JSON.stringify(state.areaResults.at(-1))}`,
        );
        if (state.connection === 'playing' || phase === 'cold') break;
        await page.locator('#join:not([disabled])').waitFor();
        await page.waitForFunction(
          () => (window as any).__SU_DEBUG__.snapshot().streaming.backgroundReady,
        );
      }
      report.joinAttempts ??= [];
      report.joinAttempts.push({ client: index, lobbyWarmed: false, attempts });
      await save();
      if (acceptanceScope === 'full-static-city')
        assert.ok(
          attempts.length === 1 && attempts[0].connection === 'playing',
          'Final city cold entry must succeed without a warm retry',
        );
      if (phase === 'cold') {
        const loading = await page.evaluate(() => {
          const trace = (window as any).__CITY_LOADING__;
          trace.active = false;
          return trace;
        });
        await writeFile(
          join(output, `client-${index}-loading.json`),
          JSON.stringify(loading, null, 2) + '\n',
        );
        assert.equal(
          (await snapshot(page)).connection,
          'playing',
          'Cold entry must succeed on its first unchanged 15-second prepare budget',
        );
        return {
          status: 'passed',
          firstAttempt: attempts[0],
          relay: relay.metrics(),
          lobbyWarmed: false,
        };
      }
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
      );
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__.snapshot().streaming.backgroundReady,
      );
      const loading = await page.evaluate(() => {
        const trace = (window as any).__CITY_LOADING__;
        trace.active = false;
        return trace;
      });
      await writeFile(
        join(output, `client-${index}-loading.json`),
        JSON.stringify(loading, null, 2) + '\n',
      );
      await installObserver(page);
      console.log(`City gameplay: client ${index + 1} entered`);
    }
    const cameras = [await recordCamera(pages[0], 'lower')];
    const route: [number, number][] = [
      [-3, 13],
      [-33, -75],
      [-68, -130],
      [-100, -200],
    ];
    const routes: unknown[] = [];
    // Each client moves separately along the real accepted city road; its peer observes it.
    for (const [index, page] of pages.entries()) {
      await page.bringToFront();
      await page.locator('#world').focus();
      for (const p of pages)
        await p.evaluate(() => (window as any).__CITY_OBSERVER__.setNetwork(true));
      for (const [direction, points, sprint] of [
        ['outward', route, false],
        ['return', route.slice().reverse(), true],
      ] as const) {
        for (const point of points) {
          const reached = await navigate(page, [...point], sprint);
          const own = await snapshot(page),
            remote = await snapshot(pages[1 - index]);
          const seen = remote.entities.find(
            (entity: any) => entity.entityId === own.authoritative.entityId,
          );
          assert.ok(seen && distance(seen.position, reached) < 0.4, 'Peer agrees on stopped XYZ');
          routes.push({
            client: index,
            direction,
            sprint,
            target: point,
            position: reached,
            observer: seen.position,
          });
          console.log(`City gameplay: client ${index + 1} ${direction} ${point.join(',')}`);
        }
        if (direction === 'outward' && index === 0) {
          for (const p of pages)
            await p.evaluate(() => (window as any).__CITY_OBSERVER__.setNetwork(false));
          cameras.push(await recordCamera(page, 'upper'));
          for (const p of pages)
            await p.evaluate(() => (window as any).__CITY_OBSERVER__.setNetwork(true));
        }
      }
      for (const p of pages)
        await p.evaluate(() => (window as any).__CITY_OBSERVER__.setNetwork(false));
      if (index === 0) await navigate(page, [-10, 13], false);
    }
    const measurements = [];
    for (const [index, page] of pages.entries()) {
      const data = await page.evaluate(() => {
        const d = (window as any).__CITY_OBSERVER__;
        d.active = false;
        const { setNetwork: _fn, ...result } = d;
        return result;
      });
      await writeFile(
        join(output, `client-${index}-samples.json`),
        JSON.stringify(data, null, 2) + '\n',
      );
      const measurement = {
        client: index,
        frames: data.frames,
        correctionCount: data.corrections.length,
        correctionP95: percentile(data.corrections, 0.95),
        correctionMax: Math.max(0, ...data.corrections),
        rttP50: percentile(data.rtts, 0.5),
        rttP95: percentile(data.rtts, 0.95),
        maxPending: data.maxPending,
        stalledFrames: data.stalled,
        missingCorrections: data.missingCorrections,
        historyFrames: data.historyFrames,
        maxHistoryCells: data.maxHistoryCells,
        cells: data.cells,
        yRange: [data.minY, data.maxY],
        pinViolations: data.violations,
      };
      measurements.push(measurement);
      assert.ok(measurement.correctionCount > 20, 'Sufficient reconciliation events');
      assert.equal(measurement.missingCorrections, 0, 'Complete reconciliation event history');
      assert.ok(
        measurement.correctionP95 <= 0.2,
        `Correction p95 exceeds 0.2m: ${JSON.stringify(measurement)}`,
      );
      assert.ok(measurement.maxPending <= 32, 'Prediction input history remains bounded');
      assert.ok(
        measurement.historyFrames > 0 && measurement.cells.length > 1,
        'Actual movement exercised history and cell boundaries',
      );
      assert.deepEqual(measurement.pinViolations, []);
      assert.ok(data.maxY - data.minY > 1, 'Route exercised different terrain heights');
    }
    return {
      status: 'passed',
      relayProfile: { rttMs, jitterMs: rttMs ? 20 : 0, packetLossModelled: false },
      relay: relay.metrics(),
      measurements,
      routes,
      cameras,
      server: app.room.diagnostics(),
    };
  } catch (error) {
    report.relayAtFailure = relay?.metrics();
    for (const [index, page] of pages.entries()) {
      await page.screenshot({ path: join(output, `game-failure-${index}.png`) }).catch(() => {});
      await writeFile(
        join(output, `game-failure-${index}.json`),
        JSON.stringify(await snapshot(page).catch(() => null), null, 2),
      );
      await writeFile(
        join(output, `client-${index}-samples.json`),
        JSON.stringify(
          await page
            .evaluate(() => {
              const value = (window as any).__CITY_OBSERVER__;
              if (!value) return null;
              value.active = false;
              const { setNetwork: _fn, ...data } = value;
              return { ...data, controlsAtFailure: (window as any).__SU_DEBUG__.controls() };
            })
            .catch(() => null),
          null,
          2,
        ),
      );
      await writeFile(
        join(output, `client-${index}-loading.json`),
        JSON.stringify(
          await page.evaluate(() => (window as any).__CITY_LOADING__ ?? null).catch(() => null),
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await relay?.close();
    await app?.close();
    await database.close();
    report.database.removed = true;
  }
}

async function runResources() {
  console.log('City lifecycle: starting exact-publication probe');
  const wasm = await loadServerWasm();
  const harness = await createServer({
    root: process.cwd(),
    cacheDir: join(output, 'probe-vite-cache'),
    configFile: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'city-lifecycle-probe',
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            const path = new URL(request.url ?? '/', 'http://localhost').pathname;
            if (path === '/city-probe') {
              response.setHeader('content-type', 'text/html');
              response.end('<!doctype html><title>City lifecycle probe</title>');
            } else if (path === '/city-manifest') response.end(JSON.stringify(published.manifest));
            else if (path === '/city-wasm') response.end(wasm);
            else if (path.startsWith('/city-assets/')) {
              const file = path.slice('/city-assets/'.length);
              if (!Object.hasOwn(published.manifest.files, file)) {
                response.statusCode = 404;
                response.end();
              } else response.end(await readFile(join(exportDirectory, file)));
            } else next();
          });
        },
      },
    ],
  });
  const page = await browser.newPage({ viewport: report.viewport });
  page.on('pageerror', (error) =>
    report.errors.push({ phase: 'resources', message: error.message }),
  );
  try {
    await harness.listen();
    const address = harness.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    await page.goto(`http://127.0.0.1:${address.port}/city-probe`);
    await page.evaluate(async () => {
      const module = '/tests/terrain/city-browser-probe.ts';
      (window as any).__CITY_PROBE__ = await (
        await import(/* @vite-ignore */ module)
      ).createCityBrowserProbe();
    });
    const empty = await page.evaluate(() => (window as any).__CITY_PROBE__.warmup());
    const cycles = [];
    for (let i = 0; i < 20; i++) {
      cycles.push(await page.evaluate((index) => (window as any).__CITY_PROBE__.cycle(index), i));
      report.lifecycle = { status: 'running', empty, cycles };
      await save();
      console.log(`City lifecycle: ${i + 1}/20 cycles passed`);
    }
    const pins = await page.evaluate(() => (window as any).__CITY_PROBE__.pins());
    await page.screenshot({ path: join(output, 'lifecycle-released.png') });
    await page.evaluate(() => (window as any).__CITY_PROBE__.dispose());
    return {
      status: 'passed',
      clock: 'Only the CellStreamer release clock advances by 5001ms; physics advances normally',
      empty,
      cycles,
      pins,
    };
  } finally {
    await page.close();
    await harness.close();
  }
}

try {
  await save();
  for (const [name, run] of [
    ['game', runGame],
    ['resources', runResources],
  ] as const) {
    if (
      phase !== 'all' &&
      phase !== name &&
      !(['cold', 'lobby'].includes(phase) && name === 'game')
    )
      continue;
    try {
      report[name === 'resources' ? 'lifecycle' : name] = await run();
    } catch (error) {
      report.failures.push({
        phase: name,
        error: error instanceof Error ? error.stack : String(error),
      });
      console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await save();
  }
  assert.equal(hash(await readFile(snapshotFile)), hash(snapshotBytes));
  assert.equal(hash(await readFile(join(exportDirectory, 'manifest.json'))), hash(manifestBytes));
  report.sourceUnchanged = true;
  report.status = report.failures.length || report.errors.length ? 'failed' : 'passed';
  report.fullStaticCityFunctionalAcceptance =
    report.status === 'passed' &&
    acceptanceScope === 'full-static-city' &&
    ['all', 'game'].includes(phase);
  report.completedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ status: report.status, output, mapVersion: report.mapVersion }));
  if (report.status !== 'passed') process.exitCode = 1;
} finally {
  await browser.close();
}
