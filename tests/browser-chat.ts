import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { CHAT_MAX_LENGTH } from '../packages/contracts/src/index.js';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';

// Run after build with SU_TEST_DATABASE_URL to use a disposable database schema.
const app = await createGameServer({
  port: 0,
  worldDirectory: process.env.SU_TEST_WORLD_DIRECTORY,
});
const browser = await launchTestBrowser();
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
try {
  await mkdir(output, { recursive: true });
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })),
  );
  const [sender, observer] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of [sender, observer]) {
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${app.url}/?diagnostics=1`);
    await page.locator('#join:not([disabled])').waitFor({ timeout: 45_000 });
    await page.locator('#join').click();
    await playing(page);
  }
  await sender.bringToFront();
  await sender.locator('#world').focus();
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
  await sender.keyboard.type('wasd qer ift');
  await sender.waitForTimeout(300);
  const afterTyping = await sender.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.position,
  );
  assert.ok(Math.hypot(afterTyping.x - stopped.x, afterTyping.z - stopped.z) < 0.05);
  assert.equal(await sender.locator('#reactions-panel').isVisible(), false);
  await sender.keyboard.up('d');
  await sender.keyboard.press('Escape');
  assert.equal(await sender.locator('#chat-console').isVisible(), false);
  assert.equal(await sender.locator('#world:focus').count(), 1);
  await sender.keyboard.press('t');
  assert.equal(await sender.locator('#chat-input').inputValue(), '');
  await sender.locator('#chat-toggle').focus();
  await sender.keyboard.press('Escape');
  assert.equal(await sender.locator('#chat-console').isVisible(), false);
  await sender.keyboard.press('t');
  await sender.locator('#chat-input').fill('   ');
  await sender.keyboard.press('Enter');
  assert.equal(await sender.locator('#chat-console').isVisible(), true);
  assert.equal(await observer.locator('.player-chat').count(), 0);
  checks.push(
    'T opens empty focused input, held movement stops, typing triggers no game shortcuts, Escape clears, blank messages stay unsent',
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
  const senderId = await sender.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.entityId,
  );
  const bubble = `.player-chat[data-entity-id="${senderId}"]`;
  await Promise.all([sender.locator(bubble).waitFor(), observer.locator(bubble).waitFor()]);
  await sender.locator('#chat-console').waitFor({ state: 'hidden' });
  assert.equal(await observer.locator(bubble).textContent(), message);
  assert.equal(await observer.locator(`${bubble} b`).count(), 0);
  assert.equal(await sender.locator('#world:focus').count(), 1);
  await sender.keyboard.press('r');
  await sender.locator('.reaction-choice[data-reaction-id="hello"]').click();
  await observer.locator(`.player-reaction[data-entity-id="${senderId}"]`).waitFor();
  assert.equal(await observer.locator(bubble).isVisible(), true);
  const before = await sender
    .locator(bubble)
    .evaluate((node) => (node as HTMLElement).style.transform);
  await sender.keyboard.down('d');
  await sender.waitForTimeout(200);
  await sender.keyboard.up('d');
  await sender.keyboard.press('q');
  await sender.waitForTimeout(200);
  assert.notEqual(
    await sender.locator(bubble).evaluate((node) => (node as HTMLElement).style.transform),
    before,
  );
  await sender.keyboard.press('t');
  await input.fill('Следующее');
  assert.equal(await sender.locator('#chat-send').isDisabled(), true);
  await sender.keyboard.press('Escape');
  await Promise.all([
    sender.locator(bubble).waitFor({ state: 'detached', timeout: 7000 }),
    observer.locator(bubble).waitFor({ state: 'detached', timeout: 7000 }),
  ]);
  checks.push(
    'Enter delivers literal text to both players, text follows the character and camera, coexists with reactions, expires, and protects reading time',
  );

  await sender.locator('#chat-toggle').click();
  await input.fill('я'.repeat(CHAT_MAX_LENGTH - 1));
  await input.press('End');
  await sender.keyboard.type('абв');
  assert.equal((await input.inputValue()).length, CHAT_MAX_LENGTH);
  assert.equal(await sender.locator('#chat-counter').textContent(), '255 / 255');
  await sender.locator('#chat-send:not([disabled])').waitFor();
  await input.press('Enter');
  await observer.locator(bubble).waitFor();
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
    await sender.locator('#chat-toggle').click();
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
  await sender.locator(bubble).waitFor({ state: 'detached', timeout: 16_000 });
  await observer.reload();
  await playing(observer);
  assert.equal(await observer.locator('.player-chat').count(), 0);
  checks.push('reloading a session does not replay an expired message');
  assert.deepEqual(errors, []);
  await writeFile(`${output}/checks.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
  await app.close();
}
