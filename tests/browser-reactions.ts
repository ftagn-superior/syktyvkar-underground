import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { REACTIONS } from '../packages/contracts/src/index.js';
import { launchTestBrowser } from './helpers/browser.js';

// Run after build: the two real browsers share an isolated, freshly created world.
const app = await createGameServer({
  port: 0,
  worldDirectory: process.env.SU_TEST_WORLD_DIRECTORY,
});
const browser = await launchTestBrowser();
const errors: string[] = [];
const checks: string[] = [];
const output = 'output/playwright/reactions';
async function playing(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 20_000 },
  );
}
async function snapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
}
try {
  await mkdir(output, { recursive: true });
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })),
  );
  const [sender, observer] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of [sender, observer]) {
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (error) => {
      errors.push(error.message);
      console.error('Browser error:', error.message);
    });
    await page.goto(`${app.url}/?diagnostics=1`);
    await page.locator('#join:not([disabled])').waitFor({ timeout: 45_000 });
    await page.locator('#join').click();
    await playing(page);
  }
  await sender.bringToFront();
  await sender.locator('#world').focus();
  await sender.keyboard.press('r');
  await sender.locator('#reactions-panel').waitFor();
  assert.equal(await sender.locator('.reaction-choice').count(), REACTIONS.length);
  assert.equal(await sender.locator('.reaction-choice:focus').count(), 1);
  assert.equal(
    await sender
      .locator('.reaction-choice img')
      .evaluateAll((images) =>
        images.every(
          (image) =>
            (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
        ),
      ),
    true,
  );
  await sender.screenshot({ path: `${output}/menu.png` });
  const origin = (await snapshot(sender)).authoritative.position;
  await sender.keyboard.down('d');
  await sender.waitForFunction((origin) => {
    const position = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
    return Math.hypot(position.x - origin.x, position.z - origin.z) > 0.25;
  }, origin);
  await sender.keyboard.up('d');
  assert.equal(await sender.locator('#reactions-panel').isVisible(), true);
  await sender.keyboard.press('Escape');
  assert.equal(await sender.locator('#reactions-panel').isVisible(), false);
  assert.equal(await sender.locator('#world:focus').count(), 1);
  checks.push(
    'R opens the catalog, all local SVGs load, keyboard focus and movement remain usable, Escape closes',
  );
  console.log(checks.at(-1));

  const senderId = (await snapshot(sender)).authoritative.entityId;
  const sticker = `.player-reaction[data-entity-id="${senderId}"]`;
  for (const reaction of REACTIONS) {
    await sender.keyboard.press('r');
    const choice = sender.locator(
      `.reaction-choice[data-reaction-id="${reaction.id}"]:not([disabled])`,
    );
    await choice.waitFor({ timeout: 6000 });
    const started = Date.now();
    if (reaction.id === 'hello') await sender.keyboard.press('1');
    else await choice.click();
    await Promise.all([
      sender.locator(`${sticker}[data-reaction-id="${reaction.id}"]`).waitFor(),
      observer.locator(`${sticker}[data-reaction-id="${reaction.id}"]`).waitFor(),
    ]);
    await sender.locator('#reactions-panel').waitFor({ state: 'hidden' });
    assert.equal(await observer.locator(sticker).count(), 1);
    if (reaction.id === 'hello') {
      const before = await sender
        .locator(sticker)
        .evaluate((node) => (node as HTMLElement).style.transform);
      await sender.keyboard.down('d');
      await sender.waitForTimeout(300);
      await sender.keyboard.up('d');
      await sender.keyboard.press('q');
      await sender.waitForTimeout(200);
      assert.notEqual(
        await sender.locator(sticker).evaluate((node) => (node as HTMLElement).style.transform),
        before,
      );
      await sender.keyboard.press('r');
      assert.equal(await sender.locator('.reaction-choice:not([disabled])').count(), 0);
      await sender.keyboard.press('Escape');
      // A software-rendered screenshot may take longer than the sticker's lifetime.
      // Finish the live interaction assertions before capturing the visual artifact.
      await observer.screenshot({ path: `${output}/in-world.png`, animations: 'disabled' });
    }
    await Promise.all([
      sender.locator(sticker).waitFor({ state: 'detached', timeout: 4500 }),
      observer.locator(sticker).waitFor({ state: 'detached', timeout: 4500 }),
    ]);
    assert.ok(
      Date.now() - started >= 2500,
      'the reaction remains visible for approximately three seconds',
    );
  }
  checks.push(
    'all five reactions reach both browsers, follow the character and camera, expire, and block a second selection during the show',
  );
  console.log(checks.at(-1));

  await observer.reload();
  await playing(observer);
  assert.equal(await observer.locator('.player-reaction').count(), 0);
  checks.push('restoring a session does not replay an expired reaction');

  await sender.locator('#diagnostics-toggle').click();
  await sender.locator('#reactions-toggle').click();
  assert.equal(await sender.locator('#diagnostics').isVisible(), false);
  await sender.locator('#diagnostics-toggle').click();
  assert.equal(await sender.locator('#reactions-panel').isVisible(), false);
  await sender.locator('#diagnostics-toggle').click();
  checks.push('diagnostics and reactions do not cover each other');

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 800, height: 600 },
    { width: 390, height: 700 },
    { width: 640, height: 360 },
  ]) {
    await sender.setViewportSize(viewport);
    await sender.locator('#reactions-toggle').click();
    await sender.locator('#reactions-panel').waitFor();
    for (const selector of [
      '#reactions-panel',
      '.reaction-choice:last-child',
      '#reactions-toggle',
      '#respawn',
      '#leave',
    ]) {
      const fits = await sender.locator(selector).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return (
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.right <= innerWidth &&
          rect.bottom <= innerHeight &&
          hit !== null &&
          (hit === node || node.contains(hit))
        );
      });
      // The panel contains interactive children, so its center may hit one of them.
      assert.equal(
        fits,
        true,
        `${selector} remains reachable at ${viewport.width}x${viewport.height}`,
      );
    }
    if (viewport.width === 390) await sender.screenshot({ path: `${output}/narrow.png` });
    if (viewport.height === 360) await sender.screenshot({ path: `${output}/short.png` });
    await sender.keyboard.press('Escape');
  }
  checks.push('menu and gameplay controls fit desktop, tablet, narrow and short viewports');
  assert.deepEqual(errors, []);
  await writeFile(`${output}/checks.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
  await app.close();
}
