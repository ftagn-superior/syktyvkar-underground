import { mkdir } from 'node:fs/promises';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';

const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL!);
const app = await createGameServer({ port: 0, accounts: fixture });
fixture.config.publicOrigin = app.url;
const browser = await launchTestBrowser();
const out = process.env.SHOT_DIR ?? 'output/shots';
await mkdir(out, { recursive: true });
try {
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on(
    'console',
    (m) => ['error', 'warning'].includes(m.type()) && console.log('CONSOLE', m.text()),
  );
  await page.goto(app.url + '/?diagnostics=1');
  await page.locator('#telegram-login').waitFor({ state: 'visible' });
  await page.screenshot({ path: `${out}/lobby-guest.png` });
  await page.locator('#telegram-login').click();
  await page.locator('#profile-form').waitFor({ state: 'visible' });
  await page.locator('#profile-name').fill('Игрок Сыктывкара');
  await page.locator('input[name="profile-color"][value="rose"]').check();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/lobby-rose.png` });
  await page.locator('input[name="profile-color"][value="custom"]').check();
  await page.locator('#profile-hue').evaluate((el: HTMLInputElement) => {
    el.value = '230';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/lobby-dark.png` });
  await page.locator('#join:not([disabled])').click();
  await page.waitForFunction(
    () => document.querySelector('#connection-status')?.textContent === 'В сети',
  );
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/world-tip.png` });
  await page.keyboard.press('KeyH');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/world-help.png` });
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyT');
  await page.keyboard.type('Велком ту Сыктывкар');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/world-chat.png` });
} finally {
  await browser.close();
  await app.close();
}
