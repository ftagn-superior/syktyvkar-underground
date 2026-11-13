import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright';
import { buildWorld } from '../tools/world-build/src/index.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';

if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('Set SU_TEST_DATABASE_URL to a test database.');
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const temporary = await mkdtemp(join(tmpdir(), 'su-touch-browser-'));
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
const errors: string[] = [];
const checks: string[] = [];
function recordCheck(message: string): void {
  checks.push(message);
  console.log(`Passed: ${message}`);
}
const sizes: unknown[] = [];
const snapshot = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const controls = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.controls());
const rendering = (page: Page) =>
  page.evaluate(() => (window as any).__SU_DEBUG__.report().rendering);
const magnitude = (input: { moveX: number; moveZ: number }) => Math.hypot(input.moveX, input.moveZ);
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const playing = (page: Page) =>
  page.waitForFunction(() => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing');
async function neutral(page: Page) {
  await page.waitForFunction(() => {
    const input = (window as any).__SU_DEBUG__.controls().input;
    return Math.hypot(input.moveX, input.moveZ) === 0;
  });
  await page.waitForTimeout(350);
  const before = (await snapshot(page)).authoritative.position;
  await page.waitForTimeout(350);
  const after = (await snapshot(page)).authoritative.position;
  assert.ok(
    Math.hypot(after.x - before.x, after.z - before.z) < 0.06,
    'neutral stops server movement',
  );
}
async function point(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  assert.ok(box, `${selector} has a hit area`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
// CDP sends native browser touch input: no dispatchEvent or direct input-handler calls.
class Fingers {
  private readonly points = new Map<number, { x: number; y: number }>();
  constructor(
    private readonly cdp: CDPSession,
    private readonly page: Page,
  ) {}
  private async send(type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel') {
    await this.cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: [...this.points].map(([id, position]) => ({ id, ...position })),
    });
    await this.page.waitForTimeout(40); // Native compositor routing can follow the CDP acknowledgement.
  }
  async down(id: number, x: number, y: number) {
    this.points.set(id, { x, y });
    await this.send('touchStart');
  }
  async move(id: number, x: number, y: number) {
    this.points.set(id, { x, y });
    await this.send('touchMove');
  }
  async up(id: number) {
    const position = this.points.get(id)!;
    this.points.delete(id);
    await this.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [{ id, ...position }],
    });
    await this.page.waitForTimeout(40);
  }
  async cancel() {
    this.points.clear();
    await this.send('touchCancel');
  }
}
async function touchLayout(page: Page) {
  const help = page.locator('#help-panel');
  if (await help.isVisible()) await page.locator('#help-close').tap();
  for (const selector of ['#touch-stick', '#respawn', '#leave', '#diagnostics-toggle']) {
    if (selector !== '#touch-stick' && !(await help.isVisible())) {
      await page.locator('#help-toggle').tap();
      await help.evaluate((node) =>
        Promise.all(node.getAnimations().map((animation) => animation.finished)),
      );
    }
    await page.locator(selector).scrollIntoViewIfNeeded();
    const result = await page.locator(selector).evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        inside: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        hit: hit === node || (!!hit && node.contains(hit)),
        width: r.width,
        height: r.height,
      };
    });
    assert.ok(result.inside && result.hit, `${selector} is reachable`);
    assert.ok(
      result.width >= 44 && result.height >= 44,
      `${selector} is at least 44×44: ${JSON.stringify(result)}`,
    );
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#help-close').tap();
}
try {
  await mkdir('output/playwright/touch', { recursive: true });
  await cp('content', join(temporary, 'content'), { recursive: true });
  const source = join(temporary, 'content/worlds/physics-lab/world.json');
  const authored = JSON.parse(await readFile(source, 'utf8'));
  authored.initialItems = [
    {
      seedId: 'touch-crate',
      typeId: 'wooden-crate',
      position: { x: -3, y: 0.52, z: 2 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
  ];
  await writeFile(source, JSON.stringify(authored));
  const release = join(temporary, 'release');
  await buildWorld(source, release);
  app = await createGameServer({ port: 0, accounts: fixture, worldDirectory: release });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser({ channel: 'chromium' });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const fingers = new Fingers(cdp, page);
  await page.goto(app.url + '/?diagnostics=1');
  assert.equal((await controls(page)).mode, 'touch');
  await page.locator('#telegram-login').tap();
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  // The OIDC callback drops the diagnostics query; restore the test's read-only hooks.
  await page.goto(app.url + '/?diagnostics=1');
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  // Typing movement letters in a form never switches the input mode.
  await page.locator('#profile-name').fill('Touch WASD');
  assert.equal(await page.locator('body').getAttribute('data-input-mode'), 'touch');
  // Entering the world saves the edited profile.
  await page.locator('#join:not([disabled])').tap();
  await playing(page);
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().touchAvailable);
  await touchLayout(page);
  await page.evaluate(() => {
    const events: unknown[] = [];
    (window as any).__SU_TEST_EVENTS__ = events;
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'gotpointercapture',
      'lostpointercapture',
      'resize',
      'blur',
      'focus',
      'visibilitychange',
    ])
      window.addEventListener(
        type,
        (event) => {
          const e = event as PointerEvent;
          events.push({
            type,
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            target: (e.target as HTMLElement)?.id,
            controls: (window as any).__SU_DEBUG__.controls(),
          });
          if (events.length > 100) events.shift();
        },
        true,
      );
  });
  const center = await point(page, '#touch-stick');
  const start = (await snapshot(page)).authoritative.position;
  await fingers.down(1, center.x, center.y);
  await fingers.move(1, center.x, center.y - 3);
  assert.equal(magnitude((await controls(page)).input), 0, 'dead zone');
  await fingers.move(1, center.x, center.y - 22);
  const half = (await controls(page)).input;
  assert.ok(magnitude(half) > 0.35 && magnitude(half) < 0.5, 'analog walking speed');
  assert.equal(half.sprint, false);
  await page.waitForFunction((origin) => {
    const position = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
    return Math.hypot(position.x - origin.x, position.z - origin.z) > 0.15;
  }, start);
  const beforeTurn = await rendering(page);
  await fingers.down(2, 300, 400);
  await fingers.move(2, 300, 450);
  await page.waitForTimeout(120);
  assert.ok(
    Math.abs(angleDelta((await rendering(page)).camera.azimuth, beforeTurn.camera.azimuth)) < 0.001,
    'vertical movement does not rotate',
  );
  await fingers.move(2, 200, 450); // capture retains ownership across the midpoint
  await page.waitForTimeout(400);
  const afterTurn = await rendering(page);
  assert.ok(Math.abs(angleDelta(afterTurn.camera.azimuth, beforeTurn.camera.azimuth) - 0.5) < 0.01);
  const input = (await controls(page)).input;
  assert.ok(Math.abs(input.moveX + Math.cos(afterTurn.camera.azimuth) * magnitude(half)) < 0.002);
  assert.ok(Math.abs(input.moveZ + Math.sin(afterTurn.camera.azimuth) * magnitude(half)) < 0.002);
  await fingers.down(3, 330, 500);
  await fingers.move(3, 370, 500);
  assert.ok(
    Math.abs(angleDelta((await rendering(page)).camera.azimuth, afterTurn.camera.azimuth)) < 0.002,
  );
  await fingers.up(3);
  await fingers.move(1, center.x + 160, center.y - 160); // outside stick, diagonal speed capped
  await page.waitForFunction(() => {
    const input = (window as any).__SU_DEBUG__.controls().input;
    return Math.abs(Math.hypot(input.moveX, input.moveZ) - 1) < 0.001;
  });
  await fingers.up(1);
  assert.equal(magnitude((await controls(page)).input), 0);
  const beforeCameraOnly = (await rendering(page)).camera.azimuth;
  await fingers.move(2, 240, 450);
  await fingers.up(2);
  await page.waitForTimeout(400);
  assert.ok(
    Math.abs(angleDelta((await rendering(page)).camera.azimuth, beforeCameraOnly) + 0.2) < 0.01,
    'normal stick release and lost capture preserve the camera gesture',
  );
  await neutral(page);
  await fingers.down(1, center.x, center.y - 30);
  await fingers.down(2, 300, 400);
  await fingers.up(2);
  assert.ok(magnitude((await controls(page)).input) > 0.5, 'reverse release preserves movement');
  await fingers.up(1);
  await neutral(page);
  recordCheck(
    'native multitouch: analog speed, authoritative movement, actual camera axes, independent release, capture, third finger',
  );

  for (const key of ['r', 't', '/', 'f', 'x', 'z', 'q', 'e', 'Shift'])
    await page.keyboard.press(key);
  await page.waitForTimeout(600); // includes periodic and network UI updates
  for (const selector of [
    '#chat-toggle',
    '#chat-console',
    '#reactions-toggle',
    '#reactions-panel',
    '#animations-toggle',
    '#animations-panel',
    '#inventory-toggle',
    '#inventory-panel',
    '[aria-keyshortcuts="Z"]',
    '#item-placement',
    '#static-placement',
  ])
    assert.equal(await page.locator(selector).isHidden(), true, `${selector} remains unavailable`);
  assert.equal(
    (await snapshot(page)).items.length,
    1,
    'swipes/hotkeys did not pick up the nearby crate',
  );
  await fingers.down(1, 30, 420);
  await fingers.move(1, 100, 420);
  await fingers.up(1);
  assert.equal(magnitude((await controls(page)).input), 0, 'left canvas is not a movement target');
  recordCheck(
    'signed-in touch player cannot open social panels or inventory, collect or place through hotkeys or swipes',
  );

  await fingers.down(1, center.x, center.y - 35);
  await fingers.down(2, 300, 400);
  await fingers.move(2, 275, 400);
  await fingers.cancel();
  await page.waitForFunction(() => !(window as any).__SU_DEBUG__.report().rendering.camera.turning);
  const cancelledAngle = (await rendering(page)).camera.azimuth;
  await neutral(page);
  assert.equal(
    (await rendering(page)).camera.azimuth,
    cancelledAngle,
    'cancellation stops smoothing',
  );
  await fingers.down(1, center.x, center.y - 35);
  await fingers.down(2, 300, 400);
  await fingers.move(1, center.x, center.y - 36); // Commit pending capture before removing it.
  await page.evaluate(() => {
    const events = (window as any).__SU_TEST_EVENTS__ as {
      type: string;
      target: string;
      id: number;
    }[];
    const id = [...events]
      .reverse()
      .find((e) => e.type === 'pointerdown' && e.target === 'touch-stick')!.id;
    document.querySelector('#touch-stick')!.releasePointerCapture(id);
  });
  await fingers.move(1, center.x, center.y - 40);
  await fingers.move(2, 250, 400);
  await neutral(page);
  await fingers.cancel();
  recordCheck('unexpected native lostpointercapture resets both gestures');
  await fingers.down(1, center.x, center.y - 35);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(200);
  assert.equal(magnitude((await controls(page)).input), 0);
  await fingers.move(1, center.x, center.y - 40);
  assert.equal(
    magnitude((await controls(page)).input),
    0,
    'old finger stays cancelled after resize',
  );
  await fingers.cancel();
  await touchLayout(page);
  await page.screenshot({ path: 'output/playwright/touch/landscape.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  recordCheck(
    'touchcancel stops both gestures and smoothing; orientation resize clears capture and requires a new touch',
  );

  await fingers.down(1, center.x, center.y - 30);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const other = await context.newPage();
  const otherCdp = await context.newCDPSession(other);
  await other.goto('about:blank');
  await otherCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await other.bringToFront();
  await page.waitForFunction(() => !document.hasFocus());
  assert.equal(magnitude((await controls(page)).input), 0);
  await page.bringToFront();
  await page.waitForFunction(() => !document.hidden && document.hasFocus());
  await fingers.move(1, center.x, center.y - 40);
  await neutral(page);
  await fingers.cancel();
  await other.close();
  recordCheck('real focus recovery does not resume the old finger');
  // Chromium automation keeps background tabs visible even after disabling focus emulation.
  // Touch routing above is native; this separate lifecycle check deliberately models visibility.
  await fingers.down(1, center.x, center.y - 30);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await fingers.move(1, center.x, center.y - 40);
  await neutral(page);
  await fingers.cancel();
  recordCheck('simulated visibility lifecycle; native visibility on mobile devices remains manual');

  await fingers.down(1, center.x, center.y - 30);
  await fingers.down(2, 300, 400);
  const supported = await page.evaluate(() => {
    const extension = (document.querySelector('#world') as HTMLCanvasElement)
      .getContext('webgl2')
      ?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    (window as any).__SU_TEST_CONTEXT_EXTENSION__ = extension;
    extension.loseContext();
    return true;
  });
  assert.equal(supported, true);
  await page.locator('#graphics-recovery').waitFor({ state: 'visible' });
  await neutral(page);
  await page.evaluate(() => (window as any).__SU_TEST_CONTEXT_EXTENSION__.restoreContext());
  await page.locator('#graphics-recovery').waitFor({ state: 'hidden' });
  await playing(page);
  await fingers.move(1, center.x, center.y - 42);
  await fingers.move(2, 250, 400);
  await neutral(page);
  assert.match(await page.locator('#notice').innerText(), /Коснитесь стика заново/);
  await fingers.cancel();
  recordCheck(
    'WebGL loss/recovery cancels both fingers and displays a touch-specific continuation hint',
  );

  const identity = (await snapshot(page)).authoritative.entityId;
  await fingers.down(1, center.x, center.y - 30);
  await fingers.down(2, 300, 400);
  await context.setOffline(true);
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
  );
  assert.equal(magnitude((await controls(page)).input), 0);
  await context.setOffline(false);
  await playing(page);
  await fingers.move(1, center.x, center.y - 40);
  await fingers.move(2, 250, 400);
  await neutral(page);
  assert.equal((await snapshot(page)).authoritative.entityId, identity);
  await fingers.cancel();
  recordCheck('connection recovery preserves identity and requires fresh touches');

  // Fault injection stays inside this fixture's store and exercises the server pause/resume path.
  const store = (app.room as any).items.store;
  const originalConnect = store.connect;
  let storageFailed = true;
  store.connect = async function () {
    if (storageFailed) throw new Error('Touch fixture storage outage');
    return originalConnect.call(this);
  };
  try {
    await fingers.down(1, center.x, center.y - 30);
    await fingers.down(2, 300, 400);
    store.onConnectionFailure();
    await page.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().storagePaused);
    await neutral(page);
    storageFailed = false;
    await page.waitForFunction(() => !(window as any).__SU_DEBUG__.snapshot().storagePaused);
    await playing(page);
    await fingers.move(1, center.x, center.y - 40);
    await fingers.move(2, 250, 400);
    await neutral(page);
    await fingers.cancel();
  } finally {
    storageFailed = false;
    store.connect = originalConnect;
  }
  recordCheck('storage pause and reconciliation discard both held fingers');

  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await touchLayout(page);
  }
  await page.screenshot({ path: 'output/playwright/touch/tablet.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  recordCheck('phone and tablet portrait/landscape controls fit and retain 44px service targets');

  const beforeService = (await rendering(page)).camera.azimuth;
  await page.locator('#help-toggle').tap();
  const untouchedRevision = (await snapshot(page)).authoritative.revision;
  const servicePoint = await point(page, '#respawn');
  await fingers.down(1, center.x, center.y - 35);
  await fingers.down(2, servicePoint.x, servicePoint.y);
  await fingers.move(2, servicePoint.x - 100, servicePoint.y - 80);
  await fingers.up(2);
  assert.equal((await snapshot(page)).authoritative.revision, untouchedRevision);
  await fingers.down(2, servicePoint.x, servicePoint.y);
  await fingers.cancel();
  assert.equal((await snapshot(page)).authoritative.revision, untouchedRevision);
  recordCheck('dragging off or cancelling a service tap does not activate it');
  await fingers.down(1, center.x, center.y - 35);
  const revision = (await snapshot(page)).authoritative.revision;
  const respawn = await point(page, '#respawn');
  await fingers.down(2, respawn.x, respawn.y);
  await fingers.up(2);
  await page.waitForFunction((old) => {
    const state = (window as any).__SU_DEBUG__.snapshot();
    return state.connection === 'playing' && state.authoritative.revision > old;
  }, revision);
  await fingers.move(1, center.x, center.y - 42);
  await neutral(page);
  await fingers.cancel();
  assert.ok(Math.abs(angleDelta((await rendering(page)).camera.azimuth, beforeService)) < 0.001);
  recordCheck('touch respawn with a held stick stops movement and does not rotate the camera');
  await page.locator('#help-close').tap();

  // Deliberate switches consume their trigger; mouse movement and compatibility clicks do not switch.
  await page.mouse.move(280, 450);
  assert.equal((await controls(page)).mode, 'touch');
  await page.keyboard.down('w');
  assert.equal((await controls(page)).mode, 'desktop');
  await neutral(page);
  await page.keyboard.up('w');
  await page.keyboard.down('s');
  assert.ok(magnitude((await controls(page)).input) > 0.99);
  await page.keyboard.up('s');
  await page.mouse.move(280, 450);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(100);
  assert.ok((await rendering(page)).camera.zoom > 1);
  await fingers.down(1, 300, 400);
  await fingers.move(1, 250, 400);
  await fingers.up(1);
  assert.equal((await controls(page)).mode, 'touch');
  assert.equal((await rendering(page)).camera.zoom, 1);
  assert.ok(
    Math.abs(angleDelta((await rendering(page)).camera.azimuth, beforeService)) < 0.001,
    'switching touch is consumed',
  );
  await page.mouse.wheel(0, 500);
  assert.equal((await rendering(page)).camera.zoom, 1, 'wheel disabled in touch');
  await page.mouse.click(300, 400, { button: 'right' });
  assert.equal((await controls(page)).mode, 'desktop');
  await page.waitForFunction(() => {
    const prompt = document.querySelector<HTMLButtonElement>(
      '.su-ctx[aria-keyshortcuts="Z"]:not([hidden])',
    );
    return prompt && !prompt.disabled && getComputedStyle(prompt).visibility !== 'hidden';
  });
  await page.keyboard.press('z');
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().inventory.slots.length === 1,
  );
  await page.keyboard.press('x');
  await page.getByRole('button', { name: 'Разместить в мире', exact: true }).click();
  await page.locator('#item-placement').waitFor({ state: 'visible' });
  await fingers.down(1, 300, 400);
  await fingers.up(1);
  await page.locator('#item-placement').waitFor({ state: 'hidden' });
  assert.equal(
    (await snapshot(page)).items.length,
    0,
    'switching never confirms the placement preview',
  );
  assert.equal((await snapshot(page)).inventory.slots[0].items.length, 1);
  recordCheck(
    'hybrid input: consumed switching presses, fresh keyboard input, zoom reset/wheel gating, placement cancellation',
  );
  await page.screenshot({ path: 'output/playwright/touch/portrait.png' });
  await page.locator('#help-toggle').tap();
  await fingers.down(1, center.x, center.y - 30);
  const exit = await point(page, '#leave');
  await fingers.down(2, exit.x, exit.y);
  await fingers.up(2);
  await fingers.cancel();
  await page.locator('#join:not([disabled])').waitFor();
  assert.equal((await controls(page)).mode, 'touch');
  recordCheck('touch-only entry, return to start and exit');
  await context.close();

  for (const dpr of [1, 2, 3]) {
    const qualityContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: dpr,
      hasTouch: true,
      isMobile: true,
    });
    const qualityPage = await qualityContext.newPage();
    qualityPage.on('pageerror', (error) => errors.push(error.message));
    if (dpr === 1) {
      let first = true;
      await qualityPage.route('**/api/world', (route) => {
        if (first) {
          first = false;
          return route.abort();
        }
        return route.continue();
      });
    }
    await qualityPage.goto(app.url + '/?diagnostics=1');
    if (dpr === 1) {
      await qualityPage.waitForFunction(
        () => (window as any).__SU_DEBUG__.snapshot().connection === 'error',
      );
      await qualityPage.locator('#join').tap();
      recordCheck('touch retry recovers a failed initial world load');
    }
    await qualityPage.locator('#join:not([disabled])').waitFor();
    await qualityPage.locator('#join').tap();
    await playing(qualityPage);
    const standard = await rendering(qualityPage);
    assert.deepEqual(standard.renderSize, { width: 390, height: 844 });
    await qualityPage.locator('#help-toggle').tap();
    await qualityPage.locator('#diagnostics-toggle').tap();
    await qualityPage.locator('#help-panel').waitFor({ state: 'hidden' });
    await qualityPage.locator('#quality').selectOption('economy');
    const economy = await rendering(qualityPage);
    assert.equal(economy.hardwareScaling, 1.5);
    assert.equal(economy.renderSize.width, 260);
    assert.equal(economy.renderSize.height, 562);
    assert.equal(economy.camera.halfWidth, standard.camera.halfWidth);
    assert.equal(economy.camera.halfHeight, standard.camera.halfHeight);
    assert.equal(economy.pixelRatio, dpr);
    sizes.push({ dpr, standard: standard.renderSize, economy: economy.renderSize });
    await qualityContext.close();
  }
  recordCheck('DPR 1/2/3: CSS-density standard and 2/3 economy raster, unchanged world frame');
  const desktop = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: false,
  });
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(app.url + '/?diagnostics=1');
  await desktopPage.locator('#join:not([disabled])').waitFor();
  assert.equal((await controls(desktopPage)).mode, 'desktop', 'width alone never enables touch');
  await desktop.close();
  assert.deepEqual(errors, []);
  await writeFile(
    'output/playwright/touch/result.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        result: 'passed',
        browser: browser.version(),
        renderer: 'SwiftShader; functional emulation, not mobile hardware performance',
        database: 'isolated PostgreSQL schema',
        checks,
        sizes,
        browserErrors: errors,
        manualDevices: 'not tested: iPhone/Safari, Android/Chrome, tablet',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Touch browser journey passed. Artifacts: output/playwright/touch/.');
} catch (error) {
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) {
      if (!page.url().includes('?diagnostics=1')) continue;
      await page.screenshot({ path: 'output/playwright/touch/failure.png' }).catch(() => {});
      await writeFile(
        'output/playwright/touch/failure.json',
        JSON.stringify(
          await page
            .evaluate(() => ({
              events: (window as any).__SU_TEST_EVENTS__,
              controls: (window as any).__SU_DEBUG__?.controls(),
              snapshot: (window as any).__SU_DEBUG__?.snapshot(),
              report: (window as any).__SU_DEBUG__?.report(),
            }))
            .catch(() => null),
          null,
          2,
        ),
      );
    }
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
