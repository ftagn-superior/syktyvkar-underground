/**
 * S-60 real-download scenario for the diagnostic JSON export. Run against an already started
 * server backed by a dedicated test database (never a production server):
 *
 *   SU_TEST_URL=http://127.0.0.1:2599 SU_TEST_RENDERER=hardware \
 *     node --import tsx tests/browser-diagnostic-export.ts
 *
 * Every file is produced by the real "Download report" button. The script checks the v3
 * contract and writes `summary.json` with coverage/overwrite counters and export costs.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchTestBrowser } from './helpers/browser.js';
import { rotateCamera } from './helpers/camera.js';
import { setRenderQuality } from './helpers/hud.js';

const url = process.env.SU_TEST_URL ?? 'http://127.0.0.1:2567';
const output = process.env.SU_DIAGNOSTIC_OUTPUT ?? 'output/diagnostic-export';
// Full Chromium: first-person view requires pointer lock, unavailable in the headless shell.
const browser = await launchTestBrowser({
  headless: process.env.SU_TEST_HEADED !== '1',
  channel: 'chromium',
  renderer: process.env.SU_TEST_RENDERER === 'hardware' ? 'default' : 'software',
});
const errors: string[] = [];
const exports: Record<string, unknown>[] = [];
const debug = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const ready = (page: Page, timeout = 240_000) =>
  page
    .waitForFunction(
      () => {
        const r = (window as any).__SU_DEBUG__?.report();
        return r?.metrics.connection === 'playing' && r.streaming.criticalReady;
      },
      undefined,
      // A full report per animation frame would itself load the page being measured.
      { timeout, polling: 1000 },
    )
    .catch(async (error) => {
      console.error(
        await page.evaluate(() => {
          const r = (window as any).__SU_DEBUG__?.report();
          return JSON.stringify({
            connection: r?.metrics.connection,
            critical: r?.streaming.criticalReady,
            area: document.getElementById('area-message')?.textContent,
            notice: document.getElementById('notice')?.textContent,
            join: (document.getElementById('join') as HTMLButtonElement)?.disabled,
            joinLabel: document.getElementById('join-label')?.textContent,
            frames: r?.history.frames.total,
            problem: r?.streaming.problem ?? r?.streaming.backgroundProblem,
            preparations: r?.preparations,
            transitions: r?.history.transitions.records
              .slice(-12)
              .map((t: any) => [t.name, t.atMs, JSON.stringify(t.fields)]),
            peaks: Object.fromEntries(
              Object.entries(r?.history.peaks ?? {}).map(([k, v]: any) => [k, v.durationMs]),
            ),
          });
        }),
      );
      throw error;
    });

const joinAttempts: { label: string; attempts: number }[] = [];
/** Enter like a player: a cold T480 spawn can exceed the 15 s server PREPARE_TIMEOUT. */
async function enter(page: Page, label: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await page.locator('#join:not([disabled])').isVisible()) {
      await page.locator('#join').click();
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__.snapshot().connection !== 'ready',
        undefined,
        { timeout: 60_000, polling: 200 },
      );
    }
    const outcome = await page.waitForFunction(
      () => {
        const r = (window as any).__SU_DEBUG__?.report();
        const join = document.getElementById('join') as HTMLButtonElement | null;
        if (r?.metrics.connection === 'playing' && r.streaming.criticalReady) return 'playing';
        return r?.metrics.connection === 'ready' && join && !join.disabled && join.offsetParent
          ? 'retry'
          : false;
      },
      undefined,
      { timeout: 240_000, polling: 1000 },
    );
    if ((await outcome.jsonValue()) === 'playing') {
      joinAttempts.push({ label, attempts: attempt });
      return;
    }
    console.log(
      `${label} attempt ${attempt}:`,
      await page.evaluate(() =>
        JSON.stringify((window as any).__SU_DEBUG__.report().preparations.slice(-1)),
      ),
    );
  }
  throw new Error(`${label}: could not enter after 3 attempts`);
}

async function download(page: Page, label: string) {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    // The click handler builds, serializes and hands the file to the browser synchronously.
    page.evaluate(() => {
      const started = performance.now();
      document.getElementById('download-report')!.click();
      (window as any).__S60_EXPORT_MS__ = performance.now() - started;
    }),
  ]);
  const path = join(output, `${String(exports.length + 1).padStart(2, '0')}-${label}.json`);
  await file.saveAs(path);
  const exportMs = await page.evaluate(() => (window as any).__S60_EXPORT_MS__);
  const text = await readFile(path, 'utf8');
  const report = JSON.parse(text);
  const h = report.history;
  assert.equal(report.formatVersion, 3, label);
  assert.equal(typeof h.runId, 'string', label);
  for (const ring of ['events', 'transitions', 'samples'])
    assert.equal(
      h[ring].records.length,
      Math.min(h[ring].total, h[ring].limit),
      `${label} ${ring}`,
    );
  assert.equal(h.frames.samples.length, h.frames.sampleCount, label);
  assert.equal(h.frames.columns.length, h.frames.samples[0]?.length ?? h.frames.columns.length);
  const ids = h.frames.samples.map((row: number[]) => row[0]);
  assert.ok(
    ids.every((id: number, i: number) => i === 0 || id === ids[i - 1] + 1),
    label,
  );
  const names = (records: { name: string }[]) =>
    records.reduce<Record<string, number>>(
      (all, r) => ((all[r.name] = (all[r.name] ?? 0) + 1), all),
      {},
    );
  const summary = {
    label,
    file: path,
    bytes: (await stat(path)).size,
    exportMs,
    build: report.build,
    server: report.server,
    frames: { ...h.frames, samples: undefined },
    nullIntervals: h.frames.samples.filter((row: unknown[]) => row[2] === null).length,
    events: { ...h.events, records: undefined, names: names(h.events.records) },
    transitions: { ...h.transitions, records: undefined, names: names(h.transitions.records) },
    samples: { ...h.samples, records: undefined },
    peaks: Object.fromEntries(
      Object.entries(h.peaks).map(([name, p]: [string, any]) => [
        name,
        {
          durationMs: p.durationMs,
          atMs: p.atMs,
          frameId: p.frameId,
          startFrameId: p.startFrameId,
        },
      ]),
    ),
    gpuTimer: report.measurements.gpuTimer.status,
    frameP95Ms: report.metrics.frameP95Ms,
  };
  exports.push(summary);
  console.log(
    `${label}: ${summary.bytes} B, ${exportMs.toFixed(1)} ms, frames ${h.frames.sampleCount}/${h.frames.total}, events ${h.events.total} (overwritten ${h.events.overwritten})`,
  );
  return report;
}

try {
  await mkdir(output, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const lobby = await context.newPage();
  lobby.on('pageerror', (error) => errors.push(error.message));
  await lobby.goto(`${url}/?diagnostics=1${process.env.SU_DIAGNOSTIC_QUERY ?? ''}`);
  await lobby.locator('#join:not([disabled])').waitFor({ timeout: 240_000 });
  // Separate tab: in automated full Chromium a download saved from the lobby made the same
  // tab's next spawn preparation hang until PREPARE_TIMEOUT (main and this branch alike).
  await download(lobby, 'preview-before-join');
  await lobby.close();
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/?diagnostics=1${process.env.SU_DIAGNOSTIC_QUERY ?? ''}`);
  await page.locator('#join:not([disabled])').waitFor({ timeout: 240_000 });
  await enter(page, 'first-join');
  const early = await download(page, 'playing-before-hud-warmup');
  assert.equal(early.metrics.frameP95Ms, null, 'HUD p95 is still warming up');
  assert.ok(early.history.frames.validIntervalCount > 0, 'raw frames exist before HUD warmup');

  for (let i = 0; i < 8; i++) await rotateCamera(page, Math.PI / 4);
  await page.locator('#world').dispatchEvent('wheel', { deltaY: -Math.log(30) * 1000 });
  await page
    .waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable)
    .catch(async (error) => {
      console.error(
        await page.evaluate(() =>
          JSON.stringify({
            controls: (window as any).__SU_DEBUG__.controls(),
            connection: (window as any).__SU_DEBUG__.snapshot().connection,
            hidden: document.hidden,
          }),
        ),
      );
      throw error;
    });
  await page.locator('#world').focus();
  await page.keyboard.press('v');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().view === 'first-person');
  await page.waitForTimeout(1500);
  await page.keyboard.press('v');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().view === 'overview');
  await ready(page);
  await download(page, 'after-rotation-both-cameras');

  await setRenderQuality(page, 'economy');
  await page.waitForTimeout(2000);
  await setRenderQuality(page, 'standard');
  await page.waitForTimeout(2000);
  await download(page, 'after-quality-change');

  // Minimizing the browser window hides the page without reloading it.
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  const hidden = await page
    .waitForFunction(() => document.hidden, undefined, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!hidden) errors.push('page did not become hidden in this browser mode');
  await page.waitForTimeout(3000);
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await page.bringToFront();
  await page.waitForFunction(() => !document.hidden);
  await page.waitForTimeout(1500);
  const resumed = await download(page, 'after-hidden-resume');

  // WebGL context loss/restoration through the standard debug extension.
  await page.evaluate(async () => {
    const gl = (document.getElementById('world') as HTMLCanvasElement).getContext('webgl2')!;
    const lose = gl.getExtension('WEBGL_lose_context')!;
    lose.loseContext();
    await new Promise((r) => setTimeout(r, 2000));
    lose.restoreContext();
  });
  await page.waitForFunction(
    () => !document.body.classList.contains('graphics-unavailable'),
    undefined,
    {
      timeout: 60_000,
    },
  );
  await ready(page);
  await page.waitForTimeout(2000);
  const restored = await download(page, 'after-context-restore');

  const before = await debug(page);
  await context.setOffline(true);
  await page.waitForTimeout(4000);
  await context.setOffline(false);
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
    undefined,
    {
      timeout: 120_000,
    },
  );
  await ready(page);
  await page.waitForTimeout(2000);
  const reconnected = await download(page, 'after-offline-reconnect');
  const repeated = await download(page, 'repeated-export');
  assert.equal(repeated.history.runId, reconnected.history.runId, 'export does not reset history');
  assert.ok(repeated.history.frames.total >= reconnected.history.frames.total);

  // Reloading starts a new run. Guests do not exercise authenticated saved-spawn fallback.
  await page.reload();
  // A stored guest session may continue directly; otherwise enter through the lobby again.
  await page.waitForFunction(
    () => {
      const join = document.getElementById('join') as HTMLButtonElement | null;
      return (
        (window as any).__SU_DEBUG__?.snapshot().connection === 'playing' ||
        (join && !join.disabled && join.offsetParent !== null)
      );
    },
    undefined,
    { timeout: 240_000 },
  );
  await enter(page, 'rejoin-after-reload');
  await page.waitForTimeout(3000);
  const rejoined = await download(page, 'after-reload-rejoin');
  assert.notEqual(rejoined.history.runId, repeated.history.runId);

  await writeFile(
    join(output, 'summary.json'),
    JSON.stringify(
      {
        url,
        userAgent: await page.evaluate(() => navigator.userAgent),
        renderer: rejoined.rendering?.renderer ?? null,
        connectionBeforeOffline: before.connection,
        checks: {
          hiddenBoundary: resumed.history.transitions.records.some(
            (r: any) => r.name === 'frame.boundary' && r.fields.reason === 'visibility-resume',
          ),
          contextRestoreBoundary: restored.history.transitions.records.some(
            (r: any) => r.name === 'frame.boundary' && /graphics/.test(r.fields.reason),
          ),
          reconnect: reconnected.history.transitions.records.some(
            (r: any) => r.name === 'connection.reconnect' || r.name === 'connection.join',
          ),
        },
        joinAttempts,
        errors,
        exports,
      },
      null,
      2,
    ) + '\n',
  );
  assert.deepEqual(errors, []);
  console.log(`Diagnostic export scenario passed; files in ${output}`);
} finally {
  await browser.close();
}
