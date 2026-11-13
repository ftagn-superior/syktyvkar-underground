import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';
import { chatSent, hudClick, openChat } from './helpers/hud.js';

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
  await openChat(page);
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send:not([disabled])').click();
}
try {
  app = await createGameServer({ port: 0, accounts: fixture, itemCreationEnabled: true });
  fixture.config.publicOrigin = app.url;
  const port = Number(new URL(app.url).port);
  browser = await launchTestBrowser({ channel: 'chromium' });
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const observerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  for (const context of [ownerContext, observerContext])
    await context.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  const owner = await ownerContext.newPage(),
    observer = await observerContext.newPage();
  for (const page of [owner, observer]) {
    page.setDefaultTimeout(30_000);
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
  await chatSent(owner);
  assert.equal(
    await observer.locator('#notice').textContent(),
    'Чтобы получить предмет, войдите через Telegram.',
  );
  assert.equal(await observer.locator('.player-chat').count(), 0);
  assert.equal(app.room.state.items.size, initialWorldCount);

  await hudClick(owner, '#chat-toggle');
  await owner.locator('#chat-input').fill('/giveme wooden-crate');
  assert.equal(
    await owner.locator('#chat-send').isDisabled(),
    false,
    'private commands bypass the ordinary speech cooldown',
  );
  await mkdir('output/playwright', { recursive: true });
  await owner.screenshot({ path: 'output/playwright/giveme-received.png' });
  // Creation retains its independent server-enforced two-second cooldown.
  await owner.waitForTimeout(2100);
  await owner.locator('#chat-send:not([disabled])').click();
  await inventoryCount(owner, 2);
  await chatSent(owner);
  await command(owner, '/giveme missing');
  await owner
    .locator('#notice')
    .filter({ hasText: 'Неизвестный тип предмета: missing.' })
    .waitFor();
  await inventoryCount(owner, 2);
  assert.equal(await observer.locator('.player-chat').count(), 0);
  await owner.keyboard.press('Escape');

  const newTypes = [
    ['confidence-monument', '🗿 Памятник уверенности · 4 м'],
    ['giant-soap', '🧼 Гигантское мыло'],
    ['giant-domino', '🁣 Домино ростом с человека'],
    ['watermelon-ball', '🍉 Мяч-арбуз'],
  ] as const;
  for (const [index, [typeId, label]] of newTypes.entries()) {
    await owner.waitForTimeout(2100);
    await command(owner, `/giveme ${typeId}`);
    await inventoryCount(owner, 3 + index);
    await chatSent(owner);
    await owner.locator('#inventory-toggle').click();
    assert.equal(
      await owner.locator(`.inventory-choice[data-type-id="${typeId}"]`).getAttribute('title'),
      label.slice(label.indexOf(' ') + 1),
    );
    await owner.locator(`.inventory-choice[data-type-id="${typeId}"]`).click();
    // A rotated sphere must still sit on the ground, rather than hover on box half extents.
    if (typeId === 'watermelon-ball')
      for (let turn = 0; turn < 3; turn++) await owner.keyboard.press('s');
    const confirm = owner.getByRole('button', { name: 'Поставить', exact: true });
    let found = false;
    for (const y of [420, 400, 440, 460, 480, 500, 380]) {
      for (const x of [580, 600, 620, 660, 680, 700, 540, 740]) {
        await owner.mouse.move(x, y);
        await owner.waitForTimeout(50);
        if (await confirm.isEnabled()) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    assert.ok(found, `${typeId} has supported placement within reach`);
    await owner.screenshot({ path: `output/playwright/catalog-${typeId}-preview.png` });
    await confirm.click();
    await inventoryCount(owner, 2 + index);
    await observer.bringToFront();
    await observer.waitForFunction(
      (id) => (window as any).__SU_DEBUG__.snapshot().items.some((item: any) => item.typeId === id),
      typeId,
    );
    await observer.screenshot({ path: `output/playwright/catalog-${typeId}-world.png` });
    await owner.bringToFront();
    await owner.getByRole('button', { name: 'Подобрать · Z', exact: true }).click();
    await inventoryCount(owner, 3 + index);
  }

  const issuedIds: string[] = await owner.evaluate(() =>
    (window as any).__SU_DEBUG__
      .snapshot()
      .inventory.slots.flatMap((s: any) => s.items.map((i: any) => i.itemId)),
  );
  await owner.locator('#inventory-toggle').click();
  // Keep the compound item placed across a full server restart.
  await owner.locator('.inventory-choice[data-type-id="confidence-monument"]').click();
  const confirm = owner.getByRole('button', { name: 'Поставить', exact: true });
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
  await inventoryCount(owner, 5);
  await observer.waitForFunction(
    (expected) => (window as any).__SU_DEBUG__.snapshot().items.length === expected,
    initialWorldCount + 1,
  );
  const placedId = [...app.room.state.items.values()].find((i) =>
    issuedIds.includes(i.entityId),
  )!.entityId;
  await owner.screenshot({ path: 'output/playwright/giveme-placed.png' });

  for (const page of [owner, observer]) await hudClick(page, '#leave');
  await app.close();
  app = await createGameServer({ port, accounts: fixture, itemCreationEnabled: false });
  fixture.config.publicOrigin = app.url;
  await owner.bringToFront();
  await owner.goto(app.url + '/?diagnostics=1');
  await owner.locator('#join:not([disabled])').click();
  await playing(owner);
  await inventoryCount(owner, 5);
  assert.equal(app.room.state.items.has(placedId), true, 'placed grant survives restart');
  assert.equal(app.room.state.items.get(placedId)!.typeId, 'confidence-monument');
  await owner.screenshot({ path: 'output/playwright/catalog-monument-restored.png' });
  await command(owner, '/giveme wooden-crate');
  await owner
    .locator('#notice')
    .filter({ hasText: 'Создание предметов отключено на сервере.' })
    .waitFor();
  await inventoryCount(owner, 5);
  await owner.keyboard.press('Escape');
  await owner.getByRole('button', { name: 'Подобрать · Z', exact: true }).click();
  await inventoryCount(owner, 6);
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
