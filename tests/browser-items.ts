import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';
import { buildWorld } from '../tools/world-build/src/index.js';

if (!process.env.SU_TEST_DATABASE_URL) throw new Error('Use pnpm test:items:browser.');
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const temporary = await mkdtemp(join(tmpdir(), 'su-browser-items-'));
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
try {
  await cp('content', join(temporary, 'content'), { recursive: true });
  const source = join(temporary, 'content/worlds/physics-lab/world.json');
  const authored = JSON.parse(await readFile(source, 'utf8'));
  authored.initialItems = [-3, -1.6, -4.4].map((x, index) => ({
    seedId: `browser-item-${index}`,
    typeId: 'wooden-crate',
    position: { x, y: 0.52, z: 2 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  }));
  await writeFile(source, JSON.stringify(authored));
  const release = join(temporary, 'release');
  await buildWorld(source, release);
  app = await createGameServer({ port: 0, accounts: fixture, worldDirectory: release });
  fixture.config.publicOrigin = app.url;
  const port = Number(new URL(app.url).port);
  browser = await launchTestBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url + '/?diagnostics=1');
  await page.locator('#telegram-login').click();
  // Login returns to '/', so request diagnostics explicitly before joining.
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  await page.goto(app.url + '/?diagnostics=1');
  await page.locator('#join:not([disabled])').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  const originalIds = await page.evaluate(() =>
    (window as any).__SU_DEBUG__
      .snapshot()
      .items.map((i: any) => i.entityId)
      .sort(),
  );
  for (let count = 1; count <= 3; count++) {
    await page.getByRole('button', { name: 'Подобрать · F', exact: true }).click();
    await page.waitForFunction(
      (expected) =>
        (window as any).__SU_DEBUG__.snapshot().inventory.slots.flatMap((s: any) => s.items)
          .length === expected,
      count,
    );
    await page.waitForFunction(
      () => (window as any).__SU_DEBUG__.snapshot().storagePaused === false,
    );
  }
  assert.equal(app.room.state.items.size, 0);
  await page.keyboard.press('i');
  await page.getByRole('button', { name: 'Разделить пополам', exact: true }).click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().inventory.slots.length === 2,
  );
  await page
    .locator('.inventory-slot')
    .first()
    .getByRole('button', { name: 'Переместить / объединить' })
    .click();
  await page
    .locator('.inventory-slot')
    .last()
    .getByRole('button', { name: 'Поменять местами' })
    .click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().inventory.slots[0].items.length === 1,
  );
  await page
    .locator('.inventory-slot')
    .first()
    .getByRole('button', { name: 'Переместить / объединить' })
    .click();
  await page
    .locator('.inventory-slot')
    .last()
    .getByRole('button', { name: 'Объединить сюда' })
    .click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().inventory.slots.length === 1,
  );
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/items-inventory.png' });
  const chosenId = await page.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().inventory.slots[0].items[0].itemId,
  );
  await page.getByRole('button', { name: '📦 Деревянный ящик × 3', exact: true }).click();
  await page.getByRole('button', { name: 'X +15°', exact: true }).click();
  await page.getByRole('button', { name: 'Y +15°', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Разместить', exact: true });
  let found = false;
  for (const y of [420, 400, 440, 460, 480]) {
    for (const x of [580, 600, 620, 660, 680, 700]) {
      await page.mouse.move(x, y);
      await page.waitForTimeout(50);
      if (await confirm.isEnabled()) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  assert.ok(found, 'preview finds a supported free pose within reach');
  await page.screenshot({ path: 'output/playwright/items-placement.png' });
  await confirm.click();
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().items.length === 1);
  assert.equal(app.room.state.items.values().next().value!.entityId, chosenId);
  assert.ok(
    Math.abs(app.room.state.items.values().next().value!.qx) > 0.01,
    'full 3D rotation reaches the server',
  );
  await page.waitForFunction(
    () => (document.querySelector('.placement-toolbar') as HTMLElement).hidden,
  );
  await page.getByRole('button', { name: 'Подобрать · F', exact: true }).click();
  await page.waitForFunction(
    () =>
      (window as any).__SU_DEBUG__.snapshot().items.length === 0 &&
      (window as any).__SU_DEBUG__.snapshot().inventory.slots[0].items.length === 3,
  );
  await page.locator('#leave').click();
  await app.close();
  app = await createGameServer({ port, accounts: fixture, worldDirectory: release });
  fixture.config.publicOrigin = app.url;
  assert.equal(app.room.state.items.size, 0, 'restart does not repeat the three seeds');
  await page.goto(app.url + '/?diagnostics=1');
  await page.locator('#join:not([disabled])').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().inventory.slots[0]?.items.length === 3,
  );
  const restored = await page.evaluate(() =>
    (window as any).__SU_DEBUG__
      .snapshot()
      .inventory.slots.flatMap((s: any) => s.items.map((i: any) => i.itemId))
      .sort(),
  );
  assert.deepEqual(restored, originalIds);
  await page.getByRole('button', { name: 'Инвентарь · I', exact: true }).click();
  await page.locator('#inventory-panel').waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/items-inventory-small.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await writeFile(
    'output/playwright/items.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        result: 'passed',
        browser: browser.version(),
        checks: [
          'signed local OIDC login',
          'three pickups',
          'empty-world prediction',
          'split',
          'swap',
          'merge',
          'rotated preview',
          'placement of same ID',
          'pickup again',
          'restart',
          'private inventory restore',
          '390px layout',
        ],
        browserErrors: errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Items browser journey passed. Artifacts: output/playwright/items*.');
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
