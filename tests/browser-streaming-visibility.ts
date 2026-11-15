import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { rotateCamera } from './helpers/camera.js';
import { hudClick } from './helpers/hud.js';

// Один функциональный городской маршрут; это не аппаратный бенчмарк и не A/B-стенд.
assert.ok(process.env.SU_TEST_DATABASE_URL, 'SU_TEST_DATABASE_URL is required');
const output = process.env.SU_VISIBILITY_OUTPUT ?? 'output/playwright/streaming-visibility';
const timeout = Number(process.env.SU_VISIBILITY_TIMEOUT_MS ?? 180_000);
const app = await createGameServer({ port: 0, worldDirectory: 'dist/worlds/ring-block' });
const browser = await launchTestBrowser({
  renderer: process.env.SU_TEST_RENDERER === 'hardware' ? 'default' : 'software',
  channel: 'chromium',
});
const observations: unknown[] = [];
const errors: string[] = [];
const httpErrors: string[] = [];
let page: Page | undefined;
const report = (page: Page) =>
  page.evaluate(() => ({ at: performance.now(), report: (window as any).__SU_DEBUG__.report() }));
const snapshot = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());

async function ready(page: Page, connection: 'ready' | 'playing') {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.waitForFunction(
    (connection) => {
      const r = (window as any).__SU_DEBUG__?.report();
      return (
        r?.metrics.connection === connection &&
        r.streaming?.backgroundReady &&
        r.streaming.groups
          .filter((g: any) => g.visible || g.pinned)
          .every((g: any) => g.current === g.wanted && !g.error && !g.preparing && !g.pending)
      );
    },
    connection,
    { timeout, polling: 100 },
  );
  const { report: r } = await report(page);
  assert.ok(
    r.streaming.groups.some((g: any) => g.visible),
    'visible city groups are resident',
  );
  assert.ok(r.rendering.drawCalls > 0, 'the prepared city is actually rendered');
  assert.equal(r.streaming.failed, false);
  assert.equal(r.streaming.cleanupErrors, 0);
  assert.ok(r.streaming.resources.cacheBytes <= 64 * 1024 * 1024);
  if (connection === 'playing') assert.equal(r.streaming.criticalReady, true);
}

async function record(page: Page, phase: string, screenshot = false) {
  const value = await report(page);
  observations.push({ phase, ...value });
  await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
  if (screenshot) await page.screenshot({ path: join(output, `${phase}.png`) });
  console.log(`Passed: ${phase}`);
  return value.report;
}

async function zoom(page: Page, target: 1 | 30) {
  const current = (await report(page)).report.rendering.camera.zoom;
  await page.locator('#world').focus();
  await page
    .locator('#world')
    .dispatchEvent('wheel', { deltaY: Math.log(target / current) * 1000 });
  await page.waitForFunction(
    (target) =>
      Math.abs((window as any).__SU_DEBUG__.report().rendering.camera.zoom - target) < 1e-5,
    target,
    { timeout },
  );
}

async function releasedAfterZoom(page: Page, cycle: number) {
  await zoom(page, 30);
  await ready(page, 'playing');
  const far = await record(page, `cycle-${cycle}-far`);
  const farIds: string[] = far.streaming.groups.filter((g: any) => g.wanted).map((g: any) => g.id);
  const zoomStarted = (await report(page)).at;
  await zoom(page, 1);
  await page.waitForFunction(
    (ids) =>
      (window as any).__SU_DEBUG__
        .report()
        .streaming.groups.some(
          (g: any) =>
            ids.includes(g.id) &&
            g.current &&
            !g.wanted &&
            !g.retained &&
            !g.pinned &&
            g.releaseAt !== undefined,
        ),
    farIds,
    { timeout, polling: 50 },
  );
  const waiting = await report(page);
  const departed = waiting.report.streaming.groups.filter(
    (g: any) =>
      farIds.includes(g.id) &&
      g.current &&
      !g.wanted &&
      !g.retained &&
      !g.pinned &&
      g.releaseAt !== undefined,
  );
  const ids: string[] = departed.map((g: any) => g.id);
  assert.ok(ids.length > 0, 'zooming in abandons groups outside the retention area');
  assert.ok(
    departed.every((g: any) => g.releaseAt >= zoomStarted + 5000),
    'abandoned groups receive the five-second release delay',
  );
  observations.push({ phase: `cycle-${cycle}-release-pending`, ids, ...waiting });
  await page.waitForFunction(
    (ids) => {
      const groups = (window as any).__SU_DEBUG__.report().streaming.groups;
      return ids.every((id) => !groups.some((g: any) => g.id === id));
    },
    ids,
    { timeout, polling: 100 },
  );
  await ready(page, 'playing');
  const current = await record(page, `cycle-${cycle}-released`, true);
  return current.streaming.groups
    .filter((g: any) => g.wanted)
    .map((g: any) => [g.id, g.version, g.current])
    .sort((a: string[], b: string[]) => a[0].localeCompare(b[0]));
}

try {
  await mkdir(output, { recursive: true });
  for (const file of ['result.json', 'failure.json', 'failure.png'])
    await rm(join(output, file), { force: true });
  page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.setDefaultTimeout(timeout);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/worlds/'))
      httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  await page.goto(`${app.url}/?diagnostics=1&time=12&initialZoom=1`);
  await page.locator('#join:not([disabled])').waitFor();
  await ready(page, 'ready');
  assert.equal(app.room.diagnostics().sessions, 0, 'preview does not reserve a player seat');
  assert.equal((await snapshot(page)).physics.bodies, 0, 'preview does not load local physics');
  await record(page, 'preview', true);

  await page.locator('#join').click();
  await ready(page, 'playing');
  const origin = (await snapshot(page)).authoritative.position;
  const route: unknown[] = [];
  for (const key of ['w', 'd', 's', 'a']) {
    await page.locator('#world').focus();
    await page.keyboard.down(key);
    try {
      await page.waitForTimeout(900);
    } finally {
      await page.keyboard.up(key);
    }
    route.push((await snapshot(page)).authoritative.position);
  }
  assert.ok(
    route.some((p: any) => Math.hypot(p.x - origin.x, p.z - origin.z) > 0.15),
    'walking changes the authoritative position',
  );
  observations.push({ phase: 'walk-route', origin, route });
  await rotateCamera(page, Math.PI);
  await ready(page, 'playing');
  await record(page, 'overview-turn', true);

  const first = await releasedAfterZoom(page, 1);
  const second = await releasedAfterZoom(page, 2);
  assert.deepEqual(second, first, 'repeating zoom and return restores the same required groups');

  await page.locator('#world').focus();
  await page.keyboard.press('v');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().view === 'first-person');
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForTimeout(900);
    if (await page.evaluate(() => !!document.pointerLockElement)) break;
    await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable);
    await page.locator('#world').click({ position: { x: 320, y: 180 } });
  }
  await page.waitForFunction(() => !!document.pointerLockElement);
  await ready(page, 'playing');
  await record(page, 'first-person', true);
  await page.mouse.move(320, 180);
  const yaw = (await report(page)).report.rendering.camera.yaw;
  await page.mouse.move(320 + Math.PI / 0.002, 180, { steps: 8 });
  await page.waitForFunction((before) => {
    const current = (window as any).__SU_DEBUG__.report().rendering.camera.yaw;
    return Math.abs(Math.atan2(Math.sin(current - before), Math.cos(current - before))) > 2.5;
  }, yaw);
  await ready(page, 'playing');
  await record(page, 'first-person-turn', true);
  await page.keyboard.press('v');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().view === 'overview');
  await ready(page, 'playing');

  await hudClick(page, '#leave');
  await ready(page, 'ready');
  // Preview readiness covers graphics; unchanged physics retention drains separately.
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().physics.bodies === 0,
    undefined,
    { timeout, polling: 100 },
  );
  assert.equal((await snapshot(page)).physics.bodies, 0);
  assert.equal(app.room.diagnostics().sessions, 0);
  await record(page, 'returned-preview', true);
  assert.deepEqual(errors, []);
  assert.deepEqual(httpErrors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        result: 'passed',
        hardwareAcceptance: false,
        browser: browser.version(),
        phases: observations,
        errors,
        httpErrors,
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  const current = page ? await report(page).catch(() => undefined) : undefined;
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify({ error: String(error), current, errors, httpErrors }, null, 2) + '\n',
  );
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await app.close();
}
