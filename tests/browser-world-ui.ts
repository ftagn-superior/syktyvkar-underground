import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createAccountFixture } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';
import { createGameServer } from './helpers/game-server.js';
import { hudClick, openChat } from './helpers/hud.js';

// Run after build with a disposable PostgreSQL database. The fixture owns its private schema.
if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('Set SU_TEST_DATABASE_URL to a test PostgreSQL database.');
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const output = 'output/playwright/world-ui';
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
const errors: string[] = [];
const checks: string[] = [];
let nextTimeChangeAt = 0;

async function playing(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
  );
}
async function timeCommand(page: Page, argument: string): Promise<void> {
  // The room allows at most one clock mutation per second, across all players.
  const remaining = nextTimeChangeAt - Date.now();
  if (remaining > 0) await page.waitForTimeout(remaining);
  await openChat(page);
  await page.locator('#chat-input').fill(`/time ${argument}`);
  await page.locator('#chat-send:not([disabled])').click();
  await page.waitForFunction(
    () => (document.querySelector('#chat-input') as HTMLInputElement).value === '',
  );
  nextTimeChangeAt = Date.now() + 1050;
  assert.equal(await page.locator('#chat-console').isVisible(), true);
  await page.keyboard.press('Escape');
}
async function theme(page: Page, expected: 'day' | 'night'): Promise<void> {
  await page.waitForFunction(
    (value) => document.documentElement.dataset.uiTheme === value,
    expected,
  );
}
async function chooseTheme(page: Page, mode: 'auto' | 'day' | 'night'): Promise<void> {
  if (!(await page.locator('#help-panel').isVisible())) await page.locator('#help-toggle').click();
  await page.locator(`[data-theme-mode="${mode}"]`).click();
  assert.equal(
    await page.locator(`[data-theme-mode="${mode}"]`).getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(await page.locator('[data-theme-mode][aria-pressed="true"]').count(), 1);
  await page.locator('#help-close').click();
}
async function clock(page: Page, time: string, daylight: boolean): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelector('#clock-text')?.textContent === expected,
    time,
  );
  assert.equal(
    await page.locator('#clock-chip').getAttribute('aria-label'),
    daylight ? 'Время в мире, день' : 'Время в мире, ночь',
  );
}
async function fitsViewport(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  const size = page.viewportSize()!;
  assert.ok(
    box &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= size.width + 1 &&
      box.y + box.height <= size.height + 1,
    `${selector} fits ${size.width}×${size.height}`,
  );
}

try {
  await mkdir(output, { recursive: true });
  app = await createGameServer({ port: 0, accounts: fixture });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser();
  const contexts = await Promise.all(
    [0, 1].map(() => browser!.newContext({ viewport: { width: 1280, height: 720 } })),
  );
  for (const context of contexts)
    await context.addInitScript(() => {
      localStorage.setItem('su:render-quality:v1', 'economy');
      localStorage.setItem('su:help-tip:v1', '1');
    });
  const [owner, observer] = await Promise.all(contexts.map((context) => context.newPage()));
  const pages = [owner, observer];
  for (const page of pages) {
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (error) => errors.push(error.message));
  }
  await owner.goto(app.url);
  await owner.locator('#telegram-login').click();
  await owner.locator('#profile-form').waitFor({ state: 'visible' });
  for (const page of pages) {
    await page.goto(`${app.url}/?diagnostics=1`);
    await page.locator('#join:not([disabled])').click();
    await playing(page);
  }
  for (const page of pages) {
    await page.waitForFunction(() => document.querySelector('#players-count')?.textContent === '2');
    await page.locator('#players-toggle').click();
    await page.waitForFunction(() => document.querySelectorAll('#players-list li').length === 2);
    assert.equal(await page.locator('#players-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(
      await page.locator('#players-toggle').getAttribute('aria-label'),
      'Игроки в сети: 2',
    );
    assert.equal(await page.locator('#players-total').textContent(), '2 из 8');
    assert.equal(await page.locator('#players-list li:first-child small').textContent(), 'вы');
    assert.equal(await page.locator('#players-note').isHidden(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#players-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#players-toggle:focus').count(), 1);
  }
  checks.push(
    'world chips count both players and list the local player first; Escape restores toggle focus',
  );

  await timeCommand(owner, 'stop');
  assert.ok(app.room.state.dayFrozenHour >= 0);
  await timeCommand(owner, '13:15');
  for (const page of pages) {
    await clock(page, '13:15', true);
    await theme(page, 'day');
  }
  const dayBackground = await owner
    .locator('#clock-chip')
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  await chooseTheme(owner, 'night');
  await theme(owner, 'night');
  await theme(observer, 'day');
  await clock(owner, '13:15', true);
  const nightBackground = await owner
    .locator('#clock-chip')
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  assert.notEqual(dayBackground, nightBackground, 'theme selection changes rendered panel colors');
  await chooseTheme(owner, 'auto');
  await theme(owner, 'day');
  await owner.screenshot({ path: `${output}/day.png` });
  await timeCommand(owner, '01:30');
  for (const page of pages) {
    await clock(page, '01:30', false);
    await theme(page, 'night');
  }
  await owner.screenshot({ path: `${output}/night.png` });
  checks.push(
    '/time stop/set synchronizes the clock and automatic day/night theme; manual theme changes only the local interface',
  );

  await chooseTheme(owner, 'day');
  await owner.reload();
  await playing(owner);
  await theme(owner, 'day');
  await clock(owner, '01:30', false);
  await owner.locator('#help-toggle').click();
  assert.equal(await owner.locator('[data-theme-mode="day"]').getAttribute('aria-pressed'), 'true');
  await owner.locator('#help-close').click();
  await chooseTheme(owner, 'auto');
  await theme(owner, 'night');
  await observer.reload();
  await playing(observer);
  await clock(observer, '01:30', false);
  await theme(observer, 'night');
  checks.push('manual theme survives reload; reconnected clients receive the frozen room clock');

  await openChat(owner);
  const draft = 'Черновик: wasd qer';
  await owner.locator('#chat-input').fill(draft);
  const overlays = [
    ['#help-toggle', '#help-panel'],
    ['#players-toggle', '#players-panel'],
    ['#inventory-toggle', '#inventory-panel'],
    ['#reactions-toggle', '#reactions-panel'],
    ['#animations-toggle', '#animations-panel'],
  ] as const;
  for (const [toggle, panel] of overlays) {
    await owner.locator(toggle).click();
    await owner.locator(panel).waitFor({ state: 'visible' });
    assert.equal(await owner.locator(toggle).getAttribute('aria-expanded'), 'true');
    for (const [, other] of overlays)
      if (other !== panel) assert.equal(await owner.locator(other).isHidden(), true);
    assert.equal(await owner.locator('#chat-console').isVisible(), true);
    assert.equal(await owner.locator('#chat-input').inputValue(), draft);
  }
  await owner.keyboard.press('Escape');
  assert.equal(await owner.locator('#animations-panel').isHidden(), true);
  assert.equal(await owner.locator('#chat-console').isHidden(), true);
  await openChat(owner);
  assert.equal(await owner.locator('#chat-input').inputValue(), draft);
  await owner.locator('#world').click({ position: { x: 600, y: 300 } });
  assert.equal(await owner.locator('#chat-console').isHidden(), true);
  checks.push(
    'help, players, backpack and catalogs exclude each other while preserving the chat draft; Escape and world clicks collapse chat',
  );

  for (const size of [
    { width: 390, height: 844 },
    { width: 640, height: 360 },
  ]) {
    await owner.setViewportSize(size);
    await owner.locator('#players-toggle').click();
    await fitsViewport(owner, '#players-panel');
    await owner.locator('#help-toggle').click();
    assert.equal(await owner.locator('#players-panel').isHidden(), true);
    await fitsViewport(owner, '#help-panel');
    for (const selector of ['[data-theme-mode="auto"]', '#respawn', '#leave']) {
      await owner.locator(selector).scrollIntoViewIfNeeded();
      await owner.locator(selector).click({ trial: true });
    }
    await owner.screenshot({ path: `${output}/help-${size.width}.png` });
    await owner.locator('#help-close').click();
  }
  checks.push(
    'player list and scrollable settings fit portrait and short viewports with reachable controls',
  );

  await owner.setViewportSize({ width: 1280, height: 720 });
  await timeCommand(owner, 'start');
  assert.equal(app.room.state.dayFrozenHour, -1);
  for (const page of pages)
    await page.waitForFunction(
      () => document.querySelector('#clock-text')?.textContent !== '01:30',
    );
  await timeCommand(owner, 'reset');
  assert.equal(app.room.state.dayOffsetMs, 0);
  assert.equal(app.room.state.dayFrozenHour, -1);
  for (const page of pages)
    assert.equal(await page.locator('#chat-log .chat-line:not(.sys)').count(), 0);
  await hudClick(observer, '#leave');
  await owner.waitForFunction(() => document.querySelector('#players-count')?.textContent === '1');
  checks.push(
    '/time start/reset resumes the shared clock; commands stay out of public chat and the player count updates on leave',
  );

  assert.deepEqual(errors, [], 'no uncaught browser errors');
  const report = { result: 'passed', browser: browser.version(), checks, errors };
  await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
}
