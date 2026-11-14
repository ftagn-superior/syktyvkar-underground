import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { Client, type Room } from '@colyseus/sdk';
import type { Page } from 'playwright';
import {
  STATIC_PLACEMENT_ASSET_ID,
  STATIC_PLACEMENT_COOLDOWN_MS,
  type PlaceStaticRequest,
  type RemoveStaticRequest,
  type RemoveStaticResult,
  type WorldInfo,
} from '../packages/contracts/src/index.js';
import type { WorldState } from '../packages/protocol/src/index.js';
import type { AuthoritativeWorld } from '../packages/simulation/src/server.js';
import { readAuthoringRelease } from '../apps/server/src/layout/release.js';
import { StaticPlacementRejected } from '../apps/server/src/layout/placement-pose.js';
import {
  profilePlacementGeometry,
  profilePlacementIsBlocked,
} from './helpers/static-layout-profile-placement.js';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture, loginAccount, responseCookie } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';
import { prepareSdk } from './helpers/prepare.js';

if (existsSync('.env')) loadEnvFile('.env');
const databaseUrl = process.env.SU_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
assert.ok(databaseUrl, 'A local test database is required');
const count = Number(process.env.SU_LAYOUT_PROFILE_OPERATIONS ?? 30);
const clientCounts = (process.env.SU_LAYOUT_PROFILE_CLIENTS ?? '2,3').split(',').map(Number);
const output = process.env.SU_LAYOUT_PROFILE_OUTPUT ?? 'output/static-layout-live-profile';
const viewport = {
  width: Number(process.env.SU_LAYOUT_PROFILE_VIEWPORT_WIDTH ?? 960),
  height: Number(process.env.SU_LAYOUT_PROFILE_VIEWPORT_HEIGHT ?? 600),
};
assert.ok(Object.values(viewport).every((value) => Number.isInteger(value) && value > 0));
assert.ok(Number.isInteger(count) && count > 0);
assert.ok(clientCounts.every((value) => value === 2 || value === 3));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>, timeout = 30_000) {
  const started = performance.now();
  while (!(await predicate())) {
    assert.ok(performance.now() - started < timeout, 'Live profile operation timed out');
    await wait(10);
  }
}
const percentile = (values: number[], p: number) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
};
const profile: any = {
  environment: {
    date: new Date().toISOString(),
    node: process.version,
    platform: platform(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    renderer: 'Chromium SwiftShader',
    quality: 'economy',
    viewport,
    world: 'ring-block',
    server: 'source TS, separate preparation worker',
    observations:
      'SDK author; real browser observers. Cooldown excluded. No hardware-GPU FPS claim.',
  },
  runs: [],
};
await mkdir(output, { recursive: true });
for (const clients of clientCounts) {
  const directory = await mkdtemp(join(tmpdir(), 'su-layout-profile-'));
  const worldDirectory = join(directory, 'world');
  await cp('dist/worlds/ring-block', worldDirectory, { recursive: true });
  const fixture = await createAccountFixture(databaseUrl);
  let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
  let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
  let owner: Room<WorldState> | undefined;
  let sampler: ReturnType<typeof setInterval> | undefined;
  let moving = true;
  const errors: string[] = [];
  const pages: Page[] = [];
  const run: any = { clients, operations: [], samples: [], errors };
  profile.runs.push(run);
  try {
    app = await createGameServer({
      port: 0,
      accounts: fixture,
      worldDirectory,
      modelCatalogDirectory: 'dist/model-catalogs/ring-block',
    });
    fixture.config.publicOrigin = app.url;
    const release = await readAuthoringRelease(worldDirectory);
    if (process.env.SU_LAYOUT_PROFILE_REQUIRE_TERRAIN === 'true')
      assert.equal(
        release.terrain?.formatVersion,
        2,
        'Rebuild the accepted terrain world before profiling',
      );
    run.terrain = release.terrain
      ? {
          formatVersion: release.terrain.formatVersion,
          groundIds:
            release.terrain.formatVersion === 2
              ? release.terrain.placementGroundIds?.length
              : undefined,
        }
      : null;
    const discover = (): Promise<WorldInfo> => fetch(app!.url + '/api/world').then((r) => r.json());
    let info = await discover();
    const cookie = responseCookie(
      (await loginAccount(app.url, `profile-${clients}`)).result,
      'su_session',
    );
    owner = await new Client(app.url, { headers: { Cookie: cookie } }).joinById<WorldState>(
      info.roomId,
      { ...info, accountMode: 'account' },
    );
    owner.reconnection.enabled = false;
    const replies: RemoveStaticResult[] = [];
    owner.onMessage('staticPlacementResult', (result) => replies.push(result));
    owner.onMessage('staticRemovalResult', (result) => replies.push(result));
    for (const name of ['inventory', 'problem', 'resync']) owner.onMessage(name, () => {});
    prepareSdk(owner);
    await until(() => !!owner!.state?.players?.has(owner!.sessionId));
    browser = await launchTestBrowser({
      channel: 'chromium',
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    });
    const transfers: Array<{ url: string; bytes: number; at: number }> = [];
    const joins: any[] = [];
    for (let n = 1; n < clients; n++) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      pages.push(page);
      page.setDefaultTimeout(90_000);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (response.url().includes('/layouts/')) {
          const bytes = Number(response.headers()['content-length'] ?? 0);
          transfers.push({ url: response.url(), bytes, at: performance.now() });
        }
      });
      await page.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
      const started = performance.now();
      await page.bringToFront();
      await page.goto(app.url + '/?diagnostics=1');
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__?.snapshot().streaming?.backgroundReady === true,
      );
      await page.locator('#join:not([disabled])').click();
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
      );
      joins.push({ observer: n, ms: performance.now() - started });
      await page.waitForTimeout(100);
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__.snapshot().streaming?.backgroundReady === true,
      );
    }
    run.joins = joins;
    const snapshot = (page: Page) =>
      page.evaluate(() => ({
        session: (window as any).__SU_DEBUG__.snapshot(),
        rendering: (window as any).__SU_DEBUG__.report().rendering,
        lifecycle: (window as any).__SU_DEBUG__.buildings().lifecycle,
        primitives: (window as any).__SU_DEBUG__.buildings().primitives,
      }));
    run.before = await Promise.all(pages.map(snapshot));
    const observer = pages[0];
    await observer.bringToFront();
    await observer.locator('#world').focus();
    const movement = (async () => {
      const keys = ['d', 'w', 'a', 's'];
      let phase = 0;
      while (moving && !observer.isClosed()) {
        const key = keys[phase++ % keys.length];
        await observer.keyboard.down(key).catch(() => {});
        await wait(350);
        await observer.keyboard.up(key).catch(() => {});
      }
    })();
    const started = performance.now();
    let lastSample = started;
    sampler = setInterval(() => {
      const now = performance.now();
      run.samples.push({
        t: now - started,
        gap: now - lastSample,
        tick: app!.room.state.serverTick,
        paused: app!.room.state.paused,
        pending:
          (app!.room as unknown as { layoutTransition?: { pending: Set<string> } }).layoutTransition
            ?.pending.size ?? 0,
        players: [...app!.room.state.players.entries()].map(([id, p]) => ({
          id,
          x: p.x,
          y: p.y,
          z: p.z,
        })),
      });
      lastSample = now;
    }, 10);
    const world = (app.room as unknown as { world: AuthoritativeWorld }).world;
    let position: { x: number; z: number } | undefined;
    // Keep the edit in the warm spawn neighborhood but away from all protected spawn points.
    const spawns = world.getSnapshot().players.map((p) => p.position);
    for (let z = 35; z >= -15 && !position; z -= 3)
      for (let x = -30; x <= 30; x += 3) {
        if (spawns.some((p) => Math.hypot(p.x - x, p.z - z) < 12)) continue;
        const candidate = {
          operationId: randomUUID(),
          position: { x, z },
          yawStep: 0,
          assetId: STATIC_PLACEMENT_ASSET_ID,
        } as PlaceStaticRequest;
        try {
          const candidateGeometry = profilePlacementGeometry(release, candidate);
          if (!profilePlacementIsBlocked(world, release, candidateGeometry)) {
            position = { x, z };
            break;
          }
        } catch (error) {
          if (!(error instanceof StaticPlacementRejected)) throw error;
        }
      }
    assert.ok(position, 'A free warm-neighborhood position is required');
    run.position = position;
    const baseBodies = app.room.diagnostics().bodies;
    run.expectedInstancesCreated = 0;
    run.expectedModelImports = 0;
    let nextAllowed = 0;
    const operation = async (kind: 'place' | 'remove', entityId?: string, measured = true) => {
      await wait(Math.max(0, nextAllowed - performance.now()));
      await until(() => !app!.room.diagnostics().staticPlacementBusy);
      info = await discover();
      const request = {
        operationId: randomUUID(),
        worldEpoch: info.worldEpoch,
        assetReleaseVersion: info.assetReleaseVersion,
        expectedLayoutRevision: info.layoutRevision,
        ...(kind === 'place'
          ? {
              position,
              yawStep: 0,
              assetId: STATIC_PLACEMENT_ASSET_ID,
              placementCatalogVersion: info.placementCatalog!.placementCatalogVersion,
            }
          : { entityId }),
      };
      const begin = performance.now();
      const firstSample = run.samples.length;
      const transferStart = transfers.length;
      const replyIndex = replies.length;
      owner!.send(
        kind === 'place' ? 'placeStatic' : 'removeStatic',
        request as PlaceStaticRequest | RemoveStaticRequest,
      );
      await until(() => replies.length > replyIndex);
      const reply = replies[replyIndex];
      if (!reply.ok) throw new Error(`${kind} failed: ${reply.code}`);
      const committed = performance.now();
      nextAllowed = committed + STATIC_PLACEMENT_COOLDOWN_MS + 30;
      await until(() => !app!.room.diagnostics().staticPlacementBusy);
      const completed = performance.now();
      const metrics = structuredClone(app!.room.diagnostics().staticPlacement)!;
      const preparationSamples = run.samples
        .slice(firstSample)
        .filter((sample: any) => sample.t < metrics.pauseStarted - started);
      const observerId = run.before[0].session.sessionId;
      const positions = preparationSamples
        .map((sample: any) => sample.players.find((player: any) => player.id === observerId))
        .filter(Boolean);
      let distance = 0;
      for (let n = 1; n < positions.length; n++)
        distance += Math.hypot(
          positions[n].x - positions[n - 1].x,
          positions[n].z - positions[n - 1].z,
        );
      const definition = (
        app!.room as unknown as {
          definition: import('../packages/contracts/src/index.js').WorldDefinition;
        }
      ).definition;
      const persisted = (
        await fixture.pool.query(
          'SELECT enabled,position_x,position_y,position_z FROM world_static_instances WHERE entity_id=$1',
          [reply.entityId],
        )
      ).rows[0];
      assert.ok(persisted, 'The owner is persisted');
      let geometryVerification: unknown;
      if (kind === 'place') {
        const expected = profilePlacementGeometry(release, request as PlaceStaticRequest);
        assert.ok(
          Math.abs(persisted.position_y - expected.owner.position.y) < 1e-8,
          'SQL keeps the server-resolved terrain height',
        );
        assert.equal(persisted.enabled, true);
        if (process.env.SU_LAYOUT_PROFILE_REQUIRE_TERRAIN === 'true')
          assert.ok(
            Math.abs(persisted.position_y) > 1e-8,
            'Terrain placement does not fall back to Y zero',
          );
        for (const geometry of expected.geometry)
          assert.ok(
            definition.buildings.some((item) => item.entityId === geometry.instance.entityId),
            'The owner and all declared supports are active',
          );
        const bodies = expected.geometry.filter((item) => item.asset.colliders.length).length;
        assert.equal(
          app!.room.diagnostics().bodies,
          baseBodies + bodies,
          'Exactly the owner and support bodies were added',
        );
        run.expectedInstancesCreated += expected.geometry.length;
        run.expectedModelImports += expected.geometry.length - 1;
        geometryVerification = {
          ownerY: persisted.position_y,
          activeIds: expected.geometry.map((item) => item.instance.entityId),
          bodiesAdded: bodies,
        };
      } else {
        assert.equal(persisted.enabled, false);
        assert.ok(
          !definition.buildings.some((item) => item.entityId === reply.entityId),
          'The disabled owner is absent',
        );
        assert.equal(
          app!.room.diagnostics().bodies,
          baseBodies,
          'Removal releases all owner/support bodies',
        );
      }
      const record = {
        kind,
        geometryVerification,
        measured,
        operationId: request.operationId,
        revision: reply.layoutRevision,
        committedMs: committed - begin,
        clientReadyMs: Object.fromEntries(
          Object.entries(metrics.clients).map(([id, delay]) => [
            id,
            metrics.pauseStarted + delay - begin,
          ]),
        ),
        browserReadyMs: run.before.map(
          (observer: any) =>
            metrics.pauseStarted + metrics.clients[observer.session.sessionId] - begin,
        ),
        appliedMs: completed - begin,
        server: metrics,
        preparationMotion: {
          ticks: preparationSamples.length
            ? preparationSamples.at(-1).tick - preparationSamples[0].tick
            : 0,
          distance,
          maxEventLoopGapMs: Math.max(0, ...preparationSamples.map((sample: any) => sample.gap)),
        },
        sampleStart: firstSample,
        sampleEnd: run.samples.length,
        transfer: transfers.slice(transferStart),
      };
      run.operations.push(record);
      if (measured)
        console.log(
          `profile clients=${clients} ${kind} #${run.operations.filter((value: any) => value.measured && value.kind === kind).length} pause=${record.server?.pauseMs?.toFixed(1)}ms applied=${record.appliedMs.toFixed(1)}ms`,
        );
      await writeFile(
        join(output, `clients-${clients}-progress.json`),
        JSON.stringify({ clients, operations: run.operations, errors }, null, 2),
      );
      return reply.entityId;
    };
    let delayNextManifest = true;
    await pages.at(-1)!.route('**/layouts/**/manifest.json', async (route) => {
      if (delayNextManifest) {
        delayNextManifest = false;
        await wait(5000);
      }
      await route.continue();
    });
    const delayedEntity = await operation('place', undefined, false);
    await pages.at(-1)!.unroute('**/layouts/**/manifest.json');
    await operation('remove', delayedEntity, false);
    for (let n = 0; n < count; n++) {
      const entity = await operation('place');
      await operation('remove', entity);
    }
    moving = false;
    await movement;
    clearInterval(sampler);
    sampler = undefined;
    run.after = await Promise.all(pages.map(snapshot));
    const slow = run.operations[0];
    const delayedSamples = run.samples
      .slice(slow.sampleStart, slow.sampleEnd)
      .filter((sample: any) => sample.pending > 0 && !sample.paused);
    const observerId = run.before[0].session.sessionId;
    const positions = delayedSamples
      .map((sample: any) => sample.players.find((player: any) => player.id === observerId))
      .filter(Boolean);
    let distance = 0;
    for (let n = 1; n < positions.length; n++)
      distance += Math.hypot(
        positions[n].x - positions[n - 1].x,
        positions[n].z - positions[n - 1].z,
      );
    run.slowClient = {
      delayMs: 5000,
      appliedMs: slow.appliedMs,
      pauseMs: slow.server.pauseMs,
      simulationTicks:
        Math.max(...delayedSamples.map((sample: any) => sample.tick)) -
        Math.min(...delayedSamples.map((sample: any) => sample.tick)),
      healthyObserverDistance: clients === 3 ? distance : null,
    };
    assert.ok(
      run.slowClient.simulationTicks > 200,
      'Simulation advances while a client is delayed',
    );
    if (clients === 3)
      assert.ok(
        distance > 0.2,
        'The healthy browser observer moves while the other client is delayed',
      );
    run.instanceChanges = run.after.map((value: any, index: number) => ({
      observer: index + 1,
      modelImports:
        value.lifecycle && value.lifecycle.modelImports - run.before[index].lifecycle.modelImports,
      instancesCreated:
        value.lifecycle &&
        value.lifecycle.instancesCreated - run.before[index].lifecycle.instancesCreated,
      instancesRemoved:
        value.lifecycle &&
        value.lifecycle.instancesRemoved - run.before[index].lifecycle.instancesRemoved,
      primitivesCreated:
        value.primitives &&
        value.primitives.instancesCreated - run.before[index].primitives.instancesCreated,
      primitivesRemoved:
        value.primitives &&
        value.primitives.instancesRemoved - run.before[index].primitives.instancesRemoved,
    }));
    for (const changes of run.instanceChanges) {
      if (changes.modelImports === undefined) continue;
      assert.equal(
        changes.modelImports,
        run.expectedModelImports,
        'Only new generated support models are imported',
      );
      assert.equal(
        changes.instancesCreated,
        run.expectedInstancesCreated,
        'Only the owner and its declared support instances are created',
      );
      assert.equal(
        changes.instancesRemoved,
        run.expectedInstancesCreated,
        'Only the owner and its declared support instances are released',
      );
      assert.equal(
        changes.primitivesCreated,
        0,
        'Unchanged ground primitives survive every publication',
      );
      assert.equal(changes.primitivesRemoved, 0, 'Unchanged ground primitives keep their holds');
    }
    run.eventLoop = app.room.diagnostics().eventLoop;
    run.summary = Object.fromEntries(
      ['place', 'remove'].map((kind) => {
        const operations = run.operations.filter(
          (value: any) => value.kind === kind && value.measured,
        );
        return [
          kind,
          {
            count: operations.length,
            preparationSimulationTicksMin: Math.min(
              ...operations.map((value: any) => value.preparationMotion.ticks),
            ),
            preparationMovingOperations: operations.filter(
              (value: any) => value.preparationMotion.distance > 0.05,
            ).length,
            maximumPreparationEventLoopGapMs: Math.max(
              ...operations.map((value: any) => value.preparationMotion.maxEventLoopGapMs),
            ),
            pauseP95Ms: percentile(
              operations.map((value: any) => value.server.pauseMs),
              0.95,
            ),
            pauseMaxMs: Math.max(...operations.map((value: any) => value.server.pauseMs)),
            committedP95Ms: percentile(
              operations.map((value: any) => value.committedMs),
              0.95,
            ),
            browserReadyP95Ms: percentile(
              operations.map((value: any) => Math.max(...value.browserReadyMs)),
              0.95,
            ),
            editorSlotIdleP95Ms: percentile(
              operations.map((value: any) => value.appliedMs),
              0.95,
            ),
            allClientsAppliedP95Ms: percentile(
              operations.map((value: any) => value.appliedMs),
              0.95,
            ),
          },
        ];
      }),
    );
    assert.deepEqual(errors, []);
    assert.ok(
      run.operations[0].appliedMs > 4900,
      'The slow-client probe delayed publication application',
    );
    for (let n = 0; n < pages.length; n++) {
      assert.equal(
        run.after[n].session.predictionWorlds,
        run.before[n].session.predictionWorlds,
        'Live operations preserve the prediction world',
      );
    }
  } catch (error) {
    run.failure = String(error);
    run.failureDiagnostics = await Promise.all(
      pages.map((page) =>
        page.evaluate(() => (window as any).__SU_DEBUG__?.snapshot()).catch(() => null),
      ),
    );
    throw error;
  } finally {
    moving = false;
    if (sampler) clearInterval(sampler);
    await writeFile(join(output, `clients-${clients}.json`), JSON.stringify(run, null, 2));
    await writeFile(join(output, 'profile.json'), JSON.stringify(profile, null, 2));
    await owner?.leave().catch(() => {});
    await browser?.close();
    await app?.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    profile.runs.map((run: any) => ({ clients: run.clients, summary: run.summary })),
    null,
    2,
  ),
);
