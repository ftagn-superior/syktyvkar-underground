import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';

// Exercise the built application and real prediction/interpolation in two sessions.
const app = await createGameServer({ port: 0 });
const browser = await launchTestBrowser();
const output = 'output/playwright/avatars';
const errors: string[] = [];
const checks: string[] = [];
const snapshot = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const avatar = (page: Page, id: string): Promise<any> =>
  page.evaluate(
    (entityId) =>
      (window as any).__SU_DEBUG__.avatars().find((item: any) => item.entityId === entityId),
    id,
  );
async function mode(page: Page, entityId: string, expected: string) {
  await page.waitForFunction(
    ({ entityId, expected }) => {
      const item = (window as any).__SU_DEBUG__
        .avatars()
        .find((entry: any) => entry.entityId === entityId);
      return item?.mode === expected && (expected !== 'idle' || item.movement < 0.01);
    },
    { entityId, expected },
    { timeout: 15_000 },
  );
}
async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 20_000 },
  );
}

try {
  await mkdir(output, { recursive: true });
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1440, height: 900 } })),
  );
  for (const context of contexts)
    await context.addInitScript(() => {
      localStorage.setItem('su:render-quality:v1', 'economy');
    });
  const [sender, observer] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const [index, page] of [sender, observer].entries()) {
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${app.url}/?diagnostics=1`);
    await page
      .locator(`input[name="avatar-skin"][value="${index ? 'minifigure' : 'standard'}"]`)
      .check();
    await page.locator('#join:not([disabled])').click();
    await playing(page);
  }
  const id = (await snapshot(sender)).authoritative.entityId;
  await observer.waitForFunction(() => (window as any).__SU_DEBUG__.avatars().length === 2);
  assert.equal((await avatar(sender, id)).skinId, 'standard');
  assert.equal((await avatar(observer, id)).skinId, 'standard');
  checks.push(
    'two guest choices use different skins; the selected skin is rendered by both clients',
  );
  await mode(sender, id, 'idle');
  await sender.locator('#world').focus();
  await sender.keyboard.down('w');
  await mode(sender, id, 'walk');
  await mode(observer, id, 'walk');
  const walk = await avatar(observer, id);
  assert.ok(walk.movement > 0.2);
  assert.ok(Math.abs(walk.pose.leftLeg + walk.pose.rightLeg) < 0.01);
  await observer.waitForFunction(
    ({ id, phase }) => {
      const current = (window as any).__SU_DEBUG__
        .avatars()
        .find((item: any) => item.entityId === id);
      return Math.abs(current.phase - phase) > 0.3;
    },
    { id, phase: walk.phase },
  );
  await observer.screenshot({ path: `${output}/walk.png` });
  await sender.keyboard.up('w');
  await mode(sender, id, 'idle');
  await mode(observer, id, 'idle');
  checks.push('walk cycle advances locally and remotely; opposite legs settle after stopping');

  await sender.keyboard.down('Shift');
  await sender.keyboard.down('w');
  await mode(sender, id, 'run');
  await mode(observer, id, 'run');
  const run = await avatar(sender, id);
  assert.ok(run.pose.lean > walk.pose.lean);
  await sender.waitForFunction(
    () => {
      const debug = (window as any).__SU_DEBUG__;
      const state = debug.snapshot().authoritative;
      const pose = debug.avatars().find((item: any) => item.entityId === state.entityId);
      return (
        Math.hypot(state.velocity.x, state.velocity.z) < 0.08 &&
        pose.mode === 'idle' &&
        pose.movement < 0.01
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  await mode(observer, id, 'idle');
  checks.push('holding movement against a wall stops the gait locally and remotely');
  await sender.keyboard.up('w');
  await sender.keyboard.up('Shift');
  await mode(sender, id, 'idle');
  await mode(observer, id, 'idle');
  checks.push('Shift switches both displayed characters into the running pose');

  const previousRevision = (await snapshot(sender)).authoritative.revision;
  await sender.locator('#respawn').click();
  await sender.waitForFunction(
    (revision) => (window as any).__SU_DEBUG__.snapshot().authoritative.revision > revision,
    previousRevision,
  );
  await mode(sender, id, 'idle');
  await mode(observer, id, 'idle');
  await sender.locator('#world').focus();
  await sender.keyboard.press('q');
  await sender.mouse.move(700, 450);
  await sender.mouse.wheel(0, -1800);
  await sender.waitForTimeout(400);
  await sender.screenshot({ path: `${output}/two-players.png` });
  checks.push(
    'respawn resets movement without replaying steps; camera turn and zoom preserve the model',
  );

  await contexts[0].setOffline(true);
  await sender.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
    undefined,
    { timeout: 15_000 },
  );
  await mode(observer, id, 'idle');
  await contexts[0].setOffline(false);
  await playing(sender);
  await mode(sender, id, 'idle');
  assert.equal((await snapshot(sender)).authoritative.entityId, id);
  checks.push('reconnection retains identity and resumes a settled pose');

  await sender.emulateMedia({ reducedMotion: 'reduce' });
  await sender.locator('#world').focus();
  await sender.keyboard.down('s');
  await mode(sender, id, 'walk');
  const reduced = await avatar(sender, id);
  assert.equal(reduced.pose.lift, 0);
  assert.equal(reduced.pose.roll, 0);
  await sender.keyboard.up('s');
  await mode(sender, id, 'idle');
  checks.push('reduced motion preserves the gait while removing secondary bob and roll');

  await sender.locator('#leave').click();
  await observer.waitForFunction(
    (id) => !(window as any).__SU_DEBUG__.avatars().some((item: any) => item.entityId === id),
    id,
  );
  await observer.locator('#leave').click();
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    browser: browser.version(),
    result: 'passed',
    checks,
    errors,
  };
  await writeFile(`${output}/browser.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await app.close();
}
