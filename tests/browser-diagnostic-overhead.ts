/**
 * S-60 recorder overhead probe. Runs ONE tab against an already started test server and
 * measures, with a build-independent wrapper around requestAnimationFrame:
 * - main-thread wall time of each RAF callback (Babylon begin/render/end; not CPU usage,
 *   not GPU time) and RAF intervals, in a fixed overview scene (noon, clear, standard);
 * - the synchronous cost and size of the manual "Download report" export, separately.
 * Compare builds sequentially (never two games at once), e.g. the PR merge-base vs the PR:
 *
 *   SU_TEST_URL=http://127.0.0.1:2599 SU_OVERHEAD_LABEL=pr-1 SU_TEST_RENDERER=hardware \
 *     node --import tsx tests/browser-diagnostic-overhead.ts
 */
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { launchTestBrowser } from './helpers/browser.js';

const url = process.env.SU_TEST_URL ?? 'http://127.0.0.1:2567';
const label = process.env.SU_OVERHEAD_LABEL ?? 'run';
const seconds = Number(process.env.SU_OVERHEAD_SECONDS ?? 20);
const output = process.env.SU_DIAGNOSTIC_OUTPUT ?? 'output/diagnostic-overhead';
// Full Chromium: the headless shell falls back to SwiftShader instead of the real GPU.
const browser = await launchTestBrowser({
  channel: 'chromium',
  renderer: process.env.SU_TEST_RENDERER === 'hardware' ? 'default' : 'software',
});
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    n: sorted.length,
    mean: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
  };
};
try {
  await mkdir(output, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  // A string, not a function: transpiled helpers do not exist inside the page.
  await context.addInitScript(`(() => {
    const raf = window.requestAnimationFrame.bind(window);
    const rows = [];
    let recording = false;
    window.__S60_RAF__ = rows;
    window.__S60_RAF_RECORD__ = (on) => {
      if (on) rows.length = 0;
      recording = on;
    };
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        const started = performance.now();
        try {
          callback(time);
        } finally {
          if (recording) rows.push(time, performance.now() - started);
        }
      });
  })();`);
  const page = await context.newPage();
  await page.goto(
    `${url}/?diagnostics=1&time=12&weather=clear${process.env.SU_DIAGNOSTIC_QUERY ?? ''}`,
  );
  await page.locator('#join:not([disabled])').waitFor({ timeout: 240_000 });
  await page.locator('#join').click();
  await page.waitForFunction(
    () => {
      const r = (window as any).__SU_DEBUG__?.report();
      return r?.metrics.connection === 'playing' && r.streaming.criticalReady;
    },
    undefined,
    { timeout: 300_000, polling: 1000 },
  );
  // Background streaming keeps refining the city; both builds get the same settle period.
  await page.waitForTimeout(Number(process.env.SU_OVERHEAD_SETTLE_SECONDS ?? 30) * 1000);
  await page.evaluate(() => (window as any).__S60_RAF_RECORD__(true));
  await page.waitForTimeout(seconds * 1000);
  const rows: number[] = await page.evaluate(() => {
    (window as any).__S60_RAF_RECORD__(false);
    return (window as any).__S60_RAF__.slice();
  });
  // Several RAF users share one frame timestamp: sum their callbacks per frame.
  const perFrame = new Map<number, number>();
  for (let i = 0; i < rows.length; i += 2)
    perFrame.set(rows[i], (perFrame.get(rows[i]) ?? 0) + rows[i + 1]);
  const times = [...perFrame.keys()].sort((a, b) => a - b);
  const callbacks = times.map((time) => perFrame.get(time)!),
    intervals = times.slice(1).map((time, i) => time - times[i]);
  const exports = [];
  for (let i = 0; i < 5; i++) {
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => {
        const started = performance.now();
        document.getElementById('download-report')!.click();
        (window as any).__S60_EXPORT_MS__ = performance.now() - started;
      }),
    ]);
    const path = join(output, `${label}-export-${i + 1}.json`);
    await file.saveAs(path);
    exports.push({
      ms: await page.evaluate(() => (window as any).__S60_EXPORT_MS__),
      bytes: (await stat(path)).size,
    });
    await page.waitForTimeout(1000);
  }
  const report = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
  const result = {
    label,
    url,
    seconds,
    renderer: report.rendering.renderer,
    renderSize: report.rendering.renderSize,
    quality: report.rendering.quality,
    drawCalls: report.rendering.drawCalls,
    callbackMs: stats(callbacks),
    intervalMs: stats(intervals),
    exports,
    formatVersion: report.formatVersion,
  };
  await appendFile(join(output, 'results.jsonl'), JSON.stringify(result) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
