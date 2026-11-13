import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { createDelayRelay } from './helpers/tcp-delay.js';
import { ANIMATIONS, WORLD_ACTIVITY_MOVE_DURATION_MS } from '../packages/contracts/src/index.js';
import { chatSent, hudClick } from './helpers/hud.js';

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
    await sender.keyboard.press('f');
    assert.equal(await sender.locator('.animation-choice').count(), ANIMATIONS.length);
    assert.equal(
      await sender.locator('#animations-panel [data-catalog-count]').textContent(),
      String(ANIMATIONS.length),
    );
    assert.equal(await sender.locator('.animation-choice:focus').count(), 1);
    assert.equal(await sender.locator('.animation-choice[aria-keyshortcuts]').count(), 9);
    assert.equal(
      await sender.locator('.animation-choice:nth-child(n + 10) .catalog-choice-key').count(),
      0,
    );
    for (let choice = 1; choice < ANIMATIONS.length; choice++) await sender.keyboard.press('Tab');
    assert.equal(await sender.locator('.animation-choice:last-child:focus').count(), 1);
    assert.ok(
      await sender
        .locator('#animations-panel .catalog-scroll')
        .evaluate((panel) => panel.scrollTop > 0),
    );
    await sender.keyboard.press('f');
    assert.equal(await sender.locator('#world:focus').count(), 1);
    await sender.keyboard.press('f');
    assert.equal(
      await sender
        .locator('#animations-panel .catalog-scroll')
        .evaluate((panel) => panel.scrollTop),
      0,
    );
    assert.equal(await sender.locator('.animation-choice:first-child:focus').count(), 1);
    await sender.keyboard.press('t');
    await sender.locator('#chat-input:focus').waitFor();
    assert.equal(await sender.locator('#animations-panel').isVisible(), false);
    await hudClick(sender, '#animations-toggle');
    // Opening a catalog leaves the chat field as it is.
    assert.equal(await sender.locator('#chat-console').isVisible(), true);
    assert.equal(await sender.locator('#animations-panel').isVisible(), true);
    await sender.keyboard.press('Escape');
    for (const [clipIndex, definition] of ANIMATIONS.entries()) {
      await idle(sender);
      if (definition.id === 'wave') {
        await hudClick(sender, '#chat-toggle');
        await sender.locator('#chat-input').fill('Привет из меню анимаций!');
        await sender.locator('#chat-input').press('Enter');
        await chatSent(sender);
      }
      await hudClick(sender, '#animations-toggle');
      if (clipIndex < 9) await sender.keyboard.press(String(clipIndex + 1));
      else await sender.locator(`[data-animation-id="${definition.id}"]`).click();
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
      if (index === 0 && (definition.id === 'wave' || definition.id === 'dance')) {
        await sender.waitForTimeout(WORLD_ACTIVITY_MOVE_DURATION_MS + 200);
        await Promise.all([active(sender, id, definition.id), active(observer, id, definition.id)]);
        assert.ok((await avatar(sender, id)).animation.elapsedMs > WORLD_ACTIVITY_MOVE_DURATION_MS);
        await hudClick(sender, '#animations-toggle');
        assert.equal(
          await sender.locator('.animation-choice:not([disabled])').count(),
          ANIMATIONS.length,
        );
        await sender.keyboard.press('Escape');
      }
      if (definition.id === 'wave') {
        await hudClick(sender, '#reactions-toggle');
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
        await hudClick(sender, '#chat-toggle');
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
      if (definition.id !== 'wave' && definition.id !== 'dance') {
        await sender.locator('#world').focus();
        const origin = (await snapshot(sender)).authoritative.position;
        const key = clipIndex % 2 ? 'w' : 's';
        await sender.keyboard.down(key);
        try {
          await sender.waitForFunction((origin) => {
            const position = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
            return Math.hypot(position.x - origin.x, position.z - origin.z) > 0.15;
          }, origin);
        } finally {
          await sender.keyboard.up(key);
        }
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
    `all ${ANIMATIONS.length} clips on both skins reach independent clients, including an observer with 100ms RTT and jitter`,
  );
  checks.push(
    'upper-body and full-body clips loop beyond five seconds while idle and permit another selection after the cooldown; wave preserves walking legs and shares the reaction sticker',
  );
  checks.push(
    'movement starts a five-second countdown for every clip including dance; stopping does not cancel it and sprint alone does not start it',
  );
  checks.push(
    'Tab reaches the last choice and scrolls it into view; reopening restores the first choice; only 1–9 have shortcut badges; Escape and successful selection close the menu',
  );
  checks.push(
    'catalogs leave the chat field open; chat typing preserves dance; chat, reaction and gesture coexist with a shared action sequence',
  );
  const sender = pages[0];
  await hudClick(sender, '#animations-toggle');
  await hudClick(sender, '#reactions-toggle');
  assert.equal(await sender.locator('#animations-panel').isVisible(), false);
  await sender.keyboard.press('Escape');
  for (const size of [
    { width: 1280, height: 720 },
    { width: 800, height: 600 },
    { width: 390, height: 844 },
    { width: 640, height: 360 },
  ]) {
    await sender.setViewportSize(size);
    await hudClick(sender, '#animations-toggle');
    const box = await sender.locator('#animations-panel').boundingBox();
    assert.ok(
      box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= size.width + 1 &&
        box.y + box.height <= size.height + 1,
    );
    if (size.width < 430) {
      const row = await sender.locator('#chat-row').boundingBox();
      assert.ok(row && box.y + box.height < row.y);
    }
    // The catalog scrolls inside a fixed-height list under the filters.
    const panel = sender.locator('#animations-panel .catalog-scroll');
    const layout = await panel.evaluate((node) => ({
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      overflowY: getComputedStyle(node).overflowY,
      horizontalOverflow: node.scrollWidth > node.clientWidth,
    }));
    assert.equal(layout.scrollTop, 0);
    assert.equal(layout.overflowY, 'auto');
    assert.equal(layout.horizontalOverflow, false);
    assert.ok(layout.scrollHeight > layout.clientHeight);
    await sender.screenshot({ path: `${output}/menu-${size.width}-top.png` });
    await sender.locator('.animation-choice:first-child').hover();
    await sender.mouse.wheel(0, layout.scrollHeight);
    await sender.waitForFunction(() => {
      const panel = document.querySelector('#animations-panel .catalog-scroll')!;
      const last = panel.querySelector('.animation-choice:last-child')!.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(last.x + last.width / 2, last.y + last.height / 2);
      return (
        panel.scrollTop > 0 &&
        last.top >= bounds.top &&
        last.bottom <= bounds.bottom &&
        hit?.closest('.animation-choice') === panel.querySelector('.animation-choice:last-child')
      );
    });
    for (const selector of ['#animations-toggle', '#reactions-toggle', '#help-toggle']) {
      assert.ok(
        await sender.locator(selector).evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return (
            rect.x >= 0 &&
            rect.y >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight &&
            hit !== null &&
            node.contains(hit)
          );
        }),
        `${selector} remains reachable at ${size.width}x${size.height}`,
      );
    }
    await sender.screenshot({ path: `${output}/menu-${size.width}-bottom.png` });
    await sender.keyboard.press('Escape');
  }
  checks.push(
    'mouse wheel reaches the last animation without horizontal overflow; catalog and gameplay controls fit desktop, tablet, portrait and short viewports',
  );
  await sender.setViewportSize({ width: 1280, height: 720 });
  await sender.emulateMedia({ reducedMotion: 'reduce' });
  await hudClick(sender, '#animations-toggle');
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
