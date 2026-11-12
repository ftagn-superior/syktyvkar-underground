import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';

if (!process.env.SU_TEST_DATABASE_URL) throw new Error('Use pnpm test:accounts:browser.');
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
try {
  app = await createGameServer({ port: 0, accounts: fixture });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser();
  const errors: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url + '/?diagnostics=1');
  await page.locator('#telegram-login').waitFor({ state: 'visible' });
  await page.locator('#telegram-login').click();
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  await page.locator('#profile-name').fill('Игрок из Сыктывкара');
  await page.locator('input[name="profile-color"][value="indigo"]').check();
  await page.locator('input[name="avatar-skin"][value="standard"]').check();
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/accounts-profile.png' });
  // There is no separate save button: entering the world saves the profile.
  await page.locator('#join:not([disabled])').click();
  await page.waitForFunction(
    () => document.querySelector('#connection-status')?.textContent === 'В сети',
  );
  const first = await page.evaluate(async () => (await fetch('/api/me')).json());
  assert.equal(first.account.profile.displayName, 'Игрок из Сыктывкара');
  assert.equal(first.account.profile.skinId, 'standard');
  assert.equal(first.account.profile.colorId, 'indigo');
  await page.waitForFunction(
    () => document.querySelector('#connection-status')?.textContent === 'В сети',
  );
  await page.waitForFunction(() =>
    document.querySelector('.player-label')?.textContent?.includes('Игрок из Сыктывкара'),
  );
  assert.equal([...app.room.state.players.values()][0].color, '#7D86F0');
  assert.equal([...app.room.state.players.values()][0].skinId, 'standard');
  await page.locator('#leave').click();
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  // Entering saves a changed selection before the server reads the account profile.
  await page.locator('input[name="avatar-skin"][value="minifigure"]').check();
  await page.locator('#join:not([disabled])').click();
  await page.waitForFunction(
    () => document.querySelector('#connection-status')?.textContent === 'В сети',
  );
  assert.equal([...app.room.state.players.values()][0].skinId, 'minifigure');
  assert.equal(
    (await page.evaluate(async () => (await fetch('/api/me')).json())).account.profile.skinId,
    'minifigure',
  );
  await page.locator('#leave').click();
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  await app.close();
  app = await createGameServer({ port: 0, accounts: fixture });
  fixture.config.publicOrigin = app.url;
  await page.goto(app.url);
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#profile-name').inputValue(), 'Игрок из Сыктывкара');
  assert.equal(await page.locator('input[name="profile-color"]:checked').inputValue(), 'indigo');
  assert.equal(await page.locator('input[name="avatar-skin"]:checked').inputValue(), 'minifigure');
  const other = await browser.newContext({ viewport: { width: 960, height: 720 } });
  const second = await other.newPage();
  second.on('pageerror', (error) => errors.push(error.message));
  await second.goto(app.url);
  await second.locator('#telegram-login').click();
  await second.locator('#profile-form').waitFor({ state: 'visible' });
  const same = await second.evaluate(async () => (await fetch('/api/me')).json());
  assert.equal(same.account.accountId, first.account.accountId);
  await page.locator('#join:not([disabled])').click();
  await page.waitForFunction(
    () => document.querySelector('#leave')?.hasAttribute('hidden') === false,
  );
  await second.locator('#join:not([disabled])').click();
  await second.waitForFunction(() =>
    document.querySelector('#notice')?.textContent?.includes('уже находится в игре'),
  );
  await page.locator('#leave').click();
  await page.locator('#account-logout').click();
  await page.locator('#telegram-login').waitFor({ state: 'visible' });
  assert.equal((await page.evaluate(async () => (await fetch('/api/me')).json())).account, null);
  // The second browser has its own session and remains signed in.
  assert.equal(
    (await second.evaluate(async () => (await fetch('/api/me')).json())).account.accountId,
    first.account.accountId,
  );
  await second.locator('#account-logout').click();
  await second.locator('#telegram-login').waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/accounts-guest-small.png' });
  assert.deepEqual(errors, []);
  await writeFile(
    'output/playwright/accounts.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        result: 'passed',
        browser: browser.version(),
        provider: 'local OIDC fixture with real RS256 validation',
        database: 'isolated PostgreSQL schema',
        checks: [
          'login',
          'save profile',
          'save skin before entry and restore it after restart',
          'appearance in game',
          'restart',
          'second browser',
          'duplicate account',
          'logout',
        ],
        browserErrors: errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Account browser flow passed: login, profile, game, restart, second browser and logout.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
}
