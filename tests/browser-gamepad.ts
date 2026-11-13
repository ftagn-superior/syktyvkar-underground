import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { buildWorld } from '../tools/world-build/src/index.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';

// This models the Gamepad API boundary. It does not certify Xbox drivers, Edge Game Controls,
// physical buttons, television readability, audio user activation, or console performance.
if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('Set SU_TEST_DATABASE_URL to a disposable test PostgreSQL database.');
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const temporary = await mkdtemp(join(tmpdir(), 'su-gamepad-browser-'));
const output = 'output/playwright/gamepad';
const checks: string[] = [];
const errors: string[] = [];
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
let diagnosticPage: Page | undefined;
const snapshot = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const controls = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.controls());
const rendering = (page: Page): Promise<any> =>
  page.evaluate(() => (window as any).__SU_DEBUG__.report().rendering);
const magnitude = (input: { moveX: number; moveZ: number }) => Math.hypot(input.moveX, input.moveZ);
const record = (message: string) => {
  checks.push(message);
  console.log(`Passed: ${message}`);
};
const forbidden = [
  'requestChat',
  'requestReaction',
  'requestAnimation',
  'itemCommand',
  'placeStatic',
  'removeStatic',
];

async function installGamepadBoundary(context: BrowserContext): Promise<void> {
  // Raw JS avoids transpiler name-preservation helpers inside this browser-owned boundary.
  await context.addInitScript({
    content: `
    const state = { pads: [], failure: false, reads: 0 };
    window.__SU_TEST_GAMEPADS__ = state;
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => {
        state.reads++;
        if (state.failure) throw new DOMException('Gamepad fixture denial', 'SecurityError');
        // Real applications must reread snapshots, not retain the object from a connection event.
        return state.pads.map(
          (pad) =>
            pad && {
          ...pad,
          axes: [...pad.axes],
          buttons: pad.buttons.map((button) => ({ ...button })),
              timestamp: performance.now(),
            },
        );
      },
    });
    localStorage.setItem('su:help-tip:v1', '1');
    localStorage.setItem('su:render-quality:v1', 'economy');
  `,
  });
}

class Pad {
  constructor(
    readonly page: Page,
    readonly index = 2,
  ) {}
  async connect(mapping = 'standard'): Promise<void> {
    await this.page.evaluate(
      ({ index, mapping }) => {
        const state = (window as any).__SU_TEST_GAMEPADS__;
        const gamepad = {
          index,
          id: 'Xbox Wireless Controller (API fixture)',
          connected: true,
          mapping,
          axes: [0, 0, 0, 0],
          buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
        };
        while (state.pads.length <= index) state.pads.push(null);
        state.pads[index] = gamepad;
        const event = new Event('gamepadconnected');
        Object.defineProperty(event, 'gamepad', { value: gamepad });
        window.dispatchEvent(event);
      },
      { index: this.index, mapping },
    );
    await this.page.waitForTimeout(70);
  }
  async disconnect(): Promise<void> {
    await this.page.evaluate((index) => {
      const state = (window as any).__SU_TEST_GAMEPADS__;
      const gamepad = state.pads[index];
      state.pads[index] = null;
      const event = new Event('gamepaddisconnected');
      Object.defineProperty(event, 'gamepad', { value: gamepad });
      window.dispatchEvent(event);
    }, this.index);
    await this.page.waitForTimeout(100);
  }
  async axes(axes: number[]): Promise<void> {
    await this.page.evaluate(
      ({ index, axes }) => {
        (window as any).__SU_TEST_GAMEPADS__.pads[index].axes = axes;
      },
      { index: this.index, axes },
    );
  }
  async button(button: number, value: number): Promise<void> {
    const reads = await this.page.evaluate(
      ({ index, button, value }) => {
        (window as any).__SU_TEST_GAMEPADS__.pads[index].buttons[button] = {
          value,
          pressed: value > 0.5,
          touched: value > 0,
        };
        return (window as any).__SU_TEST_GAMEPADS__.reads;
      },
      { index: this.index, button, value },
    );
    await this.page.waitForFunction(
      (before) => (window as any).__SU_TEST_GAMEPADS__.reads > before,
      reads,
    );
  }
  async press(button: number): Promise<void> {
    await this.page.waitForFunction((index) => {
      const state = (window as any).__SU_DEBUG__.controls().gamepad;
      return state.activeIndex !== index || state.ready;
    }, this.index);
    await this.button(button, 1);
    await this.page.waitForTimeout(30);
    await this.button(button, 0);
    await this.page.waitForTimeout(150);
  }
  async neutral(): Promise<void> {
    await this.page.evaluate((index) => {
      const pad = (window as any).__SU_TEST_GAMEPADS__.pads[index];
      pad.axes = [0, 0, 0, 0];
      for (const button of pad.buttons)
        Object.assign(button, { value: 0, pressed: false, touched: false });
    }, this.index);
    await this.page.waitForTimeout(180);
    await this.page.waitForFunction((index) => {
      const state = (window as any).__SU_DEBUG__.controls().gamepad;
      return state.activeIndex !== index || state.ready;
    }, this.index);
  }
  async choose(): Promise<void> {
    await this.press(0);
    await this.page.waitForFunction((index) => {
      const controls = (window as any).__SU_DEBUG__.controls();
      return controls.mode === 'gamepad' && controls.gamepad.activeIndex === index;
    }, this.index);
    await this.neutral();
  }
}

async function playing(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
  );
}
async function available(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().gamepadAvailable);
}
async function stopped(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const input = (window as any).__SU_DEBUG__.controls().input;
    return Math.hypot(input.moveX, input.moveZ) === 0;
  });
  await page.waitForTimeout(220);
  const before = (await snapshot(page)).authoritative?.position;
  await page.waitForTimeout(300);
  const after = (await snapshot(page)).authoritative?.position;
  if (!before || !after) return; // Reconnection can temporarily remove the client's state.
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 0.06, 'server position stops');
}
async function focus(page: Page, id: string): Promise<void> {
  await page.waitForFunction((expected) => {
    const node = document.getElementById(expected);
    return document.activeElement === node || node?.classList.contains('gamepad-focus');
  }, id);
}
async function resume(pad: Pad): Promise<void> {
  await pad.neutral();
  await pad.page.waitForFunction(() => {
    const controls = (window as any).__SU_DEBUG__.controls();
    return (
      controls.gamepadAvailable ||
      (controls.gamepadResumeRequired &&
        controls.gamepad.ready &&
        controls.gamepadContext === 'walk')
    );
  });
  if ((await controls(pad.page)).gamepadResumeRequired) await pad.press(0);
  await available(pad.page);
}
async function openMenu(pad: Pad): Promise<void> {
  await pad.press(3);
  await pad.page.locator('#help-panel').waitFor({ state: 'visible' });
  await pad.neutral();
}

try {
  await mkdir(output, { recursive: true });
  await cp('content', join(temporary, 'content'), { recursive: true });
  const source = join(temporary, 'content/worlds/physics-lab/world.json');
  const authored = JSON.parse(await readFile(source, 'utf8'));
  authored.initialItems = [
    {
      seedId: 'gamepad-crate',
      typeId: 'wooden-crate',
      position: { x: -3, y: 0.52, z: 2 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
  ];
  await writeFile(source, JSON.stringify(authored));
  const release = join(temporary, 'release');
  await buildWorld(source, release);
  app = await createGameServer({
    port: 0,
    accounts: fixture,
    worldDirectory: release,
    clientDirectory: process.env.SU_GAMEPAD_CLIENT_DIRECTORY,
  });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser({ channel: 'chromium' });
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await installGamepadBoundary(guestContext);
  const ownerContext = await browser.newContext({ viewport: { width: 800, height: 600 } });
  await installGamepadBoundary(ownerContext);
  const page = await guestContext.newPage();
  diagnosticPage = page;
  const owner = await ownerContext.newPage();
  const sent: Record<string, number> = {};
  for (const current of [page, owner]) {
    current.setDefaultTimeout(30_000);
    current.on('pageerror', (error) => errors.push(error.message));
    current.on('websocket', (socket) =>
      socket.on('framesent', ({ payload }) => {
        const frame = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        for (const type of [...forbidden, 'requestRespawn'])
          if (frame.includes(Buffer.from(type))) sent[type] = (sent[type] ?? 0) + 1;
      }),
    );
  }
  await page.goto(app.url + '/?diagnostics=1');
  await page.bringToFront();
  await page.locator('#join:not([disabled])').waitFor();
  const pad = new Pad(page);
  await pad.connect();
  assert.equal((await controls(page)).mode, 'desktop', 'connection alone does not select gamepad');
  await pad.choose();
  assert.equal(await page.locator('#welcome').isVisible(), true, 'selection A does not join');
  await focus(page, 'join');
  const initialSkin = await page.locator('input[name="avatar-skin"]:checked').inputValue();
  await pad.press(13); // previous skin
  await pad.press(13); // next skin
  await focus(page, 'preview-next');
  await pad.press(0);
  assert.notEqual(
    await page.locator('input[name="avatar-skin"]:checked').inputValue(),
    initialSkin,
  );
  await page.waitForTimeout(550);
  await focus(page, 'preview-next'); // periodic UI updates retain the logical target
  await pad.press(12);
  await pad.press(12);
  await focus(page, 'join');
  await pad.button(0, 1);
  await playing(page);
  await page.waitForTimeout(450);
  await pad.neutral();
  await available(page);
  assert.equal(app.room.state.players.size, 1, 'held entry A creates one player');
  record(
    'sparse nonzero controller index; selection A is consumed; lobby skin, stable focus and single guest join',
  );

  // Prepare an existing authorization through real HTTP/OIDC. Initial Telegram UI is outside MVP.
  diagnosticPage = owner;
  const login = await ownerContext.request.get(app.url + '/api/auth/telegram');
  assert.equal(login.status(), 200);
  await owner.goto(app.url + '/?diagnostics=1');
  await owner.bringToFront();
  await owner.locator('#profile-form').waitFor({ state: 'visible' });
  console.log('Account fixture authenticated; selecting controller and skin.');
  const ownerPad = new Pad(owner, 4);
  await ownerPad.connect();
  await owner.locator('#profile-name').focus();
  await ownerPad.press(0);
  assert.equal(
    (await controls(owner)).mode,
    'desktop',
    'editable profile field prevents A takeover',
  );
  await owner.locator('#join').focus();
  await ownerPad.choose();
  const oldSkin = await owner.locator('input[name="avatar-skin"]:checked').inputValue();
  await ownerPad.press(13);
  await ownerPad.press(13);
  await ownerPad.press(0);
  const selectedSkin = await owner.locator('input[name="avatar-skin"]:checked').inputValue();
  assert.notEqual(selectedSkin, oldSkin);
  await ownerPad.press(12);
  await ownerPad.press(12);
  await focus(owner, 'join');
  await ownerPad.press(0);
  console.log(
    'Account join requested:',
    JSON.stringify(await controls(owner)),
    await owner.locator('#account-message').textContent(),
  );
  await playing(owner);
  await ownerPad.neutral();
  await available(owner);
  const profile = await ownerContext.request.get(app.url + '/api/me');
  assert.equal(
    (await profile.json()).account.profile.skinId,
    selectedSkin,
    'prepareJoin saves account skin',
  );
  const ownerMessages = { ...sent };
  for (const key of ['v', 't', 'r', 'z', 'i', 'x', '1']) await owner.keyboard.press(key);
  for (const id of ['chat-toggle', 'reactions-toggle', 'animations-toggle', 'inventory-toggle'])
    await owner.locator('#' + id).evaluate((node: HTMLElement) => node.click());
  await owner.waitForTimeout(350);
  assert.equal((await controls(owner)).mode, 'gamepad');
  for (const type of forbidden)
    assert.equal(sent[type] ?? 0, ownerMessages[type] ?? 0, `account does not send ${type}`);
  await page.bringToFront();
  diagnosticPage = page;
  await resume(pad);
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().entities.length === 2);
  const entityId = (await snapshot(page)).authoritative.entityId;
  const origin = (await snapshot(page)).authoritative.position;
  const startAngle = (await rendering(page)).camera.azimuth;
  await pad.axes([0, -0.65, 0.7, 0]);
  await page.waitForFunction(
    (startAngle) => {
      const debug = (window as any).__SU_DEBUG__;
      const input = debug.controls().input;
      const magnitude = Math.hypot(input.moveX, input.moveZ);
      return (
        magnitude > 0.4 &&
        magnitude < 0.8 &&
        Math.abs(debug.report().rendering.camera.azimuth - startAngle) > 0.1
      );
    },
    startAngle,
    { timeout: 10_000 },
  );
  const moving = await controls(page);
  assert.ok(magnitude(moving.input) > 0.4 && magnitude(moving.input) < 0.8, 'partial analog speed');
  assert.ok(
    Math.abs((await rendering(page)).camera.azimuth - startAngle) > 0.1,
    'right stick rotates while moving',
  );
  await page.waitForFunction(
    (origin) => {
      const position = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
      return Math.hypot(position.x - origin.x, position.z - origin.z) > 0.4;
    },
    origin,
    { timeout: 10_000 },
  );
  const serverPosition = (await snapshot(page)).authoritative.position;
  assert.ok(Math.hypot(serverPosition.x - origin.x, serverPosition.z - origin.z) > 0.4);
  await owner.waitForFunction(
    ({ entityId, origin }) => {
      const entity = (window as any).__SU_DEBUG__
        .snapshot()
        .entities.find((item: any) => item.entityId === entityId);
      return entity && Math.hypot(entity.position.x - origin.x, entity.position.z - origin.z) > 0.4;
    },
    { entityId, origin },
  );
  await pad.button(7, 0.6);
  await page.waitForTimeout(80);
  assert.equal((await controls(page)).input.sprint, true);
  await pad.button(7, 0.5);
  await page.waitForTimeout(80);
  assert.equal((await controls(page)).input.sprint, true);
  await pad.button(7, 0.4);
  await page.waitForTimeout(80);
  assert.equal((await controls(page)).input.sprint, false);
  await pad.axes([1, -1, 0, 0]);
  await page.waitForTimeout(80);
  assert.ok(magnitude((await controls(page)).input) <= 1.000001, 'diagonal capped');
  await pad.neutral();
  await stopped(page);
  record(
    'account skin persists; two real clients observe analog walking, simultaneous camera, RT hysteresis and stopping',
  );

  const beforeForbidden = { ...sent };
  for (const key of ['v', 't', 'r', 'z', 'i', 'x', '1']) await page.keyboard.press(key);
  for (const id of ['chat-toggle', 'reactions-toggle', 'animations-toggle', 'inventory-toggle']) {
    await page.locator('#' + id).evaluate((node: HTMLElement) => node.click());
  }
  await page.waitForTimeout(400);
  assert.equal((await controls(page)).mode, 'gamepad');
  assert.equal((await controls(page)).view, 'overview');
  for (const type of forbidden)
    assert.equal(sent[type] ?? 0, beforeForbidden[type] ?? 0, `${type} is not sent`);
  for (const selector of [
    '#chat-console',
    '#reactions-panel',
    '#animations-panel',
    '#inventory-panel',
    '#item-placement',
  ])
    assert.equal(await page.locator(selector).isVisible(), false, `${selector} stays closed`);
  record(
    'restricted hotkeys and direct DOM button activation do not open panels or send forbidden commands',
  );
  await page.keyboard.press('w');
  assert.equal((await controls(page)).mode, 'desktop');
  assert.equal(
    magnitude((await controls(page)).input),
    0,
    'switching desktop movement press is consumed',
  );
  await pad.choose();
  await available(page);
  record(
    'movement key switches to desktop without movement; explicit A safely selects gamepad again',
  );

  await pad.axes([0, -0.7, 0.8, 0]);
  await openMenu(pad);
  await stopped(page);
  await pad.press(13); // sound
  const muted = await page.locator('#audio-toggle').getAttribute('aria-pressed');
  await pad.press(0);
  assert.notEqual(await page.locator('#audio-toggle').getAttribute('aria-pressed'), muted);
  await pad.press(13); // quality
  await pad.press(15);
  assert.equal(await page.locator('#quality').inputValue(), 'standard');
  await pad.press(14);
  assert.equal(await page.locator('#quality').inputValue(), 'economy');
  await page.screenshot({ path: output + '/menu-720.png' });
  await pad.press(1);
  await page.locator('#help-panel').waitFor({ state: 'hidden' });
  await resume(pad);
  await openMenu(pad);
  await pad.press(13);
  await pad.press(13);
  await pad.press(13); // respawn
  const respawnBefore = sent.requestRespawn ?? 0;
  await pad.button(0, 1);
  await page.waitForTimeout(450);
  await pad.neutral();
  await playing(page);
  await resume(pad);
  assert.equal(sent.requestRespawn, respawnBefore + 1, 'held respawn A sends one request');
  record(
    'Y menu stops both sticks; sound and both qualities reuse existing settings; respawn sends once',
  );

  // Disconnect must clear ownership even if the browser later reuses the same index.
  await pad.axes([0, -0.7, 0.8, 0]);
  await page.waitForTimeout(150);
  await pad.disconnect();
  await stopped(page);
  await pad.connect();
  await pad.axes([0, -0.7, 0.8, 0]);
  await page.waitForTimeout(200);
  assert.equal(magnitude((await controls(page)).input), 0);
  await pad.choose();
  await resume(pad);
  await pad.axes([0, -0.7, 0.8, 0]);
  await page.waitForTimeout(100);
  const cdp = await guestContext.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const other = await guestContext.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await page.waitForFunction(() => !document.hasFocus());
  await stopped(page);
  await page.bringToFront();
  await page.waitForFunction(() => !document.hidden && document.hasFocus());
  await page.waitForTimeout(200);
  assert.equal(
    magnitude((await controls(page)).input),
    0,
    'held sticks remain stopped after focus',
  );
  await pad.neutral();
  assert.equal((await controls(page)).gamepadResumeRequired, true);
  await pad.press(0);
  await available(page);
  await other.close();
  record(
    'disconnect/index reuse and genuine tab focus loss require explicit selection or neutral plus resume A',
  );

  await pad.axes([0, -0.7, 0.8, 0]);
  await guestContext.setOffline(true);
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
  );
  await stopped(page);
  await guestContext.setOffline(false);
  await playing(page);
  assert.equal(magnitude((await controls(page)).input), 0);
  await resume(pad);
  assert.equal((await snapshot(page)).authoritative.entityId, entityId);
  record('network recovery preserves player identity and rejects held movement');

  // Inject an outage only into this fixture's item store, preserving the real pause/reconcile path.
  const store = (app.room as any).items.store;
  const originalConnect = store.connect;
  let storageFailed = true;
  store.connect = async function () {
    if (storageFailed) throw new Error('Gamepad fixture storage outage');
    return originalConnect.call(this);
  };
  try {
    await pad.axes([0, -0.7, 0.8, 0]);
    store.onConnectionFailure();
    await page.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().storagePaused);
    await stopped(page);
    storageFailed = false;
    await page.waitForFunction(() => !(window as any).__SU_DEBUG__.snapshot().storagePaused);
    await playing(page);
    assert.equal(magnitude((await controls(page)).input), 0);
    await resume(pad);
  } finally {
    storageFailed = false;
    store.connect = originalConnect;
  }
  record(
    'isolated storage outage pauses movement and requires explicit resume after reconciliation',
  );

  await pad.axes([0, -0.7, 0.8, 0]);
  assert.equal(
    await page.evaluate(() => {
      const extension = (document.querySelector('#world') as HTMLCanvasElement)
        .getContext('webgl2')
        ?.getExtension('WEBGL_lose_context');
      if (!extension) return false;
      (window as any).__SU_TEST_GL__ = extension;
      extension.loseContext();
      return true;
    }),
    true,
  );
  await page.locator('#graphics-recovery').waitFor({ state: 'visible' });
  await focus(page, 'graphics-reload');
  await stopped(page);
  await page.evaluate(() => (window as any).__SU_TEST_GL__.restoreContext());
  await page.locator('#graphics-recovery').waitFor({ state: 'hidden' });
  await playing(page);
  assert.equal(magnitude((await controls(page)).input), 0);
  await resume(pad);
  record('WebGL recovery independently clears sticks and requires resume');

  // Keep the allowed menu open while resizing can prepare a wider streaming region.
  await openMenu(pad);
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    await pad.neutral();
    for (let index = 0; index < 4; index++) await pad.press(12);
    for (let index = 0; index < 4; index++) await pad.press(13);
    const selected = await page.evaluate(() => {
      const node = document.querySelector('.gamepad-focus') ?? document.activeElement;
      const rect = node!.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        width: innerWidth,
        font: parseFloat(getComputedStyle(node!).fontSize),
        screenHeight: innerHeight,
      };
    });
    assert.ok(
      selected.top >= 0 && selected.bottom <= selected.screenHeight,
      'focused row stays onscreen',
    );
    assert.ok(selected.height >= 44 && selected.font >= 18, 'TV row/text dimensions');
    await pad.press(0); // exit confirmation
    await pad.press(3); // Y must not dismiss the confirmation
    assert.equal(await page.locator('#help-panel').isVisible(), true);
    await pad.press(1); // cancel
    await focus(page, 'gamepad-exit');
  }
  record(
    '1080p and short Edge viewport keep focused TV rows reachable; exit confirmation supports B cancellation',
  );

  await pad.press(0);
  await pad.press(13);
  await pad.button(0, 1);
  await page.locator('#welcome').waitFor({ state: 'visible' });
  await pad.neutral();
  await focus(page, 'join');
  await pad.press(0);
  await playing(page);
  await pad.neutral();
  await available(page);
  await page.screenshot({ path: output + '/walk.png' });
  record('confirmed leave returns focus to lobby join; gamepad can enter again');

  const failureContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await installGamepadBoundary(failureContext);
  let worldFailure = true;
  let accountFailure = true;
  await failureContext.route('**/api/world', (route) => {
    if (!worldFailure) return route.continue();
    worldFailure = false;
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await failureContext.route('**/api/me', (route) => {
    if (!accountFailure) return route.continue();
    accountFailure = false;
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  const failed = await failureContext.newPage();
  diagnosticPage = failed;
  failed.on('pageerror', (error) => errors.push(error.message));
  await failed.goto(app.url + '/?diagnostics=1');
  await failed.bringToFront();
  await failed.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'error',
  );
  await failed.locator('#account-retry').waitFor({ state: 'visible' });
  assert.equal(
    await rendering(failed),
    null,
    'world renderer was never created after initial world failure',
  );
  const recoveryPad = new Pad(failed, 1);
  await recoveryPad.connect();
  await recoveryPad.choose();
  for (let index = 0; index < 4; index++) await recoveryPad.press(13);
  await focus(failed, 'account-retry');
  await recoveryPad.press(0);
  await failed.locator('#account-retry').waitFor({ state: 'hidden' });
  await failed.locator('#join:not([disabled])').waitFor();
  await recoveryPad.neutral();
  await focus(failed, 'join');
  await recoveryPad.press(0);
  await failed.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'ready',
  );
  await failureContext.close();
  diagnosticPage = page;
  await page.bringToFront();
  await resume(pad);
  record(
    'account retry and initial world reload are reachable through independent polling before the world renderer exists',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    output + '/result.json',
    JSON.stringify(
      {
        kind: 'simulated Gamepad API; hardware acceptance open',
        checks,
        errors,
        browser: browser.version(),
        clientDirectory: process.env.SU_GAMEPAD_CLIENT_DIRECTORY ?? 'dist/client',
        controls: await controls(page),
        sent,
      },
      null,
      2,
    ),
  );
  console.log(
    `Gamepad browser checks passed (${checks.length}). Hardware acceptance remains open.`,
  );
} catch (error) {
  const state =
    diagnosticPage &&
    (await diagnosticPage
      .evaluate(() => ({
        focus: document.hasFocus(),
        hidden: document.hidden,
        active: document.activeElement?.id,
        controls: (window as any).__SU_DEBUG__?.controls(),
        snapshot: (window as any).__SU_DEBUG__?.snapshot(),
      }))
      .catch(() => null));
  await diagnosticPage?.screenshot({ path: output + '/failure.png' }).catch(() => {});
  await writeFile(
    output + '/failure.json',
    JSON.stringify({ checks, errors, error: String(error), state }, null, 2),
  ).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
