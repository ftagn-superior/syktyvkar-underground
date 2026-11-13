import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { buildStaticPlacementWorld } from './helpers/static-placement-world.js';
import { launchTestBrowser } from './helpers/browser.js';
import { rotateCamera } from './helpers/camera.js';
import { chatSent, hudClick, openChat } from './helpers/hud.js';
import { placedStaticInstance, type PlaceStaticRequest } from '../packages/contracts/src/index.js';
if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('Set SU_TEST_DATABASE_URL to a test PostgreSQL database.');
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const directory = await mkdtemp(join(tmpdir(), 'su-static-browser-'));
const city = process.env.SU_STATIC_PLACEMENT_WORLD === 'ring-block';
const worldDirectory = city ? 'dist/worlds/ring-block' : await buildStaticPlacementWorld(directory);
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
const errors: string[] = [];
const pages: Page[] = [];
async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 20000 },
  );
}
async function command(page: Page, text: string) {
  await page.bringToFront();
  if (await page.evaluate(() => (window as any).__SU_DEBUG__.controls().view === 'first-person')) {
    await page.locator('#world').focus();
    await page.keyboard.press('t');
  } else await openChat(page);
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send:not([disabled])').click();
}
try {
  app = await createGameServer({ port: 0, accounts: fixture, worldDirectory });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser({ channel: 'chromium' });
  const ownerContext = await browser.newContext({ viewport: { width: 960, height: 675 } });
  const observerContext = await browser.newContext({ viewport: { width: 960, height: 675 } });
  for (const context of [ownerContext, observerContext])
    await context.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  const owner = await ownerContext.newPage(),
    observer = await observerContext.newPage();
  pages.push(owner, observer);
  let navigations = 0;
  for (const page of [owner, observer]) {
    page.setDefaultTimeout(45000);
    page.on('pageerror', (e) => {
      errors.push(e.message);
      console.error('Page error:', e.message);
    });
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navigations++;
    });
  }
  await owner.goto(app.url);
  await owner.locator('#telegram-login').click();
  await owner.locator('#profile-form').waitFor({ state: 'visible' });
  for (const page of [owner, observer]) {
    await page.bringToFront();
    await page.goto(app.url + '/?diagnostics=1');
    if (city)
      await page.waitForFunction(
        () => (window as any).__SU_DEBUG__?.snapshot().streaming?.backgroundReady === true,
        undefined,
        { timeout: 60000 },
      );
    await page.locator('#join:not([disabled])').click();
    await playing(page);
  }
  await command(observer, '/motherlode');
  await observer.locator('#notice').filter({ hasText: 'Telegram' }).waitFor();
  await observer.keyboard.press('Escape');
  await command(owner, 'Обычная реплика перед командой');
  await chatSent(owner);
  await owner.waitForFunction(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable);
  await owner.locator('#world').focus();
  await owner.keyboard.press('v');
  await owner.waitForFunction(
    () => (window as any).__SU_DEBUG__.controls().view === 'first-person',
  );
  await command(owner, '/motherlode');
  await owner.locator('#static-placement').waitFor({ state: 'visible' });
  await owner.waitForFunction(
    () =>
      (window as any).__SU_DEBUG__.controls().view === 'overview' && !document.pointerLockElement,
  );
  await owner.keyboard.press('v');
  assert.equal(
    await owner.evaluate(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable),
    false,
    'placement keeps the pointer in overview until the draft is closed',
  );
  assert.equal(
    await owner.evaluate(() => (window as any).__SU_DEBUG__.controls().view),
    'overview',
  );
  // Cancel the first preview; it must never produce a row.
  await owner.keyboard.press('Escape');
  await owner.locator('#static-placement').waitFor({ state: 'hidden' });
  assert.equal(
    (
      await fixture.pool.query(
        "SELECT count(*)::int AS n FROM world_static_operations WHERE source='game'",
      )
    ).rows[0].n,
    0,
  );
  await command(owner, '/motherlode');
  await owner.locator('#static-placement').waitFor({ state: 'visible' });
  await owner.keyboard.press('x');
  await owner.locator('#static-placement').waitFor({ state: 'hidden' });
  await owner.locator('#inventory-panel').waitFor({ state: 'visible' });
  await owner.keyboard.press('Escape');
  // Every competing panel must release placement input and its transient ghost.
  for (const [toggle, panel] of [
    ['#help-toggle', '#help-panel'],
    ['#players-toggle', '#players-panel'],
    ['#reactions-toggle', '#reactions-panel'],
    ['#animations-toggle', '#animations-panel'],
    ['#diagnostics-toggle', '#diagnostics'],
  ]) {
    await command(owner, '/motherlode');
    await owner.locator('#static-placement').waitFor({ state: 'visible' });
    await hudClick(owner, toggle);
    await owner.locator('#static-placement').waitFor({ state: 'hidden' });
    await owner.locator(panel).waitFor({ state: 'visible' });
    assert.equal(
      await owner.evaluate(() => (window as any).__SU_DEBUG__.controls().firstPersonAvailable),
      true,
      'closing placement releases its exclusive input mode',
    );
    await hudClick(owner, toggle);
  }
  await command(owner, '/motherlode');
  await owner.locator('#static-placement').waitFor({ state: 'visible' });
  await owner.locator('#world').dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 71,
    clientX: 700,
    clientY: 400,
  });
  await owner.locator('#static-placement').waitFor({ state: 'hidden' });
  await owner.keyboard.press('w'); // The mode-switching press is consumed.
  await command(owner, '/motherlode');
  await owner.locator('#static-placement').waitFor({ state: 'visible' });
  const frozen = await owner.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.position,
  );
  for (const key of ['w', 's', 'q', 'e']) await owner.keyboard.press(key);
  await owner.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });
  assert.deepEqual(
    await owner.evaluate(() => (window as any).__SU_DEBUG__.snapshot().authoritative.position),
    frozen,
  );
  await owner.keyboard.press('d');
  if (!city) {
    await owner.mouse.move(480, 300);
    await owner.mouse.wheel(0, 350);
    await owner.waitForFunction(
      () => (window as any).__SU_DEBUG__.report().rendering.camera.zoom > 1.3,
    );
  }
  let sent: PlaceStaticRequest | undefined;
  await owner.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (!(typeof data === 'string' || data instanceof Blob)) {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        if (new TextDecoder().decode(bytes).includes('placeStatic')) {
          (window as any).__placementReplay = { socket: this, bytes: Array.from(bytes) };
          if (!(window as any).__placementDropInstalled) {
            (window as any).__placementDropInstalled = true;
            const receive = this.onmessage;
            this.onmessage = function (event) {
              const incoming =
                typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
              if (
                incoming.includes('staticPlacementResult') &&
                !(window as any).__placementDropped
              ) {
                (window as any).__placementDropped = true;
                return;
              }
              return receive?.call(this, event);
            };
          }
        }
      }
      return send.call(this, data);
    };
  });
  // Use the same canvas pointer path as a player. Search only for a bounded free target.
  const confirm = owner.locator('#static-placement-confirm');
  await mkdir('output/playwright', { recursive: true });
  const beforeNav = navigations;
  const oldMap = (await owner.evaluate(() => (window as any).__SU_DEBUG__.snapshot())).publication
    .mapVersion;
  let placed = false;
  const refusals: string[] = [];
  for (const y of [380, 400, 420, 460, 500, 520]) {
    for (const x of [800, 850, 900, 950, 450, 400]) {
      await owner.mouse.move(x * 0.75, y * 0.75);
      await owner.waitForTimeout(80);
      if (!(await confirm.isEnabled())) continue;
      if (!city && !refusals.length) {
        await confirm.focus();
        await owner.keyboard.down('Space');
        await owner.evaluate(() => {
          window.dispatchEvent(new Event('blur'));
          window.dispatchEvent(new Event('focus'));
        });
        await owner.keyboard.up('Space');
        assert.equal(
          (
            await fixture.pool.query(
              "SELECT count(*)::int AS n FROM world_static_operations WHERE source='game'",
            )
          ).rows[0].n,
          0,
          'a Space press from before blur cannot confirm after focus',
        );
      }
      if (!refusals.length)
        await owner.screenshot({ path: 'output/playwright/static-placement-preview.png' });
      await confirm.click();
      await owner.waitForFunction(
        () => !(window as any).__SU_DEBUG__.snapshot().staticPlacementPending,
        undefined,
        { timeout: 20000 },
      );
      if (
        (
          await fixture.pool.query(
            "SELECT count(*)::int AS n FROM world_static_operations WHERE source='game'",
          )
        ).rows[0].n === 1
      ) {
        placed = true;
        break;
      }
      refusals.push(await owner.locator('#notice').innerText());
    }
    if (placed) break;
  }
  assert.ok(placed, `server accepted a free pointer target; refusals: ${refusals.join('; ')}`);
  await owner.locator('#notice').filter({ hasText: 'Скамейка сохранена' }).waitFor();
  await playing(owner);
  await playing(observer);
  assert.equal(
    await owner.evaluate(() => (window as any).__placementDropped),
    true,
    'first write result was lost; pending replay resolved it',
  );
  const history = (
    await fixture.pool.query("SELECT * FROM world_static_operations WHERE source='game'")
  ).rows;
  assert.equal(history.length, 1);
  const row = history[0];
  sent = {
    operationId: row.operation_id,
    worldEpoch: app.room.state.worldEpoch,
    assetReleaseVersion: (await fetch(app.url + '/api/world').then((r) => r.json()))
      .assetReleaseVersion,
    expectedLayoutRevision: row.layout_revision - 1,
    position: { x: row.after_state.position_x, z: row.after_state.position_z },
    yawStep: 1,
  };
  assert.deepEqual(placedStaticInstance(sent).rotation, {
    x: row.after_state.rotation_x,
    y: row.after_state.rotation_y,
    z: row.after_state.rotation_z,
    w: row.after_state.rotation_w,
  });
  const snapshot = await owner.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
  const self = snapshot.authoritative.position;
  assert.ok(
    Math.hypot(sent.position.x - self.x, sent.position.z - self.z) > 3,
    'placement exceeds item reach',
  );
  for (const page of [owner, observer]) {
    await page.waitForFunction(
      (map) => (window as any).__SU_DEBUG__.snapshot().publication.mapVersion !== map,
      oldMap,
    );
    await page.waitForFunction(
      (id) =>
        (window as any).__SU_DEBUG__.buildings().buildings.some((b: any) => b.entityId === id),
      row.entity_id,
    );
  }
  assert.equal(navigations, beforeNav, 'successful live placement does not navigate');
  assert.equal(app.room.state.paused, false);
  await observer.bringToFront();
  {
    const angle = (sent.yawStep * Math.PI) / 12;
    const approach = {
      x: sent.position.x + Math.sin(angle) * 3,
      z: sent.position.z + Math.cos(angle) * 3,
    };
    // Approach the centre of the broad face; an oblique walk along the end legitimately slides around it.
    let before = await observer.evaluate(
      () => (window as any).__SU_DEBUG__.snapshot().authoritative.position,
    );
    for (let attempt = 0; attempt < 90; attempt++) {
      const dx = approach.x - before.x,
        dz = approach.z - before.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.2) break;
      const azimuth = await observer.evaluate(
        () => (window as any).__SU_DEBUG__.report().rendering.camera.azimuth,
      );
      const turn = Math.atan2(
        Math.sin(Math.atan2(-dz, -dx) - azimuth),
        Math.cos(Math.atan2(-dz, -dx) - azimuth),
      );
      if (Math.abs(turn) > 0.015) await rotateCamera(observer, turn);
      await observer.locator('#world').focus();
      await observer.keyboard.down('w');
      await observer.waitForTimeout(Math.min(500, Math.max(60, (distance / 8) * 1000)));
      await observer.keyboard.up('w');
      before = await observer.evaluate(
        () => (window as any).__SU_DEBUG__.snapshot().authoritative.position,
      );
    }
    assert.ok(
      Math.hypot(before.x - approach.x, before.z - approach.z) < 0.4,
      'observer reaches the approach point',
    );
    const dx = sent.position.x - before.x,
      dz = sent.position.z - before.z;
    const azimuth = await observer.evaluate(
      () => (window as any).__SU_DEBUG__.report().rendering.camera.azimuth,
    );
    await rotateCamera(
      observer,
      Math.atan2(
        Math.sin(Math.atan2(-dz, -dx) - azimuth),
        Math.cos(Math.atan2(-dz, -dx) - azimuth),
      ),
    );
    await observer.locator('#world').focus();
    await observer.keyboard.down('w');
    await observer.waitForTimeout(5000);
    await observer.keyboard.up('w');
    const after = await observer.evaluate(
      () => (window as any).__SU_DEBUG__.snapshot().authoritative.position,
    );
    console.log(
      'Collision probe',
      JSON.stringify({
        before,
        after,
        target: sent.position,
        controls: await observer.evaluate(() => (window as any).__SU_DEBUG__.controls()),
      }),
    );
    assert.ok(
      Math.hypot(after.x - sent.position.x, after.z - sent.position.z) < 1.7,
      'observer reaches the newly published bench',
    );
    assert.ok(
      (sent.position.x - after.x) * dx + (sent.position.z - after.z) * dz > 0,
      'bench stops the observer before crossing its centre',
    );
    const predicted = await observer.evaluate(
      () => (window as any).__SU_DEBUG__.snapshot().predicted.position,
    );
    assert.ok(
      Math.hypot(after.x - predicted.x, after.z - predicted.z) < 0.3,
      'client and server agree at contact',
    );
  }
  const liveMetrics = app.room.diagnostics().staticPlacement;
  await observer.screenshot({ path: 'output/playwright/static-placement-observer.png' });
  await owner.evaluate(() => {
    const r = (window as any).__placementReplay;
    r.socket.send(new Uint8Array(r.bytes));
  });
  await owner.waitForTimeout(100);
  assert.equal(
    (
      await fixture.pool.query(
        "SELECT count(*)::int AS n FROM world_static_operations WHERE source='game'",
      )
    ).rows[0].n,
    1,
  );
  await ownerContext.close();
  await observerContext.close();
  const port = Number(new URL(app.url).port);
  await app.close();
  app = await createGameServer({ port, accounts: fixture, worldDirectory });
  fixture.config.publicOrigin = app.url;
  const freshContext = await browser.newContext({ viewport: { width: 960, height: 675 } });
  await freshContext.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
  const fresh = await freshContext.newPage();
  pages.push(fresh);
  await fresh.goto(app.url + '/?diagnostics=1');
  if (city)
    await fresh.waitForFunction(
      () => (window as any).__SU_DEBUG__?.snapshot().streaming?.backgroundReady === true,
      undefined,
      { timeout: 60000 },
    );
  await fresh.locator('#join:not([disabled])').click();
  await playing(fresh);
  await fresh.waitForFunction(
    (id) => (window as any).__SU_DEBUG__.buildings().buildings.some((b: any) => b.entityId === id),
    row.entity_id,
  );
  assert.equal(
    (
      await fixture.pool.query('SELECT entity_id FROM world_static_instances WHERE entity_id=$1', [
        row.entity_id,
      ])
    ).rows[0].entity_id,
    row.entity_id,
  );
  assert.equal(
    (
      await fixture.pool.query(
        "SELECT count(*)::int AS n FROM world_static_operations WHERE source='game'",
      )
    ).rows[0].n,
    1,
  );
  const result = {
    ok: true,
    entityId: row.entity_id,
    position: sent.position,
    layoutRevision: row.layout_revision,
    errors,
    refusals,
    metrics: liveMetrics,
    preparations: snapshot.preparations,
  };
  await writeFile(
    `output/playwright/static-placement${city ? '-city' : ''}.json`,
    JSON.stringify(result, null, 2) + '\n',
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error);
  for (const [i, page] of pages.entries()) {
    if (!page.isClosed()) {
      console.error(
        'Page state',
        i,
        await page.evaluate(() => ({
          body: document.body.innerText,
          join: {
            disabled: (document.querySelector('#join') as HTMLButtonElement)?.disabled,
            html: document.querySelector('#join')?.outerHTML,
          },
          debug: (window as any).__SU_DEBUG__?.snapshot(),
        })),
      );
      await page.screenshot({ path: `output/playwright/static-failure-${i}.png` }).catch(() => {});
    }
  }
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
