import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { mkdir, readlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import type { Page } from 'playwright';
import { createDelayRelay, type NetworkProfile } from './helpers/tcp-delay.js';

type Position = { x: number; y: number; z: number };
type Diagnostic = {
  connection: string;
  correctionCount: number;
  correctionP95: number;
  correctionMax: number;
  lastCorrection?: { sequence: number; magnitude: number };
  correctionSamples?: { sequence: number; magnitude: number }[];
  renderedCratePosition?: Position;
  rttMs: number;
  pendingInputs: number;
  stalled: boolean;
  serverTick: number;
  authoritative: { entityId: string; position: Position; revision: number };
  predicted: { position: Position } | null;
  crate: { position: Position; velocity: Position; revision: number };
};
const externalTarget = process.env.SU_TEST_URL ? new URL(process.env.SU_TEST_URL) : undefined;
const profiles: NetworkProfile[] = [
  { name: 'rtt50', rttMs: 50, jitterMs: 0 },
  { name: 'rtt100-jitter20', rttMs: 100, jitterMs: 20 },
  { name: 'rtt200', rttMs: 200, jitterMs: 0 },
];
const kernelNetem = process.env.SU_TEST_NETWORK_MODE === 'netem';
if (kernelNetem) profiles.push({ name: 'rtt200-loss1', rttMs: 200, jitterMs: 20 });
const selectedProfiles = process.env.SU_TEST_PROFILE
  ? profiles.filter((p) => p.name === process.env.SU_TEST_PROFILE)
  : profiles;
assert.ok(selectedProfiles.length, 'SU_TEST_PROFILE must match a known profile');
const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const horizontalDistance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.z - b.z);
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ??
  0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshot = (page: Page): Promise<Diagnostic> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const activeKeys = new Map<Page, string[]>();
async function keys(page: Page, next: string[]) {
  const before = activeKeys.get(page) ?? [];
  for (const key of before) if (!next.includes(key)) await page.keyboard.up(key);
  for (const key of next) if (!before.includes(key)) await page.keyboard.down(key);
  activeKeys.set(page, next);
}
function axisKeys(axis: 'x' | 'z', sign: number): string[] {
  return axis === 'x' ? (sign > 0 ? ['d', 's'] : ['w', 'a']) : sign > 0 ? ['a', 's'] : ['w', 'd'];
}
async function navigate(page: Page, target: { x: number; z: number }, tolerance = 0.22) {
  const deadline = Date.now() + 18_000;
  let closest = Infinity;
  while (Date.now() < deadline) {
    const state = await snapshot(page);
    assert.ok(['playing', 'waiting', 'preparing'].includes(state.connection));
    if (!state.predicted || state.stalled || state.connection !== 'playing') {
      await keys(page, []);
      await sleep(35);
      continue;
    }
    const position = state.predicted.position;
    const dx = target.x - position.x,
      dz = target.z - position.z;
    closest = Math.min(closest, Math.hypot(dx, dz));
    if (Math.hypot(dx, dz) < tolerance) {
      await keys(page, []);
      await sleep(350);
      return;
    }
    await keys(page, Math.abs(dx) > Math.abs(dz) ? axisKeys('x', dx) : axisKeys('z', dz));
    await sleep(35);
  }
  await keys(page, []);
  throw new Error(
    `Keyboard navigation failed at target ${JSON.stringify(target)}; closest ${closest}; actual ${JSON.stringify((await snapshot(page)).authoritative.position)}`,
  );
}
async function measure(pages: Page[], durationMs: number, action: () => Promise<void>) {
  const initial = await Promise.all(pages.map(snapshot));
  const lastSequences = initial.map((s) => s.correctionCount);
  const samples: number[][] = pages.map(() => []);
  const rtts: number[][] = pages.map(() => []);
  let maxPendingInputs = 0,
    stalledSamples = 0,
    observations = 0;
  await action();
  const start = performance.now();
  while (performance.now() - start < durationMs) {
    const states = await Promise.all(pages.map(snapshot));
    states.forEach((state, index) => {
      assert.ok(['playing', 'waiting'].includes(state.connection));
      maxPendingInputs = Math.max(maxPendingInputs, state.pendingInputs);
      stalledSamples += Number(state.stalled);
      observations++;
      if (state.rttMs > 0) rtts[index].push(state.rttMs);
      const corrections =
        state.correctionSamples ?? (state.lastCorrection ? [state.lastCorrection] : []);
      assert.ok(
        corrections.length || state.correctionCount === 0,
        'T03 requires read-only correction samples or lastCorrection diagnostics',
      );
      for (const correction of corrections)
        if (correction.sequence > lastSequences[index]) {
          samples[index].push(correction.magnitude);
          lastSequences[index] = correction.sequence;
        }
    });
    await sleep(30);
  }
  await Promise.all(pages.map((page) => keys(page, [])));
  const final = await Promise.all(pages.map(snapshot));
  // Read the bounded native-reconciliation event history once per phase. Polling
  // lastCorrection alone can omit events between rendered frames.
  const histories: { firstSequence: number; samples: number[] }[] = await Promise.all(
    pages.map((page) => page.evaluate(() => (window as any).__SU_DEBUG__.corrections())),
  );
  const corrections = histories.map((history, index) => {
    const values = history.samples.filter(
      (_value, offset) =>
        history.firstSequence + offset > initial[index].correctionCount &&
        history.firstSequence + offset <= final[index].correctionCount,
    );
    const emitted = final[index].correctionCount - initial[index].correctionCount;
    assert.equal(values.length, emitted, 'all correction events in the phase are retained');
    return {
      samples: values.length,
      emitted,
      p95: percentile(values, 0.95),
      max: Math.max(0, ...values),
    };
  });
  console.log(
    JSON.stringify({
      measurement: {
        corrections,
        maxPendingInputs,
        stalledSamples,
        observations,
        rtts: rtts.map((v) => percentile(v, 0.5)),
      },
    }),
  );
  assert.ok(
    corrections.every((c) => c.samples > 10),
    `enough correction events must be measured: ${JSON.stringify(corrections)}`,
  );
  assert.ok(maxPendingInputs <= 32, `bounded prediction history: ${maxPendingInputs}`);
  return {
    durationMs: performance.now() - start,
    corrections,
    rttMedianMs: rtts.map((v) => percentile(v, 0.5)),
    maxPendingInputs,
    stalledSamples,
    observations,
  };
}
async function convergence(pages: Page[]) {
  const deadline = Date.now() + 10_000;
  let stableSince = 0;
  let firstWithinBudgetMs: number | undefined;
  while (Date.now() < deadline) {
    const states = await Promise.all(pages.map(snapshot));
    const resting = states.every(
      (s) => Math.hypot(s.crate.velocity.x, s.crate.velocity.y, s.crate.velocity.z) < 0.04,
    );
    if (!resting) {
      stableSince = 0;
      firstWithinBudgetMs = undefined;
    } else if (!stableSince) stableSince = performance.now();
    if (stableSince) {
      const errors = states.map((s) => {
        assert.ok(
          s.renderedCratePosition,
          'read-only rendered crate position diagnostics are required',
        );
        return distance(s.renderedCratePosition, s.crate.position);
      });
      const disagreement = distance(states[0].crate.position, states[1].crate.position);
      if (errors.every((e) => e < 0.1) && disagreement < 0.1)
        firstWithinBudgetMs ??= performance.now() - stableSince;
      if (performance.now() - stableSince < 500) {
        await sleep(25);
        continue;
      }
      assert.ok(
        errors.every((e) => e < 0.1),
        `crate display convergence: ${errors}`,
      );
      assert.ok(disagreement < 0.1, `clients agree on stopped crate: ${disagreement}`);
      assert.ok(
        firstWithinBudgetMs !== undefined && firstWithinBudgetMs <= 500,
        `stopped crate display must converge within 500ms: ${firstWithinBudgetMs}`,
      );
      return {
        firstWithinBudgetMs,
        afterRestingMs: performance.now() - stableSince,
        displayErrorsM: errors,
        clientDisagreementM: disagreement,
      };
    }
    await sleep(25);
  }
  throw new Error('Crate did not settle within 10 seconds after releasing input');
}
await mkdir('output/playwright/network', { recursive: true });
const browser = await launchTestBrowser({
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const results = [];
try {
  for (const profile of selectedProfiles) {
    const ownedServer = externalTarget
      ? undefined
      : await (await import('../apps/server/src/index.js')).createGameServer({ port: 0 });
    const target = externalTarget ?? new URL(ownedServer!.url);
    const relay = kernelNetem
      ? {
          url: target.origin,
          metrics: () => ({ mode: 'isolated-kernel-netem', lossPercent: 1 }),
          close: async () => {},
        }
      : await createDelayRelay(target, profile);
    const contexts = await Promise.all(
      [0, 1].map(() =>
        browser.newContext({
          viewport: { width: 800, height: 600 },
          recordVideo: {
            dir: `output/playwright/network/${profile.name}`,
            size: { width: 640, height: 480 },
          },
        }),
      ),
    );
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const errors: string[] = [];
    try {
      for (const page of pages) {
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${relay.url}/?diagnostics=1`);
        await page.locator('#join:not([disabled])').waitFor({ timeout: 20_000 });
        await page.locator('#join').click();
        await page.waitForFunction(
          () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
          undefined,
          { timeout: 20_000 },
        );
      }
      if (kernelNetem) {
        const inheritedNamespace = process.env.SU_TEST_HOST_NETNS;
        assert.ok(
          inheritedNamespace && (await readlink('/proc/self/ns/net')) !== inheritedNamespace,
          'Kernel netem must be launched by browser-network-netem.sh in a fresh network namespace',
        );
        // Load assets before impairment; this check measures the active game
        // and TCP recovery, not cold-download throughput under packet loss.
        execFileSync('tc', [
          'qdisc',
          'add',
          'dev',
          'lo',
          'root',
          'netem',
          'delay',
          '100ms',
          '10ms',
          'distribution',
          'normal',
          'loss',
          '1%',
        ]);
      }
      await sleep(1000);
      if (ownedServer || profile === selectedProfiles[0]) {
        const initialCrate = (await snapshot(pages[0])).crate.position;
        assert.ok(
          Math.hypot(initialCrate.x, initialCrate.z) < 0.2,
          'Network acceptance requires a freshly started physics-lab server (crate at its initial position). Restart the test server before running.',
        );
      }
      // Walk against a static wall independently of the dynamic crate.
      await navigate(pages[0], { x: -4, z: 2 });
      await navigate(pages[0], { x: -4, z: -4 });
      const wall = await measure(pages, 4000, () => keys(pages[0], axisKeys('x', -1)));
      const wallPosition = (await snapshot(pages[0])).authoritative.position;
      assert.ok(
        wallPosition.x > -6.35 && wallPosition.x < -6.1,
        `static wall blocks player: ${wallPosition.x}`,
      );
      // Leave the corner through its southern opening, then approach the crate from one side.
      await navigate(pages[0], { x: -4, z: -4 });
      await navigate(pages[0], { x: -4, z: 2 });
      const crateBefore = (await snapshot(pages[0])).crate.position;
      // Push into the clear southern half of physics-lab. A long northward push
      // can put the subsequent opposite-side waypoint inside house-b (z < -8).
      const direction = 1;
      const behindZ = crateBefore.z - direction * 2;
      await Promise.all(
        pages.map((page, index) =>
          navigate(page, { x: crateBefore.x + (index === 0 ? -1.5 : 1.5), z: behindZ }),
        ),
      );
      await Promise.all(
        pages.map((page, index) =>
          navigate(page, { x: crateBefore.x + (index === 0 ? -0.38 : 0.38), z: behindZ }),
        ),
      );
      const together = await measure(pages, 4500, async () => {
        await Promise.all(pages.map((page) => keys(page, axisKeys('z', direction))));
      });
      const crateAfter = (await snapshot(pages[0])).crate.position;
      const crateTravelM = horizontalDistance(crateBefore, crateAfter);
      // A half-box displacement proves physical interaction; v0.1 does not set
      // a minimum crate speed or travel distance for a fixed push duration.
      assert.ok(crateTravelM > 0.5, `two players actually push the crate: ${crateTravelM}`);
      const togetherConvergence = await convergence(pages);
      // Opposed contact: use the clear central north/south corridor. The second
      // player walks around the east side; neither route crosses through the box.
      const center = (await snapshot(pages[0])).crate.position;
      // A rotating box can deflect either actor past it. First back away on the
      // actor's current side, then walk an explicit east corridor, not a diagonal through the box.
      async function approach(page: Page, sign: number) {
        const data = await snapshot(page);
        const own = (data.predicted ?? data.authoritative).position;
        const clearZ = center.z + (own.z >= center.z ? 3 : -3);
        const clearX = center.x + 2.5;
        await navigate(page, { x: own.x, z: clearZ });
        await navigate(page, { x: clearX, z: clearZ });
        await navigate(page, { x: clearX, z: center.z + sign * 2 });
        await navigate(page, { x: center.x, z: center.z + sign * 2 });
      }
      await approach(pages[1], direction);
      await approach(pages[0], -direction);
      const opposed = await measure(pages, 4500, async () => {
        await Promise.all(
          pages.map((page, index) =>
            keys(page, axisKeys('z', index === 0 ? direction : -direction)),
          ),
        );
      });
      const opposedConvergence = await convergence(pages);
      if (profile.rttMs <= 100) {
        assert.ok(
          wall.corrections[0].p95 <= 0.2,
          `static walking correction p95 ${wall.corrections[0].p95}`,
        );
        assert.ok(
          [...together.corrections, ...opposed.corrections].every((c) => c.p95 <= 0.5),
          'crate interaction correction p95 <= 0.5 m',
        );
      }
      assert.deepEqual(errors, []);
      await pages[0].screenshot({ path: `output/playwright/network/${profile.name}.png` });
      const report = {
        profile,
        wall,
        wallPosition,
        together,
        crateTravelM,
        togetherConvergence,
        opposed,
        opposedConvergence,
        relay: relay.metrics(),
        errors,
        result: 'passed',
      };
      results.push(report);
      await writeFile(
        `output/playwright/network/${profile.name}.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.log(JSON.stringify(report));
    } catch (error) {
      await pages[0]
        .screenshot({ path: `output/playwright/network/${profile.name}-failure.png` })
        .catch(() => {});
      await writeFile(
        `output/playwright/network/${profile.name}-failure.json`,
        `${JSON.stringify({ profile, error: String(error), states: await Promise.all(pages.map((page) => snapshot(page).catch(() => null))) }, null, 2)}\n`,
      );
      throw error;
    } finally {
      for (const page of pages) {
        await keys(page, []).catch(() => {});
        await page
          .locator('#leave')
          .click({ timeout: 2000 })
          .catch(() => {});
      }
      await Promise.all(contexts.map((context) => context.close()));
      await relay.close();
      await ownedServer?.close();
    }
  }
  await writeFile(
    `output/playwright/network/${kernelNetem ? 'netem-results' : 'results'}.json`,
    `${JSON.stringify({ date: new Date().toISOString(), target: externalTarget?.origin ?? 'Fresh isolated local server per profile', browser: browser.version(), profiles: results, note: kernelNetem ? 'Isolated Linux network namespace, loopback kernel netem: 100ms delay ±10ms each way, 1% packet loss; TCP retransmission is real.' : 'TCP byte-stream latency relay; packet loss and retransmission are not simulated.' }, null, 2)}\n`,
  );
} finally {
  await browser.close();
}
