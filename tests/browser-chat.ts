import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import {
  CHAT_MAX_LENGTH,
  WORLD_ACTIVITY_MOVE_DURATION_MS,
} from '../packages/contracts/src/index.js';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { rotateCamera } from './helpers/camera.js';
import { hudClick } from './helpers/hud.js';

// Run after build with SU_TEST_DATABASE_URL to use a disposable database schema.
const app = await createGameServer({
  port: 0,
  worldDirectory: process.env.SU_TEST_WORLD_DIRECTORY,
});
const browser = await launchTestBrowser({ channel: 'chromium' });
const errors: string[] = [];
const checks: string[] = [];
const output = 'output/playwright/chat';
async function playing(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 20_000 },
  );
}
async function startMovementCountdown(page: Page, entityId: string) {
  await page.bringToFront();
  await page.locator('#world').focus();
  const player = [...app.room.state.players.values()].find((p) => p.entityId === entityId)!;
  await page.keyboard.down('d');
  try {
    const deadline = performance.now() + 5000;
    while (!player.chatExpiresAtTick) {
      assert.ok(performance.now() < deadline, 'movement starts the server chat countdown');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.ok(player.chatExpiresAtTick <= app.room.state.serverTick + 300);
  } finally {
    await page.keyboard.up('d');
  }
}

try {
  await mkdir(output, { recursive: true });
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })),
  );
  const [sender, observer] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const [index, page] of [sender, observer].entries()) {
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (error) => errors.push(error.message));
    await contexts[index].addInitScript(() =>
      localStorage.setItem('su:render-quality:v1', 'economy'),
    );
    await page.bringToFront();
    await page.goto(`${app.url}/?diagnostics=1`);
    await page.locator('#join:not([disabled])').waitFor({ timeout: 45_000 });
    await page
      .locator(`input[name="avatar-skin"][value="${index ? 'standard' : 'minifigure'}"]`)
      .check();
    await page.locator('#join').click();
    await playing(page);
  }
  const senderId = await sender.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.entityId,
  );
  await observer.waitForFunction(
    (id) =>
      (window as any).__SU_DEBUG__
        .avatars()
        .some((avatar: any) => avatar.entityId === id && avatar.skinId === 'minifigure'),
    senderId,
  );
  await sender.bringToFront();
  await sender.locator('#world').focus();
  await sender.keyboard.down('e');
  await sender.keyboard.down('d');
  await sender.waitForTimeout(200);
  await sender.keyboard.press('t');
  await sender.locator('#chat-input:focus').waitFor();
  assert.equal(await sender.locator('#chat-input').inputValue(), '');
  // Opening chat clears keys already held before focus entered the text field.
  await sender.waitForTimeout(400);
  const stopped = await sender.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.position,
  );
  const chatAngle = await sender.evaluate(
    () => (window as any).__SU_DEBUG__.report().rendering.camera.azimuth,
  );
  await sender.keyboard.type('wasd qer zxft');
  await sender.waitForTimeout(300);
  const afterTyping = await sender.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.position,
  );
  assert.ok(Math.hypot(afterTyping.x - stopped.x, afterTyping.z - stopped.z) < 0.05);
  assert.ok(
    Math.abs(
      (await sender.evaluate(
        () => (window as any).__SU_DEBUG__.report().rendering.camera.azimuth,
      )) - chatAngle,
    ) < 0.001,
    'opening chat stops a held rotation; typing Q/E does not orbit the camera',
  );
  assert.equal(await sender.locator('#reactions-panel').isVisible(), false);
  await sender.keyboard.up('d');
  await sender.keyboard.up('e');
  await sender.keyboard.press('Escape');
  assert.equal(await sender.locator('#chat-console').isVisible(), false);
  assert.equal(await sender.locator('#world:focus').count(), 1);
  await sender.keyboard.press('/');
  await sender.locator('#chat-input:focus').waitFor();
  assert.equal(await sender.locator('#chat-input').inputValue(), '/');
  assert.equal(await sender.locator('#chat-counter').textContent(), '1 / 255');
  await sender.keyboard.type('giveme');
  assert.equal(await sender.locator('#chat-input').inputValue(), '/giveme');
  await sender.keyboard.press('/');
  assert.equal(await sender.locator('#chat-input').inputValue(), '/giveme/');
  await sender.keyboard.press('Escape');
  await sender.keyboard.press('t');
  // Collapsing keeps the unsent draft.
  assert.equal(await sender.locator('#chat-input').inputValue(), '/giveme/');
  await sender.locator('#chat-input').fill('');
  await sender.keyboard.press('Escape');
  await sender.locator('#help-toggle').click();
  await sender.locator('#chat-toggle').focus();
  await sender.keyboard.press('Escape');
  assert.equal(await sender.locator('#chat-console').isVisible(), false);
  await sender.keyboard.press('t');
  await sender.locator('#chat-input').fill('   ');
  await sender.keyboard.press('Enter');
  assert.equal(await sender.locator('#chat-console').isVisible(), true);
  assert.equal(await observer.locator('.player-chat').count(), 0);
  checks.push(
    'T opens empty input, / opens with one slash and preserves typing, held movement stops, typing triggers no game shortcuts, Escape collapses and keeps the draft, blank messages stay unsent',
  );

  const input = sender.locator('#chat-input');
  // IME confirmation must not send a partially composed message.
  await input.fill('Привет');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  assert.equal(await sender.locator('#chat-console').isVisible(), true);
  assert.equal(await observer.locator('.player-chat').count(), 0);
  await input.dispatchEvent('compositionend');
  const message = 'Привет, <b>сосед</b>! 🙂';
  await input.fill(message);
  await input.press('Enter');
  const bubble = `.player-chat[data-entity-id="${senderId}"]`;
  await Promise.all([sender.locator(bubble).waitFor(), observer.locator(bubble).waitFor()]);
  // By default Enter sends and collapses the field, returning focus to the world.
  await sender.locator('#chat-console').waitFor({ state: 'hidden' });
  await sender.locator('#world:focus').waitFor();
  await sender.waitForFunction(
    () => (document.getElementById('chat-input') as HTMLInputElement).value === '',
  );
  assert.equal(await observer.locator(bubble).textContent(), message);
  assert.equal(await observer.locator(`${bubble} b`).count(), 0);
  await observer.locator('#chat-log .chat-line').filter({ hasText: message }).waitFor();
  await sender.locator('#chat-log .chat-line').filter({ hasText: 'Вы:' }).waitFor();
  // Shift+Enter sends after the one-second cooldown and keeps the field open, empty and focused;
  // the new message replaces the one still above the head.
  await sender.keyboard.press('t');
  await input.fill('Следующее');
  await sender.locator('#chat-send:not([disabled])').waitFor({ timeout: 2000 });
  await input.press('Shift+Enter');
  await observer.locator(bubble).filter({ hasText: 'Следующее' }).waitFor();
  await sender.locator('#chat-input:focus').waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(await sender.locator('#chat-console').isVisible(), true);
  await sender.keyboard.press('Escape');
  assert.equal(await sender.locator('#chat-console').isVisible(), false);
  assert.equal(await sender.locator('#world:focus').count(), 1);
  await sender.waitForTimeout(WORLD_ACTIVITY_MOVE_DURATION_MS + 300);
  assert.equal(await sender.locator(bubble).textContent(), 'Следующее');
  assert.equal(await observer.locator(bubble).textContent(), 'Следующее');
  checks.push(
    'Enter sends and collapses, Shift+Enter sends and keeps the field open, a new message replaces the visible one, and stationary messages outlive five seconds',
  );
  await sender.keyboard.press('r');
  await sender.locator('.reaction-choice[data-reaction-id="hello"]').click();
  await observer.locator(`.player-reaction[data-entity-id="${senderId}"]`).waitFor();
  assert.equal(await observer.locator(bubble).isVisible(), true);
  const before = await observer
    .locator(bubble)
    .evaluate((node) => (node as HTMLElement).style.transform);
  await startMovementCountdown(sender, senderId);
  await rotateCamera(observer, -0.39, false);
  await observer.waitForFunction(
    ({ selector, before }) => {
      const node = document.querySelector<HTMLElement>(selector);
      return node && node.style.transform !== before;
    },
    { selector: bubble, before },
  );
  assert.notEqual(
    await observer.locator(bubble).evaluate((node) => (node as HTMLElement).style.transform),
    before,
  );
  await sender.keyboard.press('t');
  await input.fill('Следующее');
  if (await sender.evaluate(() => (window as any).__SU_DEBUG__.snapshot().chat.remainingMs > 0)) {
    // The replicated movement countdown precedes the next periodic HUD update.
    await sender.waitForFunction(
      () => (document.querySelector('#chat-send') as HTMLButtonElement).disabled,
      undefined,
      { timeout: 1500 },
    );
    assert.equal(await sender.locator('#chat-send').isDisabled(), true);
  }
  await sender.keyboard.press('Escape');
  await Promise.all([
    sender.locator(bubble).waitFor({ state: 'detached', timeout: 7000 }),
    observer.locator(bubble).waitFor({ state: 'detached', timeout: 7000 }),
  ]);
  checks.push(
    'Enter delivers literal text to both players; text follows the character and camera, coexists with reactions, and expires five seconds after movement even after stopping',
  );

  await hudClick(sender, '#chat-toggle');
  await input.fill('я'.repeat(CHAT_MAX_LENGTH - 1));
  await input.press('End');
  await sender.keyboard.type('абв');
  assert.equal((await input.inputValue()).length, CHAT_MAX_LENGTH);
  assert.equal(await sender.locator('#chat-counter').textContent(), '255 / 255');
  await sender.locator('#chat-send:not([disabled])').waitFor();
  await input.press('Enter');
  await observer.locator(bubble).waitFor();
  await sender.locator('#chat-console').waitFor({ state: 'hidden' });
  assert.equal((await observer.locator(bubble).textContent())!.length, CHAT_MAX_LENGTH);
  for (const page of [sender, observer]) {
    assert.equal(
      await page.evaluate((needle) => {
        for (const storage of [localStorage, sessionStorage])
          for (const key of Object.keys(storage))
            if (storage.getItem(key)?.includes(needle)) return true;
        return false;
      }, 'я'.repeat(100)),
      false,
    );
  }
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 700 },
    { width: 640, height: 360 },
  ]) {
    await sender.setViewportSize(viewport);
    await hudClick(sender, '#chat-toggle');
    for (const selector of ['#chat-console', '#chat-input', '#chat-send', bubble]) {
      assert.equal(
        await sender.locator(selector).evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const panel = node.closest('#chat-console')?.getBoundingClientRect();
          return (
            rect.x >= 0 &&
            rect.y >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight &&
            (!panel || (rect.top >= panel.top && rect.bottom <= panel.bottom))
          );
        }),
        true,
        `${selector} fits ${viewport.width}x${viewport.height}`,
      );
    }
    await sender.screenshot({ path: `${output}/${viewport.width}x${viewport.height}.png` });
    await sender.keyboard.press('Escape');
  }
  checks.push(
    'typing enforces 255 characters, counters agree, long text wraps and input fits desktop, narrow and short viewports; no browser history is stored',
  );
  await sender.locator('#world').focus();
  await startMovementCountdown(sender, senderId);
  await Promise.all([
    sender.locator(bubble).waitFor({ state: 'detached', timeout: 7000 }),
    observer.locator(bubble).waitFor({ state: 'detached', timeout: 7000 }),
  ]);
  checks.push('the same five-second movement countdown applies to messages of maximum length');
  await observer.reload();
  await playing(observer);
  assert.equal(await observer.locator('.player-chat').count(), 0);
  checks.push('reloading a session does not replay an expired message');
  await hudClick(sender, '#chat-toggle');
  await input.fill('До встречи!');
  await sender.locator('#chat-send:not([disabled])').waitFor();
  await input.press('Enter');
  await observer.locator(bubble).waitFor();
  await hudClick(sender, '#leave');
  await observer.locator(bubble).waitFor({ state: 'detached', timeout: 2000 });
  checks.push(
    'chat works with the minifigure skin and is removed with the avatar when its player leaves',
  );
  assert.deepEqual(errors, []);
  await writeFile(`${output}/checks.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
  await app.close();
}
