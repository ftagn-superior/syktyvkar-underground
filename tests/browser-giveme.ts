import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';

if (!process.env.SU_TEST_DATABASE_URL) throw new Error('Use pnpm test:giveme:browser.');
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
const errors: string[] = [];
async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
  );
}
async function inventoryCount(page: Page, expected: number) {
  await page.waitForFunction(
    (count) =>
      (window as any).__SU_DEBUG__.snapshot().inventory.slots.flatMap((s: any) => s.items)
        .length === count,
    expected,
  );
}
async function command(page: Page, text: string) {
  await page.bringToFront();
  await page.locator('#chat-toggle').click();
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send:not([disabled])').click();
}
try {
  app = await createGameServer({ port: 0, accounts: fixture, itemCreationEnabled: true });
  fixture.config.publicOrigin = app.url;
  const port = Number(new URL(app.url).port);
  browser = await launchTestBrowser();
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const observerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const owner = await ownerContext.newPage(),
    observer = await observerContext.newPage();
  for (const page of [owner, observer]) {
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => errors.push(error.message));
  }
  await owner.goto(app.url);
  await owner.locator('#telegram-login').click();
  await owner.locator('#profile-form').waitFor({ state: 'visible' });
  for (const page of [owner, observer]) {
    await page.goto(app.url + '/?diagnostics=1');
    await page.locator('#join:not([disabled])').click();
    await playing(page);
  }
  const initialWorldCount = app.room.state.items.size;
  await command(observer, '/giveme wooden-crate');
  await observer.locator('#notice').filter({ hasText: 'войдите через Telegram' }).waitFor();
  assert.equal(await owner.locator('.player-chat').count(), 0);
  await observer.keyboard.press('Escape');
  await command(owner, '/giveme wooden-crate');
  await inventoryCount(owner, 1);
  await owner
    .locator('#notice')
    .filter({ hasText: 'Получен предмет: Деревянный ящик ×1.' })
    .waitFor();
  await owner.locator('#chat-console').waitFor({ state: 'hidden' });
  assert.equal(
    await observer.locator('#notice').textContent(),
    'Чтобы получить предмет, войдите через Telegram.',
  );
  assert.equal(await observer.locator('.player-chat').count(), 0);
  assert.equal(app.room.state.items.size, initialWorldCount);

  await owner.locator('#chat-toggle').click();
  await owner.locator('#chat-input').fill('/giveme wooden-crate');
  assert.equal(
    await owner.locator('#chat-send').isDisabled(),
    true,
    'composer respects the grant cooldown',
  );
  await mkdir('output/playwright', { recursive: true });
  await owner.screenshot({ path: 'output/playwright/giveme-received.png' });
  await owner.locator('#chat-send:not([disabled])').click();
  await inventoryCount(owner, 2);
  await owner.locator('#chat-console').waitFor({ state: 'hidden' });
  await command(owner, '/giveme missing');
  await owner
    .locator('#notice')
    .filter({ hasText: 'Неизвестный тип предмета: missing.' })
    .waitFor();
  await inventoryCount(owner, 2);
  assert.equal(await observer.locator('.player-chat').count(), 0);
  await owner.keyboard.press('Escape');

  const issuedIds: string[] = await owner.evaluate(() =>
    (window as any).__SU_DEBUG__
      .snapshot()
      .inventory.slots.flatMap((s: any) => s.items.map((i: any) => i.itemId)),
  );
  await owner.getByRole('button', { name: 'Инвентарь · I', exact: true }).click();
  await owner.getByRole('button', { name: '📦 Деревянный ящик × 2', exact: true }).click();
  const confirm = owner.getByRole('button', { name: 'Разместить', exact: true });
  let found = false;
  for (const y of [420, 400, 440, 460, 480]) {
    for (const x of [580, 600, 620, 660, 680, 700]) {
      await owner.mouse.move(x, y);
      await owner.waitForTimeout(50);
      if (await confirm.isEnabled()) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  assert.ok(found, 'issued item has a valid placement preview');
  await confirm.click();
  await inventoryCount(owner, 1);
  await observer.waitForFunction(
    (expected) => (window as any).__SU_DEBUG__.snapshot().items.length === expected,
    initialWorldCount + 1,
  );
  const placedId = [...app.room.state.items.values()].find((i) =>
    issuedIds.includes(i.entityId),
  )!.entityId;
  await owner.screenshot({ path: 'output/playwright/giveme-placed.png' });

  for (const page of [owner, observer]) await page.locator('#leave').click();
  await app.close();
  app = await createGameServer({ port, accounts: fixture, itemCreationEnabled: false });
  fixture.config.publicOrigin = app.url;
  await owner.goto(app.url + '/?diagnostics=1');
  await owner.locator('#join:not([disabled])').click();
  await playing(owner);
  await inventoryCount(owner, 1);
  assert.equal(app.room.state.items.has(placedId), true, 'placed grant survives restart');
  await command(owner, '/giveme wooden-crate');
  await owner
    .locator('#notice')
    .filter({ hasText: 'Создание предметов отключено на сервере.' })
    .waitFor();
  await inventoryCount(owner, 1);
  await owner.keyboard.press('Escape');
  await owner.getByRole('button', { name: 'Подобрать · F', exact: true }).click();
  await inventoryCount(owner, 2);
  assert.equal(
    app.room.state.items.has(placedId),
    false,
    'existing issued item remains usable with creation disabled',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Browser giveme: private feedback, guest rejection, cooldown, unknown type, inventory, public placement and restart with creation disabled passed.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
}
