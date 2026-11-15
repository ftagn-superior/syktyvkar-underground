import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { launchTestBrowser } from './browser.js';
import { cityLodPlay } from './city-lod-play.js';
import { cityLodWalk } from './city-lod-walk.js';

/** One real guest, fixed spawn, cold initial far camera. Compare structural costs only. */
export async function cityLodGameProfile(
  createServer: (options: any) => Promise<any>,
  options: any,
  output: string,
  exercise = false,
  zoom: 1 | 30 = 30,
) {
  const app = await createServer(options),
    errors: string[] = [];
  if (options.accounts) options.accounts.config.publicOrigin = app.url;
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage({
      viewport: { width: 640, height: 400 },
      deviceScaleFactor: 1,
    });
    await page.addInitScript(() => {
      localStorage.setItem('su:render-quality:v1', 'economy');
      performance.setResourceTimingBufferSize(10000);
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.url + `/?diagnostics=1&initialZoom=${zoom}&time=12`);
    const timer = setInterval(() => {
      void page
        .evaluate(() => {
          const r = (window as any).__SU_DEBUG__?.report();
          if (!r) return null;
          return {
            connection: r.metrics.connection,
            ready: r.streaming.backgroundReady,
            readyRadius: r.rendering.streaming.readyRadius,
            drawRadius: r.rendering.streaming.drawRadius,
            zoom: r.rendering.camera.zoom,
            groups: r.streaming.groups,
            resources: r.streaming.resources,
            cells: r.streaming.cells,
          };
        })
        .then((r) => writeFile(output, JSON.stringify(r)))
        .catch(() => {});
    }, 5000);
    try {
      // Let the complete cold far preview settle before entering on both versions.
      // The old 2 ms gameplay pump otherwise advances only a few cells per minute
      // on SwiftShader; comparing its partial resident set would be misleading.
      await page.waitForFunction(
        () => {
          const r = (window as any).__SU_DEBUG__?.report();
          return (
            r?.metrics.connection === 'ready' &&
            r.streaming.backgroundReady &&
            r.rendering.streaming.readyRadius >= r.rendering.streaming.drawRadius - 0.01
          );
        },
        undefined,
        { timeout: 900000, polling: 250 },
      );
      await page.locator('#join:not([disabled])').click({ timeout: 120000 });
      await page.waitForFunction(
        () => {
          const r = (window as any).__SU_DEBUG__?.report();
          return (
            r?.metrics.connection === 'playing' &&
            r.streaming.backgroundReady &&
            r.rendering.streaming.readyRadius >= r.rendering.streaming.drawRadius - 0.01
          );
        },
        undefined,
        { timeout: 900000, polling: 250 },
      );
      await page.waitForFunction(
        () => {
          const r = (window as any).__SU_DEBUG__.report(),
            signature = JSON.stringify([
              r.rendering.geometry.triangles,
              r.rendering.meshes,
              r.rendering.buildings.assets,
            ]);
          const previous = (window as any).__lodGameSteady;
          if (previous?.signature !== signature) {
            (window as any).__lodGameSteady = { signature, at: performance.now() };
            return false;
          }
          return performance.now() - previous.at >= 20000;
        },
        undefined,
        { timeout: 180000, polling: 1000 },
      );
      const data = await page.evaluate(() => {
        const debug = (window as any).__SU_DEBUG__,
          r = debug.report(),
          s = debug.snapshot();
        const resources = performance
          .getEntriesByType('resource')
          .map((e: any) => ({
            path: new URL(e.name).pathname,
            body: e.decodedBodySize,
            transfer: e.transferSize,
          }))
          .filter((e) => e.path.startsWith('/worlds/'));
        return {
          geometry: r.rendering.geometry,
          geometryPeak: r.rendering.geometryPeak,
          texturePayloadEstimateBytes: r.rendering.texturePayloadEstimateBytes,
          submittedTriangles: r.rendering.submittedTriangles,
          drawCalls: r.rendering.drawCalls,
          near: r.streaming.groups?.filter((g: any) => g.current === 'near').length,
          far: r.streaming.groups?.filter((g: any) => g.current === 'far').length,
          groups: r.streaming.groups,
          models: r.rendering.buildings.assets,
          playerCount: s.playerCount,
          position: s.authoritative.position,
          camera: r.rendering.camera,
          renderer: r.rendering.renderer,
          mapVersion: s.mapVersion,
          simulationConfigHash: s.simulationConfigHash,
          bodyBytes: resources.reduce((n, e) => n + e.body, 0),
          transferBytes: resources.reduce((n, e) => n + e.transfer, 0),
          resources,
        };
      });
      assert.equal(data.camera.zoom, zoom);
      assert.equal(data.playerCount, 1);
      assert.deepEqual(errors, []);
      const serverBodies = app.room.diagnostics().bodies;
      await writeFile(
        output + '.measured.json',
        JSON.stringify({ ...data, serverBodies }, null, 2),
      );
      const play = exercise ? await cityLodPlay(browser, page, app.url) : undefined;
      const walk = zoom === 1 ? await cityLodWalk(page) : undefined;
      assert.deepEqual(errors, []);
      return { ...data, serverBodies, errors, play, walk };
    } finally {
      clearInterval(timer);
    }
  } finally {
    await browser.close();
    await app.close();
  }
}
