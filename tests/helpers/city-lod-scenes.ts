import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';

/** Functional observations are separate from the fixed comparative frame samples. */
export async function cityLodScenes(context: BrowserContext, url: string, output: string) {
  const observations: unknown[] = [],
    errors: string[] = [];
  const ready = (page: Page) =>
    page.waitForFunction(
      () => {
        const r = (window as any).__SU_DEBUG__?.report();
        return (
          r?.streaming?.backgroundReady &&
          r.streaming.groups
            .filter((g: any) => g.wanted)
            .every((g: any) => g.current === g.wanted && !g.preparing && !g.pending && !g.error)
        );
      },
      undefined,
      { timeout: 300000, polling: 200 },
    );
  for (const scene of [
    { name: 'mixed-noon', zoom: 3, hour: 12, weather: 'clear', quality: 'economy' },
    { name: 'dusk-standard', zoom: 30, hour: 18, weather: 'clouds', quality: 'standard' },
    { name: 'night-rain', zoom: 30, hour: 23, weather: 'rain,fog', quality: 'standard' },
    { name: 'night-snow', zoom: 30, hour: 23, weather: 'snow', quality: 'economy' },
  ]) {
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(
        (quality) => localStorage.setItem('su:render-quality:v1', quality),
        scene.quality,
      );
      await page.goto(
        `${url}/?diagnostics=1&initialZoom=${scene.zoom}&time=${scene.hour}&weather=${scene.weather}`,
      );
      await ready(page);
      if (scene.name === 'mixed-noon') {
        const initial = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
        assert.ok(initial.streaming.groups.some((g: any) => g.current === 'near'));
        assert.ok(initial.streaming.groups.some((g: any) => g.current === 'far'));
      }
      const report = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
      assert.equal(report.rendering.quality, scene.quality);
      assert.equal(report.rendering.hour, scene.hour);
      assert.ok(report.rendering.nightLampSources > 0);
      assert.ok(
        report.rendering.submittedTriangles.main >= 0 &&
          report.rendering.submittedTriangles.shadow >= 0,
      );
      await page.screenshot({ path: join(output, `${scene.name}.png`) });
      observations.push({ scene, report });
      if (scene.name === 'night-snow') {
        const expected = report.streaming.groups
          .filter((g: any) => g.wanted)
          .map((g: any) => [g.id, g.version, g.current])
          .sort();
        await page.evaluate(() => {
          const gl = (document.querySelector('#world') as HTMLCanvasElement).getContext('webgl2')!,
            extension = gl.getExtension('WEBGL_lose_context')!;
          (window as any).__restoreLod = () => extension.restoreContext();
          extension.loseContext();
        });
        await page.locator('#graphics-recovery').waitFor({ state: 'visible' });
        await page.waitForTimeout(200);
        await page.evaluate(() => (window as any).__restoreLod());
        await page.locator('#graphics-recovery').waitFor({ state: 'hidden', timeout: 120000 });
        await ready(page);
        await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        const restored = await page.evaluate(() => (window as any).__SU_DEBUG__.report());
        assert.deepEqual(
          restored.streaming.groups
            .filter((g: any) => g.wanted)
            .map((g: any) => [g.id, g.version, g.current])
            .sort(),
          expected,
        );
        assert.equal(restored.rendering.geometry.triangles, report.rendering.geometry.triangles);
        observations.push({ scene: 'restored-context', report: restored });
        await page.screenshot({ path: join(output, 'restored-context.png') });
      }
    } finally {
      await page.close();
    }
    await writeFile(
      join(output, 'visual-scenes.json'),
      JSON.stringify({ observations, errors }, null, 2) + '\n',
    );
  }
  assert.deepEqual(errors, []);
}
