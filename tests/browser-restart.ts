import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createGameServer } from './helpers/game-server.js';
import { createDatabaseFixture } from './helpers/database-fixture.js';
import { hudClick } from './helpers/hud.js';

const database = await createDatabaseFixture();
let app = await createGameServer({ port: 0, pool: database.pool });
const address = new URL(app.url);
const port = Number(address.port);
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${app.url}/?diagnostics=1`);
  await page.locator('#join:not([disabled])').waitFor();
  await page.locator('#join').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  const old = await page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
  await app.close();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  app = await createGameServer({ port, pool: database.pool });
  await page.waitForFunction(
    () => document.querySelector('#notice')?.textContent?.includes('перезапущен'),
    undefined,
    { timeout: 15_000 },
  );
  await page.locator('#join:not([disabled])').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  const fresh = await page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
  assert.notEqual(old.worldEpoch, fresh.worldEpoch);
  assert.notEqual(old.authoritative.entityId, fresh.authoritative.entityId);
  assert.equal(fresh.playerCount, 1);
  assert.deepEqual(
    fresh.items.map((item: any) => item.entityId).sort(),
    old.items.map((item: any) => item.entityId).sort(),
    'restart preserves item identities without repeating seeds',
  );
  assert.deepEqual(errors, []);
  await hudClick(page, '#leave');
  const result = {
    date: new Date().toISOString(),
    browser: browser.version(),
    result: 'passed',
    oldEpoch: old.worldEpoch,
    newEpoch: fresh.worldEpoch,
    persistentItemIdentitiesPreserved: true,
    browserErrors: errors,
  };
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/restart.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await app.close();
  await database.close();
}
