import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { buildStaticRemovalWorld, REMOVAL_SEED_OBJECTS } from './helpers/static-removal-world.js';
import { launchTestBrowser } from './helpers/browser.js';
import { openChat } from './helpers/hud.js';

if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('Set SU_TEST_DATABASE_URL to a test PostgreSQL database.');

const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const directory = await mkdtemp(join(tmpdir(), 'su-removal-browser-'));
const output = 'output/playwright/static-removal';
const errors: string[] = [],
  checks: string[] = [];
const metrics: unknown[] = [];
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;

async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 25000 },
  );
}
async function command(page: Page, text = '/vilievna') {
  await page.bringToFront();
  if (await page.evaluate(() => (window as any).__SU_DEBUG__.controls().view === 'first-person')) {
    await page.locator('#world').focus();
    await page.keyboard.press('t');
  }
  await openChat(page);
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send:not([disabled])').click();
}
async function pointAt(
  page: Page,
  entityId: string,
  position: { x: number; y: number; z: number },
) {
  for (const y of [position.y, position.y + 0.2, position.y - 0.2, position.y + 1]) {
    const point = await page.evaluate(
      (position) => {
        const point = (window as any).__SU_DEBUG__.project(position);
        const bounds = document.getElementById('world')!.getBoundingClientRect();
        return { x: point.x + bounds.left, y: point.y + bounds.top, visible: point.visible };
      },
      { ...position, y },
    );
    if (!point.visible) continue;
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(150);
    if (
      await page.evaluate((id) => (window as any).__SU_DEBUG__.removal().hovered === id, entityId)
    ) {
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(
        (id) => (window as any).__SU_DEBUG__.removal().selected === id,
        entityId,
      );
      return;
    }
  }
  throw new Error(
    `Could not point at ${entityId}: ${JSON.stringify(await page.evaluate(() => (window as any).__SU_DEBUG__.removal()))}`,
  );
}
async function rendered(page: Page, entityId: string, present: boolean) {
  await page.waitForFunction(
    ({ entityId, present }) =>
      (window as any).__SU_DEBUG__
        .buildings()
        .buildings.some((item: any) => item.entityId === entityId) === present,
    { entityId, present },
  );
}

try {
  const worldDirectory = await buildStaticRemovalWorld(directory);
  app = await createGameServer({ port: 0, accounts: fixture, worldDirectory });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser({ channel: 'chromium' });
  const ownerContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const observerContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const owner = await ownerContext.newPage(),
    observer = await observerContext.newPage();
  let navigations = 0;
  for (const page of [owner, observer]) {
    page.setDefaultTimeout(30000);
    await page.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
  }
  await owner.goto(app.url);
  await owner.locator('#telegram-login').click();
  await owner.locator('#profile-form').waitFor({ state: 'visible' });
  for (const page of [owner, observer]) {
    await page.bringToFront();
    await page.goto(app.url + '/?diagnostics=1');
    await page.locator('#join:not([disabled])').click();
    await playing(page);
    for (const object of Object.values(REMOVAL_SEED_OBJECTS))
      await rendered(page, object.entityId, true);
  }
  await mkdir(output, { recursive: true });
  await command(observer);
  await observer.locator('#notice').filter({ hasText: 'Telegram' }).waitFor();
  assert.equal(await observer.locator('#static-removal').isVisible(), false);
  await observer.keyboard.press('Escape');
  checks.push('guest command requires authentication');

  await owner.bringToFront();
  await owner.waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable);
  await owner.locator('#world').focus();
  await owner.keyboard.press('v');
  await owner.waitForFunction(
    () => (window as any).__SU_DEBUG__.controls().view === 'first-person',
  );
  await command(owner);
  await owner.locator('#static-removal').waitFor({ state: 'visible' });
  assert.equal(
    await owner.evaluate(() => (window as any).__SU_DEBUG__.controls().view),
    'overview',
  );
  assert.equal(await owner.evaluate(() => !!document.pointerLockElement), false);
  assert.equal(
    await owner.evaluate(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable),
    false,
  );
  await pointAt(owner, REMOVAL_SEED_OBJECTS.house.entityId, { x: 0, y: 1.4, z: 3 });
  const beforeMove = await owner.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.position,
  );
  await owner.keyboard.down('w');
  await owner.waitForTimeout(300);
  await owner.keyboard.up('w');
  const afterMove = await owner.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.position,
  );
  assert.ok(Math.hypot(afterMove.x - beforeMove.x, afterMove.z - beforeMove.z) < 0.01);
  await owner.screenshot({ path: `${output}/selected-original-building.png` });
  await owner.keyboard.press('Escape');
  await owner.locator('#static-removal').waitFor({ state: 'hidden' });
  assert.equal(
    (await fixture.pool.query("SELECT 1 FROM world_static_operations WHERE source='game'"))
      .rowCount,
    0,
  );
  checks.push(
    'first-person exits to overview; selection freezes movement; Escape cancels without a write',
  );

  await command(owner);
  await owner.locator('#static-removal').waitFor({ state: 'visible' });
  await owner.keyboard.press('x');
  await owner.locator('#static-removal').waitFor({ state: 'hidden' });
  await owner.locator('#inventory-panel').waitFor({ state: 'visible' });
  await owner.keyboard.press('Escape');
  checks.push('opening another panel releases the removal tool');

  // Drop exactly the first result. GameSession must reconcile the same persisted UUID.
  await owner.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (!(typeof data === 'string' || data instanceof Blob)) {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        if (
          new TextDecoder().decode(bytes).includes('removeStatic') &&
          !(window as any).__removalDropInstalled
        ) {
          (window as any).__removalDropInstalled = true;
          const receive = this.onmessage;
          this.onmessage = function (event) {
            const incoming =
              typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
            if (incoming.includes('staticRemovalResult') && !(window as any).__removalDropped) {
              (window as any).__removalDropped = true;
              return;
            }
            return receive?.call(this, event);
          };
        }
      }
      return send.call(this, data);
    };
  });
  const beforeNavigation = navigations;
  const beforeBodies = app.room.diagnostics().bodies;
  for (const [entityId, position] of [
    [REMOVAL_SEED_OBJECTS.house.entityId, { x: 0, y: 1.4, z: 3 }],
    [REMOVAL_SEED_OBJECTS.benchA.entityId, { x: -6, y: 0.75, z: -5 }],
    [REMOVAL_SEED_OBJECTS.tree.entityId, { x: -10, y: 6, z: 3 }],
  ] as const) {
    if (metrics.length) await owner.waitForTimeout(2100);
    await command(owner);
    await owner.locator('#static-removal').waitFor({ state: 'visible' });
    assert.equal(await owner.locator('#static-removal-confirm').isDisabled(), true);
    await pointAt(owner, entityId, position);
    await owner.locator('#static-removal-confirm:not([disabled])').waitFor();
    if (!metrics.length) {
      // A key held before blur must not become a confirmation after focus returns.
      await owner.locator('#static-removal-confirm').focus();
      await owner.keyboard.down('Space');
      await owner.evaluate(() => {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
      });
      await owner.keyboard.up('Space');
      assert.equal(
        (await fixture.pool.query("SELECT 1 FROM world_static_operations WHERE source='game'"))
          .rowCount,
        0,
      );
      await pointAt(owner, entityId, position);
    }
    await owner.screenshot({ path: `${output}/selected-${entityId}.png` });
    const start = performance.now();
    await owner.locator('#static-removal-confirm:not([disabled])').click();
    await owner.locator('#static-removal').waitFor({ state: 'hidden' });
    await playing(owner);
    await playing(observer);
    for (const page of [owner, observer]) {
      await rendered(page, entityId, false);
      await rendered(page, REMOVAL_SEED_OBJECTS.benchB.entityId, true);
    }
    const row = (
      await fixture.pool.query(
        'SELECT enabled,instance_revision FROM world_static_instances WHERE entity_id=$1',
        [entityId],
      )
    ).rows[0];
    assert.deepEqual(row, { enabled: false, instance_revision: 2 });
    metrics.push({
      entityId,
      completionMs: performance.now() - start,
      server: app.room.diagnostics().staticPlacement,
    });
  }
  assert.equal(await owner.evaluate(() => (window as any).__removalDropped), true);
  assert.equal(
    (await fixture.pool.query("SELECT 1 FROM world_static_operations WHERE source='game'"))
      .rowCount,
    3,
  );
  assert.equal(navigations, beforeNavigation);
  assert.ok(app.room.diagnostics().bodies < beforeBodies);
  await owner.screenshot({ path: `${output}/after-removal.png` });
  checks.push(
    'real pointer selection deletes original GLB building, one thin-instance bench and procedural tree',
  );
  checks.push(
    'another instance of the same bench model remains; both clients switch graphics without navigation',
  );
  checks.push(
    'lost response retries one UUID and commits once; stale Space release cannot confirm',
  );

  await ownerContext.close();
  await observerContext.close();
  await app.close();
  app = await createGameServer({ port: 0, accounts: fixture, worldDirectory });
  fixture.config.publicOrigin = app.url;
  const restored = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  restored.on('pageerror', (error) => errors.push(error.message));
  await restored.goto(app.url + '/?diagnostics=1');
  await restored.locator('#join:not([disabled])').click();
  await playing(restored);
  for (const object of [
    REMOVAL_SEED_OBJECTS.house,
    REMOVAL_SEED_OBJECTS.benchA,
    REMOVAL_SEED_OBJECTS.tree,
  ])
    await rendered(restored, object.entityId, false);
  await rendered(restored, REMOVAL_SEED_OBJECTS.benchB.entityId, true);
  checks.push('restart preserves all three deletions and does not reseed authored objects');
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ checks, metrics, errors }, null, 2));
  console.log(JSON.stringify({ checks, metrics, errors }, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
