import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { Client } from '@colyseus/sdk';

const url = process.env.SU_TEST_URL ?? 'http://127.0.0.1:2567';
const browser = await launchTestBrowser();
const errors: string[] = [];
async function snapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
}
async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 20_000 },
  );
}
try {
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1440, height: 900 } })),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of pages) {
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${url}/?diagnostics=1`);
    await page.locator('#join:not([disabled])').waitFor();
  }
  await mkdir('output/playwright', { recursive: true });
  await pages[0].screenshot({ path: 'output/playwright/welcome.png' });
  for (const page of pages) {
    await page.locator('#join').click();
    await playing(page);
  }
  await pages[0].waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().playerCount === 2);
  const info = await fetch(`${url}/api/world`).then((response) => response.json());
  const fillers = [];
  try {
    for (let index = 0; index < 6; index++) {
      const room = await new Client(url).joinById(info.roomId, info);
      room.send('clientReady');
      fillers.push(room);
    }
    const fullContext = await browser.newContext();
    const fullPage = await fullContext.newPage();
    await fullPage.goto(`${url}/?diagnostics=1`);
    await fullPage.locator('#join:not([disabled])').waitFor();
    await fullPage.locator('#join').click();
    await fullPage.waitForFunction(() =>
      document.querySelector('#notice')?.textContent?.includes('8 игроков'),
    );
    assert.equal((await snapshot(fullPage)).connection, 'ready');
    await fullContext.close();
  } finally {
    await Promise.all(fillers.map((room) => room.leave()));
  }
  await pages[0].waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().playerCount === 2);
  const before = await snapshot(pages[0]);
  assert.equal(before.worldEpoch, (await snapshot(pages[1])).worldEpoch);
  assert.notEqual(before.authoritative.entityId, (await snapshot(pages[1])).authoritative.entityId);
  await pages[0].bringToFront();
  await pages[0].locator('#world').focus();
  await pages[0].keyboard.down('w');
  await pages[0].waitForFunction(
    (origin) => {
      const current = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
      return Math.hypot(current.x - origin.x, current.z - origin.z) > 2;
    },
    before.authoritative.position,
    { timeout: 15_000 },
  );
  await pages[0].keyboard.up('w');
  await pages[0].waitForTimeout(400);
  const moved = await snapshot(pages[0]);
  const displacement = Math.hypot(
    moved.authoritative.position.x - before.authoritative.position.x,
    moved.authoritative.position.z - before.authoritative.position.z,
  );
  assert.ok(displacement > 2, `movement displacement ${displacement}`);
  const remote = (await snapshot(pages[1])).entities.find(
    (p: any) => p.entityId === moved.authoritative.entityId,
  );
  assert.ok(
    Math.hypot(
      remote.position.x - moved.authoritative.position.x,
      remote.position.z - moved.authoritative.position.z,
    ) < 0.3,
    'remote state converges',
  );
  await pages[0].locator('#respawn').click();
  await pages[0].waitForFunction(
    (revision) => (window as any).__SU_DEBUG__.snapshot().authoritative.revision > revision,
    moved.authoritative.revision,
  );
  const identity = (await snapshot(pages[0])).authoritative.entityId;
  await pages[0].reload();
  await playing(pages[0]);
  assert.equal(
    (await snapshot(pages[0])).authoritative.entityId,
    identity,
    'reload restores entity',
  );
  await contexts[0].setOffline(true);
  await pages[0].waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
    undefined,
    { timeout: 10_000 },
  );
  await pages[0].waitForTimeout(1000);
  await contexts[0].setOffline(false);
  await playing(pages[0]);
  assert.equal(
    (await snapshot(pages[0])).authoritative.entityId,
    identity,
    'short interruption preserves identity',
  );
  await pages[0].locator('#diagnostics-toggle').click();
  await pages[0].screenshot({ path: 'output/playwright/two-players.png' });
  const final = await snapshot(pages[0]);
  await pages[0].locator('#leave').click();
  await pages[1].waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().playerCount === 1);
  await pages[1].locator('#leave').click();
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    result: 'passed',
    displacement,
    final,
    browserErrors: errors,
  };
  await writeFile('output/playwright/smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        displacement,
        browser: browser.version(),
        correctionP95: final.correctionP95,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
