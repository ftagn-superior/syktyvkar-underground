import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cpus, platform, totalmem } from 'node:os';
import { hudClick } from './helpers/hud.js';

// A small comparative experiment, not the full T04 hardware acceptance run.
const url = process.env.SU_TEST_URL ?? 'http://127.0.0.1:2567';
const output = process.env.SU_PROFILE_OUTPUT ?? 'output/playwright/render-profile.json';
const qualities = (process.env.SU_PROFILE_QUALITIES ?? 'standard,economy').split(',');
assert.ok(qualities.every((value) => value === 'standard' || value === 'economy'));
const warmupMs = Number(process.env.SU_PROFILE_WARMUP_MS ?? 10_000);
const sampleMs = Number(process.env.SU_PROFILE_SAMPLE_MS ?? 15_000);
assert.ok(Number.isFinite(warmupMs) && warmupMs >= 1000);
assert.ok(Number.isFinite(sampleMs) && sampleMs >= 1000);
const software = process.env.SU_TEST_RENDERER !== 'hardware';
const browser = await launchTestBrowser({ renderer: software ? 'software' : 'default' });
const errors: string[] = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/?diagnostics=1`);
  await page.locator('#join:not([disabled])').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 30_000 },
  );
  const profiles = [];
  for (const quality of qualities) {
    const qualitySelect = page.locator('#quality');
    if (await qualitySelect.count()) {
      if (!(await qualitySelect.isVisible())) await hudClick(page, '#diagnostics-toggle');
      await qualitySelect.selectOption(quality);
      // The diagnostics overlay has identical visibility during every measurement.
      if (await page.locator('#diagnostics').isVisible())
        await hudClick(page, '#diagnostics-toggle');
    } else assert.equal(quality, 'standard', 'baseline only supports the standard profile');
    await page.waitForTimeout(warmupMs);
    // Raw browser code avoids tsx's function-name helper leaking into the page.
    // sampleMs is validated as a finite positive number above.
    const timing = await page.evaluate<{
      elapsedMs: number;
      samples: number[];
      hidden: boolean;
    }>(`new Promise((resolve) => {
      const start = performance.now();
      let previous;
      const samples = [];
      let hidden = false;
      const frame = (now) => {
        hidden ||= document.hidden;
        if (previous !== undefined) samples.push(now - previous);
        previous = now;
        if (now - start >= ${sampleMs}) {
          resolve({ elapsedMs: now - start, samples, hidden });
        } else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })`);
    assert.equal(timing.hidden, false, 'profile must remain visible');
    assert.ok(timing.samples.length >= 10, 'enough rendered frames for a comparison');
    const sorted = [...timing.samples].sort((a, b) => a - b);
    const percentile = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const details = await page.evaluate(() => {
      const debug = (window as any).__SU_DEBUG__;
      const snapshot = debug.snapshot();
      const report = debug.report?.();
      return {
        rendering: report?.rendering ?? null,
        build: report?.build ?? null,
        playerCount: snapshot.playerCount,
        rttMs: snapshot.rttMs,
        serverStepMs: snapshot.serverStepMs,
        mapVersion: snapshot.mapVersion,
      };
    });
    profiles.push({
      quality,
      warmupMs,
      elapsedMs: timing.elapsedMs,
      sampleCount: sorted.length,
      frameMs: {
        median: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: sorted.at(-1),
      },
      ...details,
      samplesMs: timing.samples,
    });
    console.log(JSON.stringify({ quality, ...profiles.at(-1)?.frameMs, samples: sorted.length }));
  }
  await hudClick(page, '#leave');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  const result = {
    date: new Date().toISOString(),
    experiment: 'stationary one-client comparative render profile; not full T04 acceptance',
    browser: browser.version(),
    requestedRenderer: software ? 'SwiftShader' : 'default hardware path',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    host: {
      platform: platform(),
      cpus: cpus().length,
      model: cpus()[0]?.model,
      totalmem: totalmem(),
    },
    profiles,
    browserErrors: errors,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Render comparison saved: ${output}`);
} finally {
  for (const context of browser.contexts())
    for (const page of context.pages())
      if (
        await page
          .locator('#leave')
          .isVisible()
          .catch(() => false)
      )
        await page
          .locator('#leave')
          .click({ timeout: 1000 })
          .catch(() => {});
  await browser.close();
}
