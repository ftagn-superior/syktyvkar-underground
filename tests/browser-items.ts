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
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Z"]')?.disabled === false,
    );
    await page.keyboard.press('z');
    await page.waitForFunction((expected) => {
      const state = (window as any).__SU_DEBUG__.snapshot();
      return (
        state.inventory.slots.flatMap((s: any) => s.items).length === expected &&
        state.items.length === 3 - expected
      );
    }, count);
    await page.waitForFunction(
      () => (window as any).__SU_DEBUG__.snapshot().storagePaused === false,
    );
  }
  assert.equal(app.room.state.items.size, 0);
  await page.keyboard.press('x');
  assert.equal(await page.locator('.inventory-choice:focus').count(), 1);
  await page.getByRole('button', { name: 'Разделить пополам', exact: true }).click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().inventory.slots.length === 2,
  );
  await page.locator('.inventory-choice').first().click();
  await page.getByRole('button', { name: 'Переместить / объединить' }).click();
  assert.equal(await page.locator('.inventory-slot:last-child .inventory-choice:focus').count(), 1);
  // Preparing a return preserves the open inventory and selected move source.
  const beforeReturn = await page.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.revision,
  );
  // Keyboard activation avoids the HUD's intentional outside-pointer dismissal.
  await page.locator('#respawn').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction((revision) => {
    const state = (window as any).__SU_DEBUG__.snapshot();
    return state.connection === 'playing' && state.authoritative.revision > revision;
  }, beforeReturn);
  assert.equal(await page.locator('.inventory-panel').isVisible(), true);
  await page.locator('.inventory-choice').last().click();
  await page.getByRole('button', { name: 'Поменять местами' }).click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().inventory.slots[0].items.length === 1,
  );
  await page.locator('.inventory-choice').first().click();
  await page.getByRole('button', { name: 'Переместить / объединить' }).click();
  await page.locator('.inventory-choice').last().click();
  await page.getByRole('button', { name: 'Объединить сюда' }).click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().inventory.slots.length === 1,
  );
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/items-inventory.png' });
  const chosenId = await page.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().inventory.slots[0].items[0].itemId,
  );
  await page.getByRole('button', { name: '📦 Деревянный ящик × 3', exact: true }).click();
  assert.equal(await page.locator('#inventory-panel').isVisible(), true);
  const controls = () =>
    page.evaluate(() => ({
      position: (window as any).__SU_DEBUG__.snapshot().authoritative.position,
      camera: (window as any).__SU_DEBUG__.report().rendering.camera.azimuth,
    }));
  const distance = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    Math.hypot(a.x - b.x, a.z - b.z);
  // A key held before placement must not resume movement when placement ends.
  await page.keyboard.down('ArrowUp');
  await page.getByRole('button', { name: 'Разместить в мире', exact: true }).click();
  assert.equal(await page.locator('.placement-toolbar button').count(), 2);
  await page.waitForTimeout(200);
  const beforeCancel = await controls();
  await page.keyboard.down('d');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift');
  await page.waitForTimeout(250);
  assert.ok(distance((await controls()).position, beforeCancel.position) < 0.03);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.placement-toolbar').isVisible(), false);
  assert.equal(await page.locator('#controls-title').textContent(), 'Свободное движение');
  await page.waitForTimeout(250);
  assert.ok(distance((await controls()).position, beforeCancel.position) < 0.03);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('d');
  await page.keyboard.press('e');
  await page.waitForFunction(() => !(window as any).__SU_DEBUG__.report().rendering.camera.turning);
  assert.ok(Math.abs((await controls()).camera - beforeCancel.camera - Math.PI / 2) < 0.01);
  await page.keyboard.press('q');
  await page.waitForFunction(() => !(window as any).__SU_DEBUG__.report().rendering.camera.turning);

  await page.keyboard.press('x');
  await page.getByRole('button', { name: 'Разместить в мире', exact: true }).click();
  const beforeRotation = await controls();
  // Opposite pairs cancel, then S/D/E apply +15 degrees around each of the three axes.
  for (const key of ['w', 's', 'a', 'd', 'q', 'e', 's', 'd', 'e']) await page.keyboard.press(key);
  await page.waitForTimeout(300);
  const afterRotation = await controls();
  assert.ok(distance(afterRotation.position, beforeRotation.position) < 0.03);
  assert.ok(Math.abs(afterRotation.camera - beforeRotation.camera) < 0.001);
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
  // Inspect the accepted command before gravity/contact can rotate the live body.
  const placement = await fixture.pool.query(
    `SELECT request->'action'->'pose'->'rotation' AS rotation, result
     FROM item_operations
     WHERE request->'action'->>'kind'='place' AND request->'action'->>'itemId'=$1
     ORDER BY created_at DESC LIMIT 1`,
    [chosenId],
  );
  assert.equal(placement.rowCount, 1);
  assert.equal(placement.rows[0].result.ok, true);
  const rotation = placement.rows[0].rotation;
  const sin = Math.sin(Math.PI / 24),
    cos = Math.cos(Math.PI / 24);
  const expectedRotation = {
    x: sin * cos * (cos - sin),
    y: sin * cos * (cos + sin),
    z: sin * cos * (cos - sin),
    w: cos ** 3 + sin ** 3,
  };
  for (const key of ['x', 'y', 'z', 'w'] as const)
    assert.ok(
      Math.abs(rotation[key] - expectedRotation[key]) < 0.000001,
      `${key}: all six keys rotate the object by the expected 15-degree steps`,
    );
  await page.waitForFunction(
    () => (document.querySelector('.placement-toolbar') as HTMLElement).hidden,
  );
  assert.equal(await page.locator('#controls-title').textContent(), 'Свободное движение');
  await page.keyboard.press('e');
  await page.waitForFunction(() => !(window as any).__SU_DEBUG__.report().rendering.camera.turning);
  assert.ok(Math.abs((await controls()).camera - beforeRotation.camera - Math.PI / 2) < 0.01);
  await page.keyboard.press('q');
  await page.waitForFunction(() => !(window as any).__SU_DEBUG__.report().rendering.camera.turning);
  await page.getByRole('button', { name: 'Подобрать · Z', exact: true }).click();
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
  await page.getByRole('button', { name: 'Инвентарь · X', exact: true }).click();
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
          'return preserves open inventory and selected move source',
          'swap',
          'merge',
          'rotated preview',
          'WASDQE rotate all three axes in 15-degree steps without moving the player or camera',
          'held movement keys cleared and normal controls restored after cancellation and placement',
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
} catch (error) {
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) {
      console.error(
        'ITEM_TEST_DIAGNOSTICS',
        JSON.stringify(
          await page
            .evaluate(() => ({
              snapshot: (window as any).__SU_DEBUG__?.snapshot(),
              panel: document.querySelector('.inventory-panel')?.outerHTML,
              notice: document.querySelector('#notice')?.textContent,
            }))
            .catch(() => null),
        ),
      );
    }
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
