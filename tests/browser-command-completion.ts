import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import type { WebSocketClient } from '@colyseus/ws-transport';
import {
  createAccountFixture,
  loginAccount,
  responseCookie,
  setAccountAdmin,
} from './helpers/account-fixture.js';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { openChat } from './helpers/hud.js';

if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('Set SU_TEST_DATABASE_URL to a test PostgreSQL database.');
const output = 'output/playwright/command-completion';
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
const checks: string[] = [],
  errors: string[] = [],
  layouts: unknown[] = [];
function passed(message: string) {
  checks.push(message);
  console.log('PASS', message);
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'server state reaches the expected condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 45_000 },
  );
}
async function join(page: Page) {
  await page.goto(app!.url + '/?diagnostics=1');
  await page.locator('#join:not([disabled])').click({ timeout: 45_000 });
  await playing(page);
}
async function login(context: BrowserContext, subject: string, admin: boolean, name: string) {
  const { result } = await loginAccount(app!.url, subject);
  const cookie = responseCookie(result, 'su_session');
  await setAccountAdmin(fixture.store, cookie, admin);
  const account = await fixture.store.authenticate(cookie.split('=')[1]);
  await fixture.pool.query('UPDATE player_profiles SET display_name=$2 WHERE account_id=$1', [
    account!.accountId,
    name,
  ]);
  await context.addCookies([{ name: 'su_session', value: cookie.split('=')[1], url: app!.url }]);
  return account!;
}
async function type(page: Page, text: string) {
  await page.bringToFront();
  await playing(page);
  await openChat(page);
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-input').press('End');
}
async function send(page: Page, text: string) {
  await type(page, text);
  await page.locator('#chat-send:not([disabled])').waitFor();
  await page.locator('#chat-input').press('Shift+Enter');
  await page.waitForFunction(
    () => (document.querySelector('#chat-input') as HTMLInputElement).value === '',
  );
}
async function labels(page: Page) {
  return page.locator('#chat-suggest .chat-suggest-option code').allTextContents();
}
async function onlyHelp(page: Page) {
  await type(page, '/');
  await page.waitForFunction(
    () => document.querySelector('#chat-suggest code')?.textContent === '/help',
  );
  assert.deepEqual(await labels(page), ['/help']);
  await type(page, '/help ');
  assert.deepEqual(await labels(page), ['help']);
  await type(page, '/ti');
  assert.equal(await page.locator('#chat-suggest').isVisible(), false);
}
async function session(page: Page) {
  const entityId = await page.evaluate(
    () => (window as any).__SU_DEBUG__.snapshot().authoritative.entityId,
  );
  const [id] = [...app!.room.state.players].find(([, player]) => player.entityId === entityId)!;
  // Observe the real server connection and its test-only account fixture, without changing target checks.
  const state = (app!.room as any).sessions.get(id);
  return { id, state };
}
async function reconnect(page: Page) {
  await page.bringToFront();
  await playing(page);
  const { id, state } = await session(page),
    period = state.connectionPeriod;
  (app!.room.clients.getById(id)! as WebSocketClient).ref.terminate();
  await until(() => state.connectionPeriod > period && state.connected);
  await playing(page);
}

try {
  await mkdir(output, { recursive: true });
  app = await createGameServer({ port: 0, accounts: fixture, itemCreationEnabled: true });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser({ channel: 'chromium' });
  const contexts = await Promise.all(
    [0, 1, 2].map(() => browser!.newContext({ viewport: { width: 1280, height: 720 } })),
  );
  for (const context of contexts)
    await context.addInitScript(() => {
      localStorage.setItem('su:render-quality:v1', 'economy');
      localStorage.setItem('su:help-tip:v1', '1');
      localStorage.setItem('su:chat-close:v1', 'never');
    });
  const [adminContext, ordinaryContext] = contexts;
  let admin = await login(adminContext, 'completion-admin', true, 'Администратор');
  await login(ordinaryContext, 'completion-recipient', false, 'Получатель с пробелом');
  const [owner, ordinary, guest] = await Promise.all(contexts.map((context) => context.newPage()));
  let catalogRequests = 0;
  owner.on('websocket', (socket) =>
    socket.on('framesent', (frame) => {
      if (Buffer.from(frame.payload).includes(Buffer.from('requestCommands'))) catalogRequests++;
    }),
  );
  for (const page of [owner, ordinary, guest]) {
    page.setDefaultTimeout(20_000);
    page.on('pageerror', (error) => errors.push(error.message));
    await join(page);
  }
  assert.equal(catalogRequests, 0);
  for (const page of [ordinary, guest]) await onlyHelp(page);
  await type(owner, '/');
  await owner.locator('#chat-suggest').waitFor();
  assert.equal(catalogRequests, 1);
  assert.ok((await labels(owner)).includes('/give'));
  passed(
    'three real clients: lazy first-slash catalog; guest/ordinary catalogs and help choices contain only help',
  );

  const input = owner.locator('#chat-input');
  await type(owner, '/give @');
  const option = owner
    .locator('#chat-suggest .chat-suggest-option')
    .filter({ hasText: '@Получатель с пробелом' });
  const held = await option.elementHandle(),
    box = await option.boundingBox();
  assert.ok(held && box);
  await owner.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await owner.mouse.down();
  await owner.waitForTimeout(350);
  assert.equal(
    await held.evaluate((node) => node.isConnected),
    true,
    'pointer target survives the 250 ms status refresh',
  );
  await owner.mouse.up();
  assert.equal(await input.inputValue(), '/give @"Получатель с пробелом" ');
  await owner.locator('#chat-input:focus').waitFor();
  await type(owner, '/ti');
  await owner.locator('#chat-suggest .chat-suggest-option').click();
  assert.equal(await input.inputValue(), '/time ');
  passed(
    'held mouse click across a status refresh and ordinary click select suggestions and retain input focus',
  );

  await type(owner, '/time --st');
  await input.press('Tab');
  assert.equal(await input.inputValue(), '/time --stop ');
  await input.press('Tab');
  assert.equal(await input.inputValue(), '/time --start ');
  await input.press('Shift+Tab');
  assert.equal(await input.inputValue(), '/time --stop ');
  await input.press('ArrowLeft');
  await input.press('Tab');
  assert.equal(await input.inputValue(), '/time --stop  ');
  for (const [text, expected] of [
    ['/givem', ['/giveme']],
    ['/m', ['/motherlode']],
    ['/v', ['/vilievna']],
    ['/time --stop --', ['--set ЧЧ[:ММ], -s']],
    ['/time 18:30 --', ['--stop', '--start']],
  ] as const) {
    await type(owner, text);
    assert.deepEqual(await labels(owner), expected);
  }
  for (const text of [
    '/time --set 18:30 --stop ',
    '/time --reset ',
    '/speed @Получатель --set 2 ',
    '/speed @Получатель --reset ',
    '/give --list ',
    '/give --list w',
    '/give --list @',
  ]) {
    await type(owner, text);
    assert.equal(await owner.locator('#chat-suggest').isVisible(), false, text);
  }
  await type(owner, '/give ');
  assert.ok((await labels(owner)).includes('wooden-crate'));
  await input.press('Shift+Tab');
  assert.equal(await input.inputValue(), '/give --list ');
  await type(owner, '/give @"Получатель с пробелом" ');
  assert.ok(!(await labels(owner)).some((label) => label.startsWith('--list')));
  await type(owner, '/time --s');
  await input.press('Tab');
  assert.equal(await input.inputValue(), '/time --set ');
  assert.match(await owner.locator('#chat-suggest').innerText(), /ЧЧ\[:ММ\]/);
  passed(
    'Tab/Shift+Tab, caret changes, aliases, argument hints and conflicting/list flag suppression',
  );

  await send(owner, '/time 18:30 --stop');
  assert.equal(app.room.state.dayFrozenHour, 18.5);
  await send(owner, '/speed @"Получатель с пробелом" 2');
  await send(owner, '/give @"Получатель с пробелом" wooden-crate');
  assert.equal(
    (await fixture.pool.query('SELECT count(*)::int AS n FROM item_operations')).rows[0].n,
    1,
  );
  await send(owner, 'Сообщение после автодополнения');
  await ordinary
    .locator('.player-chat')
    .filter({ hasText: 'Сообщение после автодополнения' })
    .waitFor();
  passed(
    'short time/speed forms, addressed give with a quoted unique name, private command and normal multi-client chat',
  );

  for (const [width, height] of [
    [1280, 720],
    [1280, 500],
    [640, 360],
    [390, 700],
  ]) {
    await owner.setViewportSize({ width, height });
    if (await owner.locator('#commands-panel').isVisible())
      await owner.locator('#commands-panel .pop-close').click();
    await send(owner, '/help');
    await owner.locator('#commands-panel').waitFor();
    await type(owner, '/give ');
    await owner.locator('#chat-suggest').waitFor();
    await owner.waitForTimeout(300);
    assert.equal(
      await owner.locator('#commands-panel').isVisible(),
      true,
      'help remains open while composing',
    );
    const geometry = await owner.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('#commands-panel .catalog-scroll')!;
      return {
        connection: (window as any).__SU_DEBUG__.snapshot().connection,
        help: document.querySelector('#commands-panel')!.getBoundingClientRect().toJSON(),
        top: document.querySelector('.hud-help')!.getBoundingClientRect().toJSON(),
        suggest: document.querySelector('#chat-suggest')!.getBoundingClientRect().toJSON(),
        row: document.querySelector('#chat-row')!.getBoundingClientRect().toJSON(),
        scroll: { client: scroll.clientHeight, total: scroll.scrollHeight },
      };
    });
    assert.ok(geometry.help.y > geometry.top.bottom && geometry.help.bottom < geometry.suggest.y);
    assert.ok(geometry.suggest.height >= 24 && geometry.row.bottom <= height + 1);
    assert.ok(geometry.scroll.total > geometry.scroll.client);
    const scroll = owner.locator('#commands-panel .catalog-scroll');
    await scroll.evaluate((node) => (node.scrollTop = node.scrollHeight));
    assert.ok(await scroll.evaluate((node) => node.scrollTop > 0));
    await owner.screenshot({ path: `${output}/${width}x${height}.png` });
    layouts.push({ width, height, ...geometry });
    await owner.locator('#commands-panel .pop-close').click();
  }
  passed(
    'help plus suggestions with three connected clients at 1280x720, 1280x500, 640x360 and 390x700; independent scrolling and top HUD clearance',
  );

  await owner.setViewportSize({ width: 1280, height: 720 });
  await fixture.pool.query('UPDATE accounts SET is_admin=false WHERE id=$1', [admin.accountId]);
  let before = catalogRequests;
  await reconnect(owner);
  await onlyHelp(owner);
  assert.ok(catalogRequests > before);
  before = catalogRequests;
  await type(owner, '/time');
  await owner.locator('#chat-send:not([disabled])').waitFor();
  await input.press('Shift+Enter');
  await owner.locator('#notice').filter({ hasText: 'Неизвестная команда.' }).waitFor();
  await onlyHelp(owner);
  assert.ok(catalogRequests > before, 'unknown-command denial refreshes the catalog');
  before = catalogRequests;
  await type(owner, '/help');
  await owner.locator('#chat-send:not([disabled])').waitFor();
  await input.press('Shift+Enter');
  await owner.locator('#notice').filter({ hasText: 'Нет доступных команд.' }).waitFor();
  await onlyHelp(owner);
  assert.ok(catalogRequests > before, 'admin-required denial refreshes the catalog');
  await fixture.pool.query('UPDATE accounts SET is_admin=true WHERE id=$1', [admin.accountId]);
  before = catalogRequests;
  await reconnect(owner);
  await type(owner, '/');
  await owner.waitForFunction(
    () => document.querySelector('#chat-suggest code')?.textContent === '/time',
  );
  assert.ok(catalogRequests > before);
  for (const page of [ordinary, guest]) await onlyHelp(page);
  passed(
    'SDK reconnect refreshes revoked and restored admin role; unknown-command denial refreshes catalog; other clients never gain admin commands',
  );

  for (const reason of ['revoked', 'expired'] as const) {
    await type(owner, '/');
    const { id, state } = await session(owner);
    await fixture.pool.query('UPDATE accounts SET is_admin=false WHERE id=$1', [admin.accountId]);
    if (reason === 'revoked') {
      await fixture.pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1', [
        state.auth.authSessionId,
      ]);
      app.room.revokeAuthSession(state.auth.authSessionId);
    } else {
      await fixture.pool.query(
        "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
        [state.auth.authSessionId],
      );
      state.auth.expiresAt = Date.now() - 1;
    }
    await owner.waitForFunction(
      () => (window as any).__SU_DEBUG__?.snapshot().connection === 'ready',
    );
    await until(() => !app!.room.state.players.has(id));
    assert.equal(await owner.locator('#chat-suggest').isVisible(), false);
    admin = await login(adminContext, 'completion-admin', false, 'Администратор');
    await join(owner);
    await onlyHelp(owner);
    for (const page of [ordinary, guest]) await onlyHelp(page);
    passed(
      `${reason} authentication clears the old catalog; reauthentication with revoked admin role delivers only help to all ordinary clients`,
    );
    if (reason === 'revoked') {
      await fixture.pool.query('UPDATE accounts SET is_admin=true WHERE id=$1', [admin.accountId]);
      await reconnect(owner);
      await type(owner, '/');
      await owner.waitForFunction(
        () => document.querySelector('#chat-suggest code')?.textContent === '/time',
      );
    }
  }
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(String(error));
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await fixture.close();
  await writeFile(`${output}/checks.json`, JSON.stringify({ checks, layouts, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
}
