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
const browser = await launchTestBrowser({
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
  await context.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    const rows: number[] = [];
    let recording = false;
    Object.assign(window, {
      __S60_RAF__: rows,
      __S60_RAF_RECORD__: (on: boolean) => {
        if (on) rows.length = 0;
        recording = on;
      },
    });
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        const started = performance.now();
        try {
          callback(time);
        } finally {
          if (recording) rows.push(time, performance.now() - started);
        }
      });
  });
  const page = await context.newPage();
  await page.goto(
    `${url}/?diagnostics=1&time=12&weather=clear${process.env.SU_DIAGNOSTIC_QUERY ?? ''}`,
  );
  await page.locator('#join:not([disabled])').waitFor({ timeout: 240_000 });
  await page.locator('#join').click();
  await page.waitForFunction(
    () => {
      const r = (window as any).__SU_DEBUG__?.report();
      return (
        r?.metrics.connection === 'playing' &&
        r.streaming.criticalReady &&
        r.streaming.groups
          .filter((g: any) => g.wanted)
          .every((g: any) => g.current === g.wanted && !g.pending && !g.preparing && !g.error)
      );
    },
    undefined,
    { timeout: 300_000, polling: 1000 },
  );
  await page.waitForTimeout(10_000);
  await page.evaluate(() => (window as any).__S60_RAF_RECORD__(true));
  await page.waitForTimeout(seconds * 1000);
  const rows: number[] = await page.evaluate(() => {
    (window as any).__S60_RAF_RECORD__(false);
    return (window as any).__S60_RAF__.slice();
  });
  const callbacks: number[] = [],
    intervals: number[] = [];
  for (let i = 0; i < rows.length; i += 2) {
    callbacks.push(rows[i + 1]);
    if (i) intervals.push(rows[i] - rows[i - 2]);
  }
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
