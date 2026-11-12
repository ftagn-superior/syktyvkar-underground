import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { hudClick } from './helpers/hud.js';

if (!process.env.SU_TEST_DATABASE_URL) throw new Error('SU_TEST_DATABASE_URL is required.');
const app = await createGameServer({
  port: 0,
  worldDirectory: process.env.SU_TEST_WORLD_DIRECTORY,
});
const browser = await launchTestBrowser({ channel: 'chromium' });
const output = process.env.SU_FIRST_PERSON_OUTPUT ?? 'output/playwright/first-person';
const errors: string[] = [];
const checks: string[] = [];
const measurements: unknown[] = [];
let firstPage: Page | undefined;
const snapshot = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const rendering = (page: Page) =>
  page.evaluate(() => (window as any).__SU_DEBUG__.report().rendering);
const controls = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.controls());
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const record = (message: string) => {
  checks.push(message);
  console.log(`Passed: ${message}`);
};
const playing = (page: Page) =>
  page.waitForFunction(() => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing');
async function locked(page: Page, value: boolean) {
  await page.waitForFunction(
    (expected) =>
      !!document.pointerLockElement === expected &&
      (window as any).__SU_DEBUG__.controls().pointerLocked === expected,
    value,
  );
}
async function enter(page: Page) {
  await page.bringToFront();
  await page.locator('#world').focus();
  await page.keyboard.press('v');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().view === 'first-person');
  // Software shader compilation can exceed the existing 500 ms session budget.
  // Exercise its specified explicit resume path; never bypass capture or readiness.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(900);
    if ((await controls(page)).pointerLocked) break;
    await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable);
    measurements.push({ interruptedDuringShaderWarmup: true });
    await page.locator('#world').click({ position: { x: 400, y: 300 } });
  }
  await locked(page, true);
  assert.equal((await controls(page)).view, 'first-person');
}
async function neutral(page: Page) {
  await page.waitForTimeout(300);
  const a = (await snapshot(page)).authoritative.position;
  await page.waitForTimeout(250);
  const b = (await snapshot(page)).authoritative.position;
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.06, 'neutral server input');
  assert.equal((await controls(page)).input.facingYaw, undefined, 'neutral has no facing');
}
try {
  await mkdir(output, { recursive: true });
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        viewport: {
          width: Number(process.env.SU_FIRST_PERSON_WIDTH ?? 960),
          height: Number(process.env.SU_FIRST_PERSON_HEIGHT ?? 540),
        },
        hasTouch: true,
      }),
    ),
  );
  for (const context of contexts)
    await context.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [first, second] = pages;
  firstPage = first;
  for (const [index, page] of pages.entries()) {
    page.setDefaultTimeout(Number(process.env.SU_FIRST_PERSON_TIMEOUT_MS ?? 15_000));
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(message.text());
    });
    await page.goto(`${app.url}/?diagnostics=1`);
    await page.locator('#join:not([disabled])').waitFor({ timeout: 60_000 });
    await page
      .locator(`input[name="avatar-skin"][value="${index ? 'standard' : 'minifigure'}"]`)
      .check();
    await page.locator('#join').click();
    await playing(page);
    await page.locator('#world').focus();
    if ((await controls(page)).mode === 'touch') await page.keyboard.press('w');
  }
  await first.bringToFront();
  await first.mouse.move(400, 300);
  await first.locator('#world').focus();
  const before = await snapshot(first);
  const beforeRender = await rendering(first);
  await first.evaluate(() => {
    const events: unknown[] = [];
    (window as any).__captureEvents = events;
    for (const type of ['pointerlockchange', 'blur', 'focus', 'visibilitychange']) {
      window.addEventListener(
        type,
        () => {
          const snapshot = (window as any).__SU_DEBUG__.snapshot();
          events.push({
            type,
            at: performance.now(),
            locked: !!document.pointerLockElement,
            focus: document.hasFocus(),
            stalled: snapshot.stalled,
            connection: snapshot.connection,
            controls: (window as any).__SU_DEBUG__.controls(),
          });
        },
        true,
      );
    }
  });
  console.log('Starting first-person entry', JSON.stringify(await controls(first)));
  await enter(first);
  const initial = await rendering(first);
  const ownId = before.authoritative.entityId;
  assert.equal(initial.camera.cameras, 2);
  assert.equal(initial.camera.mode, 'first-person');
  assert.equal(initial.camera.pitch, 0);
  assert.equal(initial.camera.fov, Math.PI / 3);
  assert.equal(initial.camera.maxZ, 300);
  assert.ok(
    Math.abs(initial.camera.position.y - (await snapshot(first)).predicted.position.y - 0.7) < 0.1,
  );
  assert.ok(
    Math.abs(angleDelta(initial.camera.yaw, -Math.PI / 2 - beforeRender.camera.azimuth)) < 0.001,
  );
  assert.equal(
    initial.dynamicEntities.find((entity: any) => entity.entityId === ownId)?.visible,
    false,
  );
  await first.screenshot({ path: `${output}/first-person-entry.png` });
  record(
    'native Pointer Lock selects a perspective camera at capsule eye height, preserving position and direction',
  );

  await first.mouse.move(580, 200, { steps: 8 });
  await first.waitForTimeout(150);
  let looked = await rendering(first);
  assert.ok(Math.abs(angleDelta(looked.camera.yaw, initial.camera.yaw)) > 0.1);
  assert.ok(looked.camera.pitch > 0.05);
  await second.waitForFunction(
    ({ id, yaw }) => {
      const entity = (window as any).__SU_DEBUG__
        .report()
        .rendering.dynamicEntities.find((entry: any) => entry.entityId === id);
      return (
        entity &&
        Math.abs(
          Math.atan2(2 * entity.rotation.w * entity.rotation.y, 1 - 2 * entity.rotation.y ** 2) -
            yaw,
        ) < 0.02
      );
    },
    { id: ownId, yaw: looked.camera.yaw },
  );
  record('second client sees horizontal facing from mouse look while the player is stationary');

  const seamStart = -Math.PI + 0.4;
  const mouseBeforeSeam = 580 - angleDelta(seamStart, looked.camera.yaw) / 0.002;
  await first.mouse.move(mouseBeforeSeam, 200, { steps: 5 });
  await first.waitForTimeout(300);
  await second.evaluate((id) => {
    const samples: number[] = [];
    (window as any).__seamSamples = samples;
    const start = performance.now();
    (window as any).__sampleSeam = () => {
      const entity = (window as any).__SU_DEBUG__
        .report()
        .rendering.dynamicEntities.find((entry: any) => entry.entityId === id);
      if (entity)
        samples.push(
          Math.atan2(2 * entity.rotation.w * entity.rotation.y, 1 - 2 * entity.rotation.y ** 2),
        );
      if (performance.now() - start < 1000) requestAnimationFrame((window as any).__sampleSeam);
    };
    requestAnimationFrame((window as any).__sampleSeam);
  }, ownId);
  await first.mouse.move(mouseBeforeSeam + 400, 200, { steps: 8 });
  await first.waitForTimeout(1100);
  looked = await rendering(first);
  assert.ok(Math.abs(angleDelta(looked.camera.yaw, Math.PI - 0.4)) < 0.02);
  const seamSamples: number[] = await second.evaluate(() => (window as any).__seamSamples);
  assert.ok(
    seamSamples.length > 2 && seamSamples.every((yaw) => Math.abs(yaw) > 2.6),
    'remote body takes the short arc through the pi seam',
  );
  record('remote body facing crosses the -pi/pi seam without a spurious turn');

  for (const key of ['s', 'a', 'd', 'ArrowUp', 'ArrowDown']) {
    await first.keyboard.down(key);
    await first.waitForTimeout(300);
    const state = await snapshot(first);
    const yaw = Math.atan2(
      2 * state.authoritative.rotation.w * state.authoritative.rotation.y,
      1 - 2 * state.authoritative.rotation.y ** 2,
    );
    assert.ok(Math.abs(angleDelta(yaw, looked.camera.yaw)) < 0.03, `${key} preserves body facing`);
    assert.ok(Math.hypot(state.authoritative.velocity.x, state.authoritative.velocity.z) <= 4.01);
    await first.keyboard.up(key);
  }
  record('backward, lateral and arrow movement keep shared speeds and independent body facing');
  await first.keyboard.down('w');
  await first.keyboard.press('t');
  await locked(first, false);
  await neutral(first);
  await first.keyboard.press('v');
  assert.equal(await first.locator('#chat-input').inputValue(), 'v');
  assert.equal((await controls(first)).view, 'first-person');
  await first.locator('#chat-input').fill('Проверяем первое лицо');
  await first.keyboard.press('Enter');
  await second.locator('.player-chat').filter({ hasText: 'Проверяем первое лицо' }).waitFor();
  await first.waitForTimeout(1200);
  await first.keyboard.up('w');
  await first.locator('#world').click({ position: { x: 400, y: 300 } });
  await locked(first, true);
  assert.equal(
    Math.hypot((await controls(first)).input.moveX, (await controls(first)).input.moveZ),
    0,
  );
  record(
    'chat releases capture, neutralizes held movement, delivers speech and resumes only on a canvas click',
  );

  await first.keyboard.press('h');
  await locked(first, false);
  await neutral(first);
  for (const selector of ['#reactions-toggle', '#animations-toggle', '#inventory-toggle'])
    assert.ok(
      !(await first.locator(selector).isVisible()) || (await first.locator(selector).isDisabled()),
    );
  for (const key of ['r', 'f', 'x', 'z']) await first.keyboard.press(key);
  assert.equal(await first.locator('#reactions-panel').isVisible(), false);
  assert.equal(await first.locator('#animations-panel').isVisible(), false);
  assert.equal(await first.locator('#inventory-panel').isVisible(), false);
  await first.keyboard.press('Escape');
  await first.waitForTimeout(1100);
  record('help and all social/item shortcuts respect first-person action limits');

  const resourceCounts: unknown[] = [];
  for (const quality of ['economy', 'standard', 'economy', 'standard']) {
    await hudClick(first, '#diagnostics-toggle');
    await first.locator('#quality').selectOption(quality);
    await hudClick(first, '#diagnostics-toggle');
    await first.keyboard.press('h');
    await first.waitForTimeout(150);
    const data = await rendering(first);
    assert.equal(data.camera.mode, 'first-person');
    assert.equal(data.camera.fov, Math.PI / 3);
    assert.equal(data.camera.maxZ, 300);
    assert.equal(data.camera.cameras, 2);
    assert.equal(data.pipelines.length, quality === 'standard' ? 1 : 0);
    if (quality === 'standard')
      assert.deepEqual(data.pipelines[0].cameras, ['isometric', 'first-person']);
    resourceCounts.push({
      quality,
      meshes: data.meshes,
      materials: data.materials,
      nodes: data.nodes,
      pipelines: data.pipelines,
    });
    await first.screenshot({ path: `${output}/first-person-${quality}.png` });
  }
  measurements.push({ resourceCounts });
  record('both qualities preserve projection and register both cameras after pipeline recreation');

  // Keep the movement/resource route within this software GPU's frame budget.
  await hudClick(first, '#diagnostics-toggle');
  await first.locator('#quality').selectOption('economy');
  await hudClick(first, '#diagnostics-toggle');
  await first.keyboard.press('h');

  await first.locator('#overview-button').click();
  assert.equal((await controls(first)).view, 'overview');
  assert.ok(
    Math.abs(
      angleDelta((await rendering(first)).camera.azimuth, -Math.PI / 2 - looked.camera.yaw),
    ) < 0.01,
  );
  assert.equal(
    (await rendering(first)).dynamicEntities.find((entity: any) => entity.entityId === ownId)
      ?.visible,
    true,
  );
  await first.mouse.wheel(0, 5000);
  await first.waitForTimeout(250);
  assert.equal((await rendering(first)).camera.zoom, 30);
  await first.waitForTimeout(1100);
  await enter(first);
  assert.equal((await rendering(first)).camera.maxZ, 300);
  await first.keyboard.press('q');
  await first.mouse.wheel(0, -5000);
  const fixed = await rendering(first);
  assert.equal(fixed.camera.zoom, 30);
  assert.equal(fixed.camera.fov, Math.PI / 3);
  await first.keyboard.press('v');
  await locked(first, false);
  assert.equal((await rendering(first)).camera.zoom, 30);
  record(
    'overview restores its scale and look direction; zoom and Q/E do not alter first-person projection',
  );

  // Native denial is browser policy dependent; force only the request to reject, never capture state.
  await first.evaluate(() => {
    const canvas = document.querySelector('canvas#world')! as HTMLCanvasElement;
    const request = canvas.requestPointerLock;
    canvas.requestPointerLock = () =>
      Promise.reject(new DOMException('Test denial', 'NotAllowedError'));
    (window as any).__restorePointerLock = () => {
      canvas.requestPointerLock = request;
    };
  });
  await first.keyboard.press('v');
  await first.waitForTimeout(150);
  assert.equal((await controls(first)).view, 'overview');
  assert.equal((await controls(first)).pointerPending, false);
  await first.evaluate(() => {
    (window as any).__restorePointerLock();
  });
  record('a rejected capture request leaves a usable overview with feedback');

  await hudClick(first, '#diagnostics-toggle');
  await first.locator('#quality').selectOption('economy');
  await hudClick(first, '#diagnostics-toggle');
  await first.keyboard.press('h');
  await first.mouse.wheel(0, -5000);
  await enter(first);
  await first.keyboard.down('w');
  await first.keyboard.press('Escape');
  await locked(first, false);
  await neutral(first);
  await first.keyboard.up('w');
  await first.waitForTimeout(1100);
  await first.locator('#world').click({ position: { x: 400, y: 300 } });
  await locked(first, true);
  const focusTab = await contexts[0].newPage();
  await focusTab.bringToFront();
  await locked(first, false);
  await neutral(first);
  await first.bringToFront();
  await focusTab.close();
  assert.equal((await controls(first)).pointerLocked, false);
  await first.locator('#world').click({ position: { x: 400, y: 300 } });
  await locked(first, true);
  record('Esc and real tab blur release capture and never restore held movement on focus');

  await first.keyboard.down('w');
  await first.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await locked(first, false);
  await neutral(first);
  await first.evaluate(() => {
    delete (document as any).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await first.keyboard.up('w');
  await first.locator('#world').click({ position: { x: 400, y: 300 } });
  await locked(first, true);
  const store = (app.room as any).items.store;
  const originalConnect = store.connect;
  let storageFailed = true;
  store.connect = async function () {
    if (storageFailed) throw new Error('First-person fixture storage outage');
    return originalConnect.call(this);
  };
  try {
    await first.keyboard.down('w');
    store.onConnectionFailure();
    await first.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().storagePaused);
    await locked(first, false);
    await neutral(first);
    storageFailed = false;
    await first.waitForFunction(() => !(window as any).__SU_DEBUG__.snapshot().storagePaused);
    await playing(first);
    await neutral(first);
    await first.keyboard.up('w');
  } finally {
    storageFailed = false;
    store.connect = originalConnect;
  }
  record(
    'modeled page hiding and a real session storage pause release capture and discard held keys',
  );
  await first.locator('#world').click({ position: { x: 400, y: 300 } });
  await locked(first, true);
  await first.keyboard.down('w');
  const initialViewport = first.viewportSize()!;
  await first.setViewportSize({
    width: initialViewport.width + 40,
    height: initialViewport.height,
  });
  await first.waitForTimeout(200);
  assert.equal(
    Math.hypot((await controls(first)).input.moveX, (await controls(first)).input.moveZ),
    0,
  );
  const resized = await rendering(first);
  assert.equal(resized.camera.mode, 'first-person');
  assert.equal(resized.camera.fov, Math.PI / 3);
  assert.equal(resized.camera.minZ, 0.05);
  assert.equal(resized.camera.maxZ, 300);
  await first.keyboard.up('w');
  await first.setViewportSize(initialViewport);
  record('resize retains perspective parameters and resets held movement');

  const revision = (await snapshot(first)).authoritative.revision;
  await first.keyboard.press('h');
  await first.locator('#respawn').click();
  await playing(first);
  await first.waitForFunction(
    (previous) => (window as any).__SU_DEBUG__.snapshot().authoritative?.revision > previous,
    revision,
  );
  assert.equal((await controls(first)).view, 'first-person');
  await locked(first, false);
  await neutral(first);
  const afterRespawn = await rendering(first);
  const physical = (await snapshot(first)).predicted.position;
  assert.ok(
    Math.hypot(
      afterRespawn.camera.position.x - physical.x,
      afterRespawn.camera.position.z - physical.z,
    ) < 0.05,
  );
  await first.keyboard.press('h');
  await first.locator('#world').click({ position: { x: 400, y: 300 } });
  await locked(first, true);
  await contexts[0].setOffline(true);
  await first.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
  );
  await locked(first, false);
  await contexts[0].setOffline(false);
  await playing(first);
  assert.equal((await controls(first)).view, 'first-person');
  assert.equal((await snapshot(first)).authoritative.entityId, ownId);
  await neutral(first);
  record(
    'respawn snaps eyes to the new capsule; reconnection retains one character and resumes with a free cursor',
  );

  await first.evaluate(() => {
    const gl = (document.querySelector('#world') as HTMLCanvasElement).getContext('webgl2')!;
    const extension = gl.getExtension('WEBGL_lose_context')!;
    (window as any).__restoreGraphics = () => extension.restoreContext();
    extension.loseContext();
  });
  await first.locator('#graphics-recovery').waitFor({ state: 'visible' });
  assert.equal((await controls(first)).view, 'first-person');
  await first.waitForTimeout(150);
  await first.evaluate(() => (window as any).__restoreGraphics());
  await first.locator('#graphics-recovery').waitFor({ state: 'hidden' });
  await first.waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable);
  assert.equal((await controls(first)).view, 'first-person');
  await locked(first, false);
  await neutral(first);
  record(
    'actual WebGL context restoration retains the perspective with neutral input and a free cursor',
  );

  const cdp = await contexts[0].newCDPSession(first);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 1, x: 400, y: 300 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal((await controls(first)).mode, 'touch');
  assert.equal((await controls(first)).view, 'overview');
  await neutral(first);
  await first.locator('#world').focus();
  await first.keyboard.press('w');
  assert.equal((await controls(first)).mode, 'desktop');
  await neutral(first);
  record(
    'a real touch returns to overview and consumes the switching gesture; keyboard switching also starts neutral',
  );

  const cycles: unknown[] = [];
  await first.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().streaming.backgroundReady,
    undefined,
    { timeout: 60_000 },
  );
  for (let cycle = 0; cycle < 6; cycle++) {
    await enter(first);
    await first.keyboard.press('v');
    await locked(first, false);
    await first.waitForTimeout(150);
    const data = await rendering(first);
    cycles.push({
      cameras: data.camera.cameras,
      meshes: data.meshes,
      materials: data.materials,
      nodes: data.nodes,
      geometries: data.geometries,
      textures: data.textures,
    });
  }
  const firstCycle = cycles[0] as Record<string, number>;
  const lastCycle = cycles.at(-1) as Record<string, number>;
  for (const key of Object.keys(firstCycle))
    assert.ok(lastCycle[key] <= firstCycle[key], `${key} does not accumulate across view switches`);
  assert.equal(lastCycle.cameras, 2);
  measurements.push({ cycles });
  await hudClick(first, '#leave');
  await first.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().connection === 'ready');
  assert.equal((await controls(first)).view, 'overview');
  await locked(first, false);
  record(
    'six repeated switches keep scene resources stable; leaving clears first-person selection',
  );

  measurements.push({
    worldDirectory: process.env.SU_TEST_WORLD_DIRECTORY ?? 'dist/worlds/physics-lab',
    browser: browser.version(),
    viewport: first.viewportSize(),
    rendering: await rendering(first),
  });
  assert.deepEqual(errors, []);
  await first.screenshot({ path: `${output}/overview.png` });
  await writeFile(
    `${output}/report.json`,
    JSON.stringify({ checks, measurements, errors }, null, 2),
  );
} catch (error) {
  await firstPage?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  const state = await firstPage
    ?.evaluate(() => ({
      controls: (window as any).__SU_DEBUG__?.controls(),
      snapshot: (window as any).__SU_DEBUG__?.snapshot(),
      focus: document.hasFocus(),
      notice: document.getElementById('notice')?.textContent,
      rendering: (window as any).__SU_DEBUG__?.report().rendering,
      captureEvents: (window as any).__captureEvents,
    }))
    .catch(() => undefined);
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify({ checks, errors, error: String(error), state }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await app.close();
}
