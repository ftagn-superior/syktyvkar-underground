import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import { rotateCamera } from './camera.js';

/** Functional city routes run after the fixed one-player comparison has been sampled. */
export async function cityLodPlay(browser: Browser, page: Page, url: string) {
  const ready = (p: Page) =>
    p.waitForFunction(
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
      { timeout: 180000 },
    );
  const position = (p: Page) =>
    p.evaluate(() => (window as any).__SU_DEBUG__.snapshot().authoritative.position);
  await page.locator('#world').dispatchEvent('wheel', { deltaY: -Math.log(30) * 1000 });
  await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await ready(page);
  const start = await position(page),
    route: unknown[] = [];
  for (const key of ['w', 'd', 's', 'a']) {
    await page.locator('#world').focus();
    await page.keyboard.down(key);
    try {
      await page.waitForTimeout(1000);
    } finally {
      await page.keyboard.up(key);
    }
    route.push(await position(page));
  }
  assert.ok(route.some((p: any) => Math.hypot(p.x - start.x, p.z - start.z) > 0.15));
  for (let i = 0; i < 8; i++) await rotateCamera(page, Math.PI / 4);
  await ready(page);
  await page.locator('#world').focus();
  await page.keyboard.press('v');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().view === 'first-person');
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(900);
    if (await page.evaluate(() => !!document.pointerLockElement)) break;
    await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable);
    await page.locator('#world').click({ position: { x: 160, y: 180 } });
  }
  await page.waitForFunction(() => !!document.pointerLockElement);
  await page.keyboard.down('w');
  try {
    await page.waitForTimeout(1000);
  } finally {
    await page.keyboard.up('w');
  }
  await page.keyboard.press('v');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.controls().view === 'overview');
  await ready(page);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobileErrors: string[] = [];
  try {
    const mobile = await context.newPage();
    mobile.on('pageerror', (e) => mobileErrors.push(e.message));
    await mobile.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
    await mobile.goto(url + '/?diagnostics=1');
    await mobile.locator('#join:not([disabled])').click({ timeout: 120000 });
    await ready(mobile);
    await mobile.locator('#touch-stick').waitFor({ state: 'visible' });
    const box = (await mobile.locator('#touch-stick').boundingBox())!,
      x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    const cdp = await context.newCDPSession(mobile),
      before = await position(mobile);
    const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', dy = 0) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints:
          type === 'touchEnd' ? [] : [{ x, y: y + dy, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
      });
    await send('touchStart');
    await send('touchMove', -30);
    try {
      await mobile.waitForFunction(
        (p) => {
          const s = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
          return Math.hypot(s.x - p.x, s.z - p.z) > 0.15;
        },
        before,
        { timeout: 15000 },
      );
    } finally {
      await send('touchEnd');
    }
    const controls = await mobile.evaluate(() => (window as any).__SU_DEBUG__.controls());
    assert.equal(controls.mode, 'touch');
    assert.equal(
      await mobile.evaluate(() => (window as any).__SU_DEBUG__.report().rendering.camera.zoom),
      1,
    );
    assert.deepEqual(mobileErrors, []);
    return {
      route,
      desktopFirstPerson: true,
      fullOrbit: true,
      touch: { before, after: await position(mobile), zoom: 1 },
    };
  } finally {
    await context.close();
  }
}
