/** Browser clock control, without a game scene. Does not replace the frame budget gate. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchTestBrowser } from './helpers/browser.js';

const output = resolve(process.argv[2] ?? 'output/ring-terrain-stage5/frame-clock');
const headed = process.argv[3] === '--headed';
const browser = await launchTestBrowser({
  renderer: 'default',
  channel: 'chromium',
  headless: !headed,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  await page.setContent('<!doctype html><canvas width="1920" height="1080"></canvas>');
  // tsx preserves function names with a helper when Playwright serializes this callback.
  await page.evaluate('globalThis.__name = (fn) => fn');
  const result = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas')!;
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 is unavailable');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    gl.clearColor(0.2, 0.3, 0.4, 1);
    const warmupMs = 60_000,
      sampleMs = 60_000;
    const started = performance.now();
    let lastNow: number | undefined, lastStamp: number | undefined;
    const callbackIntervalsMs: number[] = [],
      timestampIntervalsMs: number[] = [];
    let hidden = false;
    await new Promise<void>((done) => {
      const frame = (stamp: number) => {
        const now = performance.now();
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (now - started >= warmupMs && lastNow !== undefined && lastStamp !== undefined) {
          callbackIntervalsMs.push(now - lastNow);
          timestampIntervalsMs.push(stamp - lastStamp);
          hidden ||= document.hidden;
        }
        lastNow = now;
        lastStamp = stamp;
        if (now - started >= warmupMs + sampleMs) done();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    return {
      renderer,
      warmupMs,
      sampleMs,
      elapsedMs: performance.now() - started,
      hidden,
      callbackIntervalsMs,
      timestampIntervalsMs,
    };
  });
  const distribution = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      count: values.length,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      max: sorted.at(-1),
    };
  };
  const report = {
    date: new Date().toISOString(),
    scope: 'Empty WebGL2 clear only. Clock diagnostic; no terrain or gameplay acceptance.',
    browser: browser.version(),
    browserSurface: headed ? 'headed' : 'headless',
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    ...result,
    summary: {
      callbackIntervalsMs: distribution(result.callbackIntervalsMs),
      timestampIntervalsMs: distribution(result.timestampIntervalsMs),
    },
  };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, renderer: result.renderer, summary: report.summary }));
} finally {
  await browser.close();
}
