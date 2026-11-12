import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { createDelayRelay } from './helpers/tcp-delay.js';
import { ANIMATIONS, WORLD_ACTIVITY_MOVE_DURATION_MS } from '../packages/contracts/src/index.js';

const output = 'output/playwright/animations';
const app = await createGameServer({ port: 0 });
const relay = await createDelayRelay(new URL(app.url), {
  name: 'animation-observer',
  rttMs: 100,
  jitterMs: 20,
});
const browser = await launchTestBrowser();
const errors: string[] = [],
  checks: string[] = [];
const phaseErrorsMs: number[] = [];
const snapshot = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const avatar = (page: Page, id: string) =>
  page.evaluate(
    (id) => (window as any).__SU_DEBUG__.avatars().find((a: any) => a.entityId === id),
    id,
  );
async function active(page: Page, id: string, animation: string) {
  await page.waitForFunction(
    ({ id, animation }) => {
      const a = (window as any).__SU_DEBUG__.avatars().find((a: any) => a.entityId === id);
      return (
        a?.animation.id === animation &&
        a.animation.reason === 'playing' &&
        a.animation.weight > 0.9
      );
    },
    { id, animation },
  );
}
async function idle(page: Page) {
  await page.waitForFunction(() => {
    const state = (window as any).__SU_DEBUG__.snapshot();
    return (
      !state.animation.busy &&
      !state.animation.pending &&
      state.animation.grounded &&
      !state.animation.moving
    );
  });
}
try {
  await mkdir(output, { recursive: true });
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })),
  );
  for (const context of contexts)
    await context.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  for (const [index, page] of pages.entries()) {
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${index ? relay.url : app.url}/?diagnostics=1`);
    await page
      .locator(`input[name="avatar-skin"][value="${index ? 'standard' : 'minifigure'}"]`)
      .check();
    await page.locator('#join:not([disabled])').click();
    await page.waitForFunction(
      () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    );
  }
  for (const [index, sender] of pages.entries()) {
    const observer = pages[1 - index];
    const id = (await snapshot(sender)).authoritative.entityId;
    await idle(sender);
    await sender.locator('#animations-toggle').click();
    assert.equal(await sender.locator('.animation-choice').count(), 3);
    assert.equal(await sender.locator('.animation-choice:focus').count(), 1);
    await sender.keyboard.press('Escape');
    assert.equal(await sender.locator('#world:focus').count(), 1);
    await sender.locator('#animations-toggle').click();
    await sender.keyboard.press('t');
    await sender.locator('#chat-input:focus').waitFor();
    assert.equal(await sender.locator('#animations-panel').isVisible(), false);
    await sender.locator('#animations-toggle').click();
    assert.equal(await sender.locator('#chat-console').isVisible(), false);
    assert.equal(await sender.locator('#animations-panel').isVisible(), true);
    await sender.keyboard.press('Escape');
    for (const definition of ANIMATIONS) {
      await idle(sender);
      if (definition.id === 'wave') {
        await sender.locator('#chat-toggle').click();
        await sender.locator('#chat-input').fill('Привет из меню анимаций!');
        await sender.locator('#chat-input').press('Enter');
        await sender.locator('#chat-console').waitFor({ state: 'hidden' });
      }
      await sender.locator('#animations-toggle').click();
      await sender.locator(`[data-animation-id="${definition.id}"]`).click();
      await Promise.all([active(sender, id, definition.id), active(observer, id, definition.id)]);
      await sender.locator('#animations-panel').waitFor({ state: 'hidden' });
      for (const page of [sender, observer]) {
        const error =
          await page.evaluate<number>(`new Promise(resolve => requestAnimationFrame(() => {
          const debug = window.__SU_DEBUG__;
          const playback = debug.snapshot().displayAnimations.find(a => a.entityId === ${JSON.stringify(id)});
          const rendered = debug.avatars().find(a => a.entityId === ${JSON.stringify(id)}).animation;
          resolve(Math.abs((playback.displayTick-playback.startedAtTick)*1000/60-rendered.elapsedMs));
        }))`);
        phaseErrorsMs.push(error);
        assert.ok(error <= 100, `phase differs from display time by ${error}ms`);
      }
      const a = await avatar(sender, id);
      assert.equal(a.skinId, index ? 'standard' : 'minifigure');
      if (index === 0) {
        await sender.waitForTimeout(WORLD_ACTIVITY_MOVE_DURATION_MS + 200);
        await Promise.all([active(sender, id, definition.id), active(observer, id, definition.id)]);
        assert.ok((await avatar(sender, id)).animation.elapsedMs > WORLD_ACTIVITY_MOVE_DURATION_MS);
        await sender.locator('#animations-toggle').click();
        assert.equal(
          await sender.locator('.animation-choice:not([disabled])').count(),
          ANIMATIONS.length,
        );
        await sender.keyboard.press('Escape');
      }
      if (definition.id === 'wave') {
        await sender.locator('#reactions-toggle').click();
        await sender.locator('[data-reaction-id="hello"]').click();
        await observer.locator(`.player-reaction[data-entity-id="${id}"]`).waitFor();
        assert.equal(
          await observer.locator(`.player-chat[data-entity-id="${id}"]`).isVisible(),
          true,
        );
        assert.equal((await avatar(sender, id)).animation.reason, 'playing');
        await sender.locator('#world').focus();
        await sender.keyboard.down('s');
        await sender.waitForFunction((id) => {
          const a = (window as any).__SU_DEBUG__.avatars().find((a: any) => a.entityId === id);
          return (
            a.animation.reason === 'playing' && a.movement > 0.3 && Math.abs(a.pose.leftLeg) > 0.02
          );
        }, id);
        await sender.keyboard.up('s');
      }
      if (definition.id === 'dance') {
        await sender.locator('#chat-toggle').click();
        await sender.locator('#chat-input').fill('wasd qer');
        await sender.keyboard.press('Escape');
        assert.equal((await avatar(sender, id)).animation.reason, 'playing');
        const initial = (await snapshot(sender)).authoritative.position;
        await sender.locator('#world').focus();
        await sender.keyboard.down('Shift');
        await sender.waitForTimeout(150);
        assert.equal((await avatar(sender, id)).animation.reason, 'playing');
        await sender.keyboard.up('Shift');
        await sender.screenshot({
          path: `${output}/${index ? 'standard' : 'minifigure'}-dance.png`,
        });
        await sender.keyboard.down('s');
        await sender.waitForTimeout(200);
        await sender.keyboard.up('s');
        await Promise.all([active(sender, id, definition.id), active(observer, id, definition.id)]);
        const after = (await snapshot(sender)).authoritative.position;
        assert.ok(Math.hypot(after.x - initial.x, after.z - initial.z) < 3);
      } else {
        await sender.screenshot({
          path: `${output}/${index ? 'standard' : 'minifigure'}-${definition.id}.png`,
        });
      }
      if (definition.id === 'clap') {
        await sender.locator('#world').focus();
        await sender.keyboard.down('s');
        await sender.waitForTimeout(200);
        await sender.keyboard.up('s');
      }
      await Promise.all(
        [sender, observer].map((page) =>
          page.waitForFunction(
            (id) => {
              const a = (window as any).__SU_DEBUG__.avatars().find((a: any) => a.entityId === id);
              return a?.animation.reason !== 'playing';
            },
            id,
            { timeout: WORLD_ACTIVITY_MOVE_DURATION_MS + 2500 },
          ),
        ),
      );
      await idle(sender);
    }
  }
  checks.push(
    'three clips on both skins reach independent clients, including an observer with 100ms RTT and jitter',
  );
  checks.push(
    'all clips loop beyond five seconds while idle and permit another selection after the cooldown; wave preserves walking legs and shares the reaction sticker',
  );
  checks.push(
    'movement starts a five-second countdown for every clip including dance; stopping does not cancel it and sprint alone does not start it',
  );
  checks.push('catalog, keyboard focus, Escape, successful close and pending/busy recovery');
  checks.push(
    'chat and animation panels close each other; chat typing preserves dance; chat, reaction and gesture coexist with a shared action sequence',
  );
  const sender = pages[0];
  await sender.locator('#animations-toggle').click();
  await sender.locator('#reactions-toggle').click();
  assert.equal(await sender.locator('#animations-panel').isVisible(), false);
  await sender.keyboard.press('Escape');
  for (const size of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await sender.setViewportSize(size);
    await sender.locator('#animations-toggle').click();
    const box = await sender.locator('#animations-panel').boundingBox();
    assert.ok(
      box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= size.width + 1 &&
        box.y + box.height <= size.height + 1,
    );
    if (size.width < 430) {
      const actions = await sender.locator('.actions').boundingBox();
      assert.ok(actions && box.y + box.height < actions.y);
    }
    await sender.screenshot({ path: `${output}/menu-${size.width}.png` });
    await sender.keyboard.press('Escape');
  }
  checks.push(
    'panels close each other and the animation menu fits portrait and landscape viewports',
  );
  await sender.setViewportSize({ width: 1280, height: 720 });
  await sender.emulateMedia({ reducedMotion: 'reduce' });
  await sender.locator('#animations-toggle').click();
  await sender.locator('[data-animation-id="dance"]').click();
  const id = (await snapshot(sender)).authoritative.entityId;
  await active(sender, id, 'dance');
  assert.ok(Math.abs((await avatar(sender, id)).pose.roll) <= 0.0241);
  await contexts[0].setOffline(true);
  await sender.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
  );
  assert.equal(await sender.locator('#animations-panel').isVisible(), false);
  await contexts[0].setOffline(false);
  await sender.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  await idle(sender);
  assert.equal((await snapshot(sender)).animation.busy, false);
  checks.push(
    'reduced motion limits body sway; disconnect cancels the performer without replay after reconnect',
  );
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    browser: browser.version(),
    checks,
    errors,
    relay: relay.metrics(),
    phaseErrorsMs,
    result: 'passed',
  };
  await writeFile(`${output}/browser.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await relay.close();
  await app.close();
}
