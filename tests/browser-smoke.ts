import { prepareSdk } from './helpers/prepare.js';
import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { Client } from '@colyseus/sdk';
import { hudClick } from './helpers/hud.js';

const url = process.env.SU_TEST_URL ?? 'http://127.0.0.1:2567';
const browser = await launchTestBrowser();
const errors: string[] = [];
const consoleMessages: { page: number; type: string; text: string }[] = [];
let pages: Page[] = [];
async function snapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
}
async function playing(page: Page, timeout = 20_000) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout },
  );
}
try {
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1440, height: 900 } })),
  );
  pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      consoleMessages.push({ page: index, type: message.type(), text: message.text() });
      if (consoleMessages.length > 80) consoleMessages.shift();
    });
    await page.bringToFront();
    await page.goto(`${url}/?diagnostics=1`);
    await page.bringToFront();
    await page.locator('#join:not([disabled])').waitFor();
  }
  await mkdir('output/playwright', { recursive: true });
  await pages[0].screenshot({ path: 'output/playwright/welcome.png' });
  for (const page of pages) {
    await page.bringToFront();
    await page.locator('#join').click();
    await playing(page);
  }
  await pages[0].waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().playerCount === 2);
  const info = await fetch(`${url}/api/world`).then((response) => response.json());
  const fillers = [];
  const fullBrowser = await launchTestBrowser();
  try {
    // Isolate the rejected entrant's WebGL startup from the two active SwiftShader scenes.
    // Admission is still checked by the real client after all eight seats are occupied.
    const fullContext = await fullBrowser.newContext();
    const fullPage = await fullContext.newPage();
    fullPage.on('pageerror', (error) => errors.push(error.message));
    await fullPage.bringToFront();
    await fullPage.goto(`${url}/?diagnostics=1`);
    await fullPage.locator('#join:not([disabled])').waitFor();
    for (let index = 0; index < 6; index++) {
      const room = await new Client(url).joinById(info.roomId, info);
      prepareSdk(room);
      fillers.push(room);
    }
    await fullPage.bringToFront();
    await fullPage.locator('#join').click();
    await fullPage.waitForFunction(() =>
      document.querySelector('#notice')?.textContent?.includes('8 игроков'),
    );
    assert.equal((await snapshot(fullPage)).connection, 'ready');
  } finally {
    await fullBrowser.close();
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
  await hudClick(pages[0], '#respawn');
  await pages[0].waitForFunction(
    (revision) => (window as any).__SU_DEBUG__.snapshot().authoritative.revision > revision,
    moved.authoritative.revision,
  );
  const identity = (await snapshot(pages[0])).authoritative.entityId;
  const reloadStartedAt = performance.now();
  await pages[0].bringToFront();
  await pages[0].reload();
  // Recreating a standard-quality SwiftShader scene includes cold shader compilation.
  // Server reconnect and area-preparation deadlines still bound actual recovery.
  await playing(pages[0], 45_000);
  const reloadMs = performance.now() - reloadStartedAt;
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
  await hudClick(pages[0], '#diagnostics-toggle');
  await pages[0].screenshot({ path: 'output/playwright/two-players.png' });
  const final = await snapshot(pages[0]);
  await hudClick(pages[0], '#leave');
  await pages[1].bringToFront();
  await pages[1].waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().playerCount === 1);
  await hudClick(pages[1], '#leave');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    result: 'passed',
    displacement,
    reloadMs,
    final,
    browserErrors: errors,
  };
  await writeFile('output/playwright/smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        displacement,
        reloadMs,
        browser: browser.version(),
        correctionP95: final.correctionP95,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const clients = await Promise.allSettled(
    pages.map((page) =>
      page.evaluate(() => {
        const debug = (window as any).__SU_DEBUG__;
        return {
          snapshot: debug?.snapshot(),
          report: debug?.report(),
          notice: document.querySelector('#notice')?.textContent,
          joinLabel: document.querySelector('#join-label')?.textContent,
          visibility: document.visibilityState,
          focused: document.hasFocus(),
        };
      }),
    ),
  );
  await mkdir('output/playwright', { recursive: true });
  await writeFile(
    'output/playwright/smoke-failure.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        url,
        browser: browser.version(),
        error: error instanceof Error ? error.stack : String(error),
        browserErrors: errors,
        consoleMessages,
        clients,
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  await browser.close();
}
