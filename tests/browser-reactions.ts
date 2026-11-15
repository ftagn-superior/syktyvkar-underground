import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { REACTIONS, WORLD_ACTIVITY_MOVE_DURATION_MS } from '../packages/contracts/src/index.js';
import { launchTestBrowser } from './helpers/browser.js';

// Настоящие клиенты и ввод, отдельная SQL-схема. Запуск после pnpm build.
const app = await createGameServer({
  port: 0,
  worldDirectory: process.env.SU_TEST_WORLD_DIRECTORY,
});
const browser = await launchTestBrowser();
const checks: string[] = [],
  errors: string[] = [],
  layouts: unknown[] = [];
const output = 'output/playwright/reactions';
const quality = process.env.SU_REACTIONS_QUALITY ?? 'economy';
async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 45000 },
  );
}
async function ready(page: Page) {
  await page.waitForFunction(
    () => {
      const r = (window as any).__SU_DEBUG__.snapshot().reaction;
      return r.available && !r.pending && r.remainingMs <= 0;
    },
    undefined,
    { timeout: 35000 },
  );
}
async function open(page: Page) {
  await page.bringToFront();
  await ready(page);
  if (!(await page.locator('#reactions-panel').isVisible()))
    await page.locator('#reactions-toggle').click();
}
try {
  await mkdir(output, { recursive: true });
  const info = await (await fetch(`${app.url}/api/world`)).json();
  const contexts = await Promise.all(
    [0, 1].map(async () => {
      const context = await browser.newContext({
        viewport: { width: 800, height: 600 },
        reducedMotion: 'reduce',
      });
      await context.addInitScript(
        (quality) => localStorage.setItem('su:render-quality:v1', quality),
        quality,
      );
      return context;
    }),
  );
  const [sender, observer] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of [sender, observer]) {
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${app.url}/?diagnostics=1`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('#join:not([disabled])').waitFor({ timeout: 60000 });
    await page.locator('#join').click();
    await playing(page);
  }
  const senderId = await sender.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.entityId,
  );
  const sticker = `.player-reaction[data-entity-id="${senderId}"]`;
  await open(sender);
  assert.equal(await sender.locator('.reaction-choice').count(), REACTIONS.length);
  assert.equal(await sender.locator('.reaction-choice[aria-keyshortcuts]').count(), 9);
  assert.equal(await sender.locator('.reaction-choice:first-child:focus').count(), 1);
  await sender.waitForFunction(() =>
    [...document.querySelectorAll<HTMLImageElement>('.reaction-choice img')].every(
      (i) => i.complete && i.naturalWidth > 0,
    ),
  );
  const search = sender.locator('#reaction-search');
  await search.fill('  ОТОШЕЛ  ');
  assert.equal(await sender.locator('.reaction-choice:not([hidden])').count(), 1);
  assert.equal(
    await sender
      .locator('.reaction-choice[aria-keyshortcuts="1"]')
      .getAttribute('data-reaction-id'),
    'away',
  );
  await search.fill('статус');
  await sender.locator('#reactions-panel [data-filter="Эмоции"]').click();
  assert.equal(await sender.locator('#reactions-empty').isVisible(), true);
  assert.equal(await sender.locator('.reaction-choice[aria-keyshortcuts]').count(), 0);
  await sender.locator('#reactions-panel [data-filter="Статус"]').click();
  assert.equal(await sender.locator('.reaction-choice:not([hidden])').count(), 2);
  await search.fill('busy');
  await sender.keyboard.press('1');
  assert.equal(await search.inputValue(), 'busy1', 'digits in the search are text, not actions');
  await search.fill('busy');
  await sender.keyboard.press('Enter');
  assert.equal(await sender.locator('.reaction-choice[data-reaction-id="busy"]:focus').count(), 1);
  await sender.keyboard.press('1');
  await observer.locator(`${sticker}[data-reaction-id="busy"]`).waitFor();
  checks.push(
    'поиск по подписи/ID/категории с ё/е; пересечение фильтров; пустой результат; цифры в поле — текст, Enter возвращает к результатам',
  );

  await open(sender);
  await search.fill('');
  await sender.locator('#reactions-panel [data-filter="Все"]').click();
  await sender.keyboard.press('Escape');
  await sender.keyboard.press('r');
  for (let index = 1; index < REACTIONS.length; index++) await sender.keyboard.press('Tab');
  assert.equal(await sender.locator('.reaction-choice:last-child:focus').count(), 1);
  assert.ok(
    await sender.locator('#reactions-panel .catalog-scroll').evaluate((s) => s.scrollTop > 0),
  );
  await sender.keyboard.press('Escape');
  await sender.keyboard.press('r');
  assert.equal(
    await sender.locator('#reactions-panel .catalog-scroll').evaluate((s) => s.scrollTop),
    0,
  );
  assert.equal(await sender.locator('.reaction-choice:first-child:focus').count(), 1);
  checks.push(
    'Tab достигает последней карточки; повторное открытие возвращает первый результат и начало вложенного скролла',
  );

  // Весь набор проверяем заменами в покое; общий таймер движения — отдельно ниже.
  for (let index = 0; index < REACTIONS.length; index++) {
    const reaction = REACTIONS[index];
    await open(sender);
    await sender.locator('.reaction-choice:first-child').focus();
    if (index < 9) await sender.keyboard.press(String(index + 1));
    else await sender.locator(`.reaction-choice[data-reaction-id="${reaction.id}"]`).click();
    await Promise.all(
      [sender, observer].map((page) =>
        page.locator(`${sticker}[data-reaction-id="${reaction.id}"]`).waitFor(),
      ),
    );
    await sender.locator('#reactions-panel').waitFor({ state: 'hidden' });
    assert.equal(await observer.locator(sticker).count(), 1);
    const image = observer.locator(`${sticker} img`);
    assert.equal(await image.getAttribute('alt'), reaction.label);
    assert.equal(
      await image.getAttribute('src'),
      `/reactions/${reaction.asset}?v=${info.catalogVersions.reactions}`,
    );
    await image.evaluate((i) => {
      if (!(i as HTMLImageElement).complete || !(i as HTMLImageElement).naturalWidth)
        throw new Error('sticker not loaded');
    });
  }
  assert.deepEqual(
    await sender.evaluate(() => JSON.parse(localStorage.getItem('su:recent-reactions:v1')!)),
    REACTIONS.slice(-4)
      .reverse()
      .map((r) => r.id),
  );
  await observer.screenshot({ path: `${output}/in-world.png`, animations: 'disabled' });
  await sender.waitForTimeout(WORLD_ACTIVITY_MOVE_DURATION_MS + 200);
  assert.equal(
    await observer.locator(sticker).count(),
    1,
    'idle lifetime is independent of the short selection cooldown',
  );
  await observer.reload({ waitUntil: 'domcontentloaded' });
  await playing(observer);
  await observer.locator(sticker).waitFor();
  checks.push(
    `все ${REACTIONS.length} реакций доставлены двум клиентам без дубликатов, подписи и версионированные SVG совпадают; четыре недавние; бессрочный покой и восстановление наблюдателя`,
  );

  await open(sender);
  const origin = await sender.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.position,
  );
  await sender.keyboard.down('d');
  try {
    await sender.waitForFunction((origin) => {
      const p = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
      return Math.hypot(p.x - origin.x, p.z - origin.z) > 0.2;
    }, origin);
    assert.equal(await sender.locator('#reactions-panel').isVisible(), true);
    await sender.locator('.reaction-choice[data-reaction-id="hello"]').click();
    await observer.locator(`${sticker}[data-reaction-id="hello"]`).waitFor();
  } finally {
    await sender.keyboard.up('d');
  }
  await Promise.all(
    [sender, observer].map((page) =>
      page.locator(sticker).waitFor({ state: 'detached', timeout: 12000 }),
    ),
  );
  checks.push(
    'движение работает в открытом меню; после cooldown ещё видимый стикер заменяется на ходу; общий таймер удаляет его у обоих игроков',
  );

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 800, height: 600 },
    { width: 390, height: 700 },
    { width: 640, height: 360 },
    { width: 320, height: 568 },
  ]) {
    await sender.setViewportSize(viewport);
    await open(sender);
    const panel = sender.locator('#reactions-panel');
    const scroll = panel.locator('.catalog-scroll');
    const metrics = await scroll.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      overflowY: getComputedStyle(node).overflowY,
      horizontalOverflow: node.scrollWidth > node.clientWidth,
    }));
    assert.equal(metrics.overflowY, 'auto');
    assert.equal(metrics.horizontalOverflow, false);
    assert.ok(metrics.scrollHeight > metrics.clientHeight);
    const bounds = await scroll.boundingBox();
    await sender.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await sender.mouse.wheel(0, 100000);
    await sender.waitForFunction(() => {
      const s = document.querySelector('#reactions-panel .catalog-scroll')!;
      const a = s.getBoundingClientRect(),
        b = s.querySelector('.reaction-choice:last-child')!.getBoundingClientRect();
      return s.scrollTop > 0 && b.top >= a.top && b.bottom <= a.bottom;
    });
    assert.equal(
      await panel.evaluate((n) => {
        const r = n.getBoundingClientRect();
        return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      }),
      true,
    );
    for (const filter of await panel.locator('.filters button').all())
      assert.ok(
        await filter.evaluate((n) => {
          const r = n.getBoundingClientRect(),
            p = n.parentElement!.getBoundingClientRect();
          return r.left >= p.left && r.right <= p.right;
        }),
      );
    assert.ok(
      await panel
        .locator('.label')
        .first()
        .evaluate((n) => parseFloat(getComputedStyle(n).fontSize) >= 14),
    );
    await sender.locator('.reaction-choice:first-child').focus();
    await sender.screenshot({
      path: `${output}/${viewport.width}x${viewport.height}.png`,
      animations: 'disabled',
    });
    layouts.push({ viewport, ...metrics });
    await sender.keyboard.press('Escape');
  }
  checks.push(
    'вложенный скролл, все категории, подписи ≥14px и последняя карточка доступны на пяти размерах, включая 320px и короткое окно',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/checks.json`,
    JSON.stringify(
      { revision: 'working-tree', quality, browser: browser.version(), checks, layouts, errors },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, layouts, errors }, null, 2));
} finally {
  await browser.close();
  await app.close();
}
