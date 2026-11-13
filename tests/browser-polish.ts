import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { hudClick } from './helpers/hud.js';

const url = process.env.SU_TEST_URL ?? 'http://127.0.0.1:2567';
// Headless shell treats every tab as focused; full Chromium provides native tab activation.
const browser = await launchTestBrowser({ channel: 'chromium' });
type Position = { x: number; z: number };
const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.z - b.z);
const errors: string[] = [];
const checks: string[] = [];
async function snapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
}
async function report(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__SU_DEBUG__.report());
}
async function playing(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 20_000 },
  );
}
async function move(page: Page, key: string, minimum = 0.35): Promise<void> {
  const origin = (await snapshot(page)).authoritative.position;
  await page.keyboard.down(key);
  await page.waitForFunction(
    ({ origin, minimum }) => {
      const position = (window as any).__SU_DEBUG__.snapshot().authoritative.position;
      return Math.hypot(position.x - origin.x, position.z - origin.z) > minimum;
    },
    { origin, minimum },
    { timeout: 10_000 },
  );
}
async function assertStationary(page: Page, milliseconds = 550): Promise<void> {
  const before = (await snapshot(page)).authoritative.position;
  await page.waitForTimeout(milliseconds);
  const after = (await snapshot(page)).authoritative.position;
  assert.ok(
    distance(before, after) < 0.06,
    `expected stopped character, moved ${distance(before, after)} m`,
  );
}
async function reachable(page: Page, selectors: string[]): Promise<void> {
  for (const selector of selectors) {
    const target = page.locator(selector);
    await target.scrollIntoViewIfNeeded();
    const result = await target.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        inside:
          rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        unobstructed: hit !== null && (hit === node || node.contains(hit)),
        size: { width: rect.width, height: rect.height },
      };
    });
    assert.ok(result.inside, `${selector} fits the viewport`);
    assert.ok(result.unobstructed, `${selector} is not covered by another panel`);
    assert.ok(result.size.width > 0 && result.size.height > 0, `${selector} is visible`);
  }
}
function inspectExport(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const forbidden =
    /^(token|reconnectionToken|sessionId|entityId|playerName|guestName|entities|authoritative|predicted)$/i;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(forbidden.test(key), false, `diagnostic export must not contain ${key}`);
    inspectExport(nested);
  }
}

try {
  await mkdir('output/playwright/polish', { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 600 } });
  const page = await context.newPage();
  // Playwright otherwise forces every tab to appear focused. Disable that
  // override so bringToFront produces the browser's own blur/focus events.
  const focusSession = await context.newCDPSession(page);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/?diagnostics=1`);
  await page.locator('#join:not([disabled])').waitFor();
  await reachable(page, ['#join']);
  await page.screenshot({ path: 'output/playwright/polish/welcome-1280x600.png' });
  await page.locator('#join').click();
  await playing(page);
  await page.waitForFunction(
    () => document.querySelector('#player-count')?.textContent === '1 из 8',
  );
  assert.equal(await page.locator('#diagnostics').isHidden(), true);
  checks.push('player count updates while the diagnostics panel is closed');
  const identity = (await snapshot(page)).authoritative.entityId;

  // Leave a movement key held while the browser actually focuses another tab.
  await page.locator('#world').focus();
  await move(page, 'w');
  // Navigation/activation can reapply Playwright's override; disable it on the
  // loaded game immediately before the tab-switch experiment.
  await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const other = await context.newPage();
  const otherFocusSession = await context.newCDPSession(other);
  await other.goto('about:blank');
  await otherFocusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await other.bringToFront();
  await page.waitForFunction(() => !document.hasFocus(), undefined, {
    polling: 100,
    timeout: 5000,
  });
  await page.waitForTimeout(600);
  await assertStationary(page);
  await page.bringToFront();
  await page.locator('#world').focus();
  await assertStationary(page);
  await page.keyboard.up('w');
  await move(page, 's');
  await page.keyboard.up('s');
  await other.close();
  await page.waitForTimeout(400);
  checks.push('held movement stops on real focus loss and requires a fresh press');

  const revision = (await snapshot(page)).authoritative.revision;
  const respawnAt = Date.now();
  await hudClick(page, '#respawn');
  await page.waitForFunction(
    () => (document.querySelector('#respawn') as HTMLButtonElement).disabled,
  );
  await page.waitForFunction(
    (previous) => (window as any).__SU_DEBUG__.snapshot().authoritative.revision === previous + 1,
    revision,
  );
  // The authoritative revision and the action acknowledgement arrive separately.
  await page.waitForFunction(
    () => /[123]/.test(document.querySelector('#respawn')!.textContent!),
    undefined,
    { timeout: 2500 },
  );
  // A second physical click must be ignored by the disabled control.
  const button = (await page.locator('#respawn').boundingBox())!;
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  await page.waitForTimeout(700);
  assert.equal((await snapshot(page)).authoritative.revision, revision + 1);
  assert.equal(await page.locator('#respawn').isDisabled(), true);
  await page.locator('#respawn:not([disabled])').waitFor({ timeout: 6000 });
  assert.ok(Date.now() - respawnAt >= 2800, 'cooldown covers the server interval');
  checks.push('respawn confirms once, displays cooldown, and becomes available again');

  await hudClick(page, '#diagnostics-toggle');
  const standard = await report(page);
  await page.locator('#quality').selectOption('economy');
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.report().rendering.quality === 'economy',
  );
  const economy = await report(page);
  assert.equal(economy.rendering.shadows, false);
  assert.ok(economy.rendering.renderSize.width < standard.rendering.renderSize.width);
  assert.ok(economy.rendering.renderSize.height < standard.rendering.renderSize.height);
  await page.reload();
  await playing(page);
  assert.equal((await snapshot(page)).authoritative.entityId, identity);
  assert.equal((await report(page)).rendering.quality, 'economy');
  await hudClick(page, '#diagnostics-toggle');
  assert.equal(await page.locator('#quality').inputValue(), 'economy');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#download-report').click(),
  ]);
  const downloadPath = 'output/playwright/polish/downloaded-diagnostics.json';
  await download.saveAs(downloadPath);
  const jsonText = await readFile(downloadPath, 'utf8');
  const exported = JSON.parse(jsonText);
  for (const key of [
    'build',
    'environment',
    'rendering',
    'metrics',
    'versions',
    'streaming',
    'physics',
    'prediction',
    'preparations',
  ])
    assert.ok(exported[key], `export includes ${key}`);
  assert.equal(exported.formatVersion, 2);
  assert.equal(exported.rendering.quality, 'economy');
  inspectExport(exported);
  const sensitiveValues = await page.evaluate(() => {
    const debug = (window as any).__SU_DEBUG__.snapshot();
    const saved = JSON.parse(sessionStorage.getItem('su:session:v1') ?? 'null');
    return [debug.sessionId, debug.authoritative?.entityId, saved?.token].filter(Boolean);
  });
  for (const secret of sensitiveValues)
    assert.equal(jsonText.includes(secret), false, 'export excludes live session identifiers');
  checks.push(
    'economy changes render settings, survives reload, and exports a bounded diagnostic report',
  );
  await hudClick(page, '#diagnostics-toggle');

  await reachable(page, ['#respawn', '#leave', '#diagnostics-toggle']);
  await page.screenshot({ path: 'output/playwright/polish/playing-1280x600.png' });
  await page.setViewportSize({ width: 640, height: 300 });
  await reachable(page, ['#respawn', '#leave', '#diagnostics-toggle']);
  await hudClick(page, '#diagnostics-toggle');
  await reachable(page, ['#quality', '#download-report']);
  await page.screenshot({ path: 'output/playwright/polish/diagnostics-640x300.png' });
  await hudClick(page, '#diagnostics-toggle');
  await page.setViewportSize({ width: 1280, height: 600 });
  checks.push(
    'playing controls and diagnostics remain reachable in 1280×600 and 640×300 viewports',
  );

  await page.locator('#world').focus();
  await move(page, 's');
  const supported = await page.evaluate(() => {
    const canvas = document.querySelector('#world') as HTMLCanvasElement;
    const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    // Keep the browser extension handle, never mutate the application or simulation.
    (window as any).__SU_TEST_CONTEXT_EXTENSION__ = extension;
    extension.loseContext();
    return true;
  });
  assert.equal(supported, true, 'test browser supports controlled WebGL context loss');
  await page.locator('#graphics-recovery').waitFor({ state: 'visible' });
  await page.waitForTimeout(600);
  await assertStationary(page, 7600);
  assert.equal(await page.locator('#graphics-recovery').isVisible(), true);
  await reachable(page, ['#graphics-reload']);
  await page.screenshot({ path: 'output/playwright/polish/graphics-recovery.png' });
  await page.evaluate(() => (window as any).__SU_TEST_CONTEXT_EXTENSION__.restoreContext());
  await page.locator('#graphics-recovery').waitFor({ state: 'hidden', timeout: 15_000 });
  await playing(page);
  assert.equal((await snapshot(page)).authoritative.entityId, identity);
  await assertStationary(page);
  await page.keyboard.up('s');
  await page.locator('#world').focus();
  await move(page, 'w');
  await page.keyboard.up('w');
  checks.push(
    'graphics recovery persists beyond seven seconds, blocks held input, and restores the same character',
  );

  await hudClick(page, '#leave');
  await page.setViewportSize({ width: 640, height: 300 });
  await reachable(page, ['#join']);
  await page.screenshot({ path: 'output/playwright/polish/welcome-640x300.png' });
  checks.push(
    'entry remains reachable in a reduced CSS viewport equivalent to a zoomed desktop window',
  );
  // Exercise the unsupported-graphics path before any scene exists.
  const unsupported = await launchTestBrowser({ renderer: 'default', args: ['--disable-webgl'] });
  try {
    const unsupportedPage = await unsupported.newPage();
    unsupportedPage.on('pageerror', (error) => errors.push(error.message));
    await unsupportedPage.goto(`${url}/?diagnostics=1`);
    await unsupportedPage.waitForFunction(
      () => (window as any).__SU_DEBUG__?.snapshot().connection === 'error',
    );
    assert.match(await unsupportedPage.locator('#notice').innerText(), /WebGL2/);
    assert.equal((await snapshot(unsupportedPage)).playerCount, 0);
    checks.push('unsupported WebGL reports error in both the interface and diagnostic state');
  } finally {
    await unsupported.close();
  }
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  const result = {
    date: new Date().toISOString(),
    browser: browser.version(),
    result: 'passed',
    checks,
    browserErrors: errors,
    screenshots: 'output/playwright/polish/',
  };
  await writeFile('output/playwright/polish/result.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const context of browser.contexts())
    for (const page of context.pages())
      if (
        await page
          .locator('#leave')
          .isVisible()
          .catch(() => false)
      )
        await page
          .locator('#leave')
          .click({ timeout: 1000 })
          .catch(() => {});
  await browser.close();
}
