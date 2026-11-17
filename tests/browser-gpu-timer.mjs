/** Native WebGL query ownership/lifecycle checks on a blank page. Not a GPU benchmark.
 * Run from the repository root: node --import tsx tests/browser-gpu-timer.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { transform } from 'esbuild';
import { launchTestBrowser } from './helpers/browser.ts';
const source = await transform(await readFile('apps/client/src/diagnostics/gpu-timer.ts', 'utf8'), {
  loader: 'ts',
  format: 'iife',
  globalName: 'S60Timer',
});
const browser = await launchTestBrowser({ channel: 'chromium' });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: source.code });
  const result = await page.evaluate(async () => {
    const check = (ok, message) => {
      if (!ok) throw new Error(message);
    };
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    check(!!ext, 'timer extension must be available for this native API test');
    const foreign = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, foreign);
    const timer = new S60Timer.GpuRenderTimer(gl, 1);
    timer.begin(1);
    timer.end();
    check(
      gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) === foreign,
      'foreign query was changed',
    );
    check(gl.getError() === gl.NO_ERROR, 'foreign query conflict generated GL error');
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    gl.deleteQuery(foreign);
    timer.begin(2);
    gl.clear(gl.COLOR_BUFFER_BIT);
    timer.end();
    let sample;
    for (let i = 0; i < 120 && !sample; i++) {
      await new Promise(requestAnimationFrame);
      sample = timer.poll();
    }
    check(
      sample?.frameId === 2 && Number.isFinite(sample.ms) && sample.ms >= 0,
      'no valid native query sample',
    );
    timer.begin(3);
    gl.clear(gl.COLOR_BUFFER_BIT);
    timer.end();
    const lose = gl.getExtension('WEBGL_lose_context');
    const lost = new Promise((resolve) =>
      canvas.addEventListener(
        'webglcontextlost',
        (event) => {
          event.preventDefault();
          timer.contextLost();
          resolve();
        },
        { once: true },
      ),
    );
    lose.loseContext();
    await lost;
    check(timer.status === 'context-lost' && timer.poll() === null, 'lost sample retained');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const restored = new Promise((resolve) =>
      canvas.addEventListener(
        'webglcontextrestored',
        () => {
          timer.contextRestored();
          resolve();
        },
        { once: true },
      ),
    );
    lose.restoreContext();
    await restored;
    check(timer.status === 'collecting', 'timer did not restore');
    timer.begin(4);
    gl.clear(gl.COLOR_BUFFER_BIT);
    timer.end();
    const getter = gl.getQueryParameter;
    gl.getQueryParameter = () => {
      throw new Error('injected sensor failure');
    };
    timer.poll();
    gl.getQueryParameter = getter;
    check(timer.status === 'error' && timer.errors === 1, 'API fault did not disable only timer');
    gl.clear(gl.COLOR_BUFFER_BIT);
    check(gl.getError() === gl.NO_ERROR, 'render state damaged after diagnostic fault');
    timer.dispose();
    return {
      foreignQueryPreserved: true,
      sampleFrameId: sample.frameId,
      sampleMs: sample.ms,
      contextLostRestored: true,
      diagnosticFaultContained: true,
      rendererContinues: true,
      busySkips: timer.busySkips,
      lostQueries: timer.lostQueries,
    };
  });
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/gpu-timer.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
