import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import type { WebSocketClient } from '@colyseus/ws-transport';
import { createAccountFixture, setAccountAdmin } from './helpers/account-fixture.js';
import { createGameServer } from './helpers/game-server.js';
import { launchTestBrowser } from './helpers/browser.js';
import { openChat } from './helpers/hud.js';

// Run after pnpm build, with a disposable local PostgreSQL database.
assert.ok(process.env.SU_TEST_DATABASE_URL, 'Set SU_TEST_DATABASE_URL');
const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const output = 'output/playwright/world-sync';
const checks: string[] = [];
const measurements: Record<string, unknown> = {};
const errors: string[] = [];
const reconnectLog: string[] = [];
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
let nextMutationAt = 0;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function playing(page: Page) {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
  );
}
async function command(page: Page, text: string, ok = true) {
  await delay(Math.max(0, nextMutationAt - performance.now()));
  await openChat(page);
  await page.locator('#chat-input').fill(text);
  const previousNotice = await page.locator('#notice').textContent();
  await page.locator('#chat-send:not([disabled])').click();
  if (ok) {
    await page.waitForFunction(
      () => (document.querySelector('#chat-input') as HTMLInputElement).value === '',
    );
  } else {
    await page.waitForFunction(
      (previous) => document.querySelector('#notice')?.textContent !== previous,
      previousNotice,
    );
    assert.equal(await page.locator('#chat-input').inputValue(), text);
  }
  nextMutationAt = performance.now() + 1100;
}
async function state(page: Page) {
  return page.evaluate(() => {
    const debug = (window as any).__SU_DEBUG__;
    return {
      ...debug.snapshot(),
      rendering: debug.report().rendering,
      clock: document.querySelector('#clock-text')?.textContent,
      theme: document.documentElement.dataset.uiTheme,
      wallNow: Date.now(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });
}
async function expectHour(pages: Page[], hour: number, text: string) {
  for (const page of pages) {
    await page.waitForFunction(
      (expected) => document.querySelector('#clock-text')?.textContent === expected,
      text,
    );
    const value = await state(page);
    assert.ok(Math.abs(value.worldHour - hour) < 0.0001, `session hour ${text}`);
    assert.ok(Math.abs(value.rendering.hour - hour) < 0.0001, `lighting hour ${text}`);
  }
}
async function agree(pages: Page[], label: string) {
  const values = await Promise.all(pages.map(state));
  const spread = Math.abs(values[0].worldTimeMs - values[1].worldTimeMs);
  assert.ok(spread < 1000, `${label}: clock spread ${spread}ms`);
  assert.deepEqual(values[0].weather, values[1].weather);
  measurements[label] = {
    spreadMs: spread,
    clients: values.map(
      ({ worldTimeMs, worldHour, clock, weather, timezone, wallNow, rendering }) => ({
        worldTimeMs,
        worldHour,
        clock,
        weather,
        timezone,
        wallNow,
        environmentHour: rendering.hour,
        amounts: rendering.weather,
      }),
    ),
  };
}

// Start sampling before a real server command or automatic dawn changes data-ui-theme.
function transition(page: Page, selectors: string[], expected: string) {
  const pending = page.evaluate(
    async ({ selectors, expected }) => {
      const read = () =>
        Object.fromEntries(
          selectors.flatMap((selector) => {
            const element = document.querySelector(selector);
            if (!element) return [];
            const style = getComputedStyle(element);
            return [
              [
                selector,
                {
                  background: style.backgroundColor,
                  color: style.color,
                  border: style.borderTopColor,
                  duration: style.transitionDuration,
                },
              ],
            ];
          }),
        );
      const before = read();
      const samples: Array<{ ms: number; styles: ReturnType<typeof read> }> = [];
      const start = performance.now();
      while (document.documentElement.dataset.uiTheme !== expected) {
        if (performance.now() - start > 12_000) throw new Error(`Theme did not become ${expected}`);
        await new Promise(requestAnimationFrame);
      }
      const changed = performance.now();
      do {
        samples.push({ ms: performance.now() - changed, styles: read() });
        await new Promise(requestAnimationFrame);
      } while (performance.now() - changed < 850);
      return { before, samples, after: read() };
    },
    { selectors, expected },
  );
  // The command runs concurrently; propagate sampling errors at the awaited result.
  void pending.catch(() => {});
  return pending;
}
function smooth(
  samples: Awaited<ReturnType<typeof transition>>,
  selector: string,
  property: 'background' | 'color',
) {
  const before = samples.before[selector]?.[property];
  const after = samples.after[selector]?.[property];
  assert.ok(before && after && before !== after, `${selector} ${property} changes`);
  const intermediate = samples.samples.filter((sample) => {
    const value = sample.styles[selector]?.[property];
    return value && value !== before && value !== after;
  });
  assert.ok(
    intermediate.length >= 2,
    `${selector} ${property} has intermediate frames (${intermediate.length})`,
  );
}

try {
  await mkdir(output, { recursive: true });
  app = await createGameServer({ port: 0, accounts: fixture });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser();
  const ownerContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'Europe/Moscow',
  });
  const observerContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'America/Los_Angeles',
    reducedMotion: 'reduce',
  });
  for (const [index, context] of [ownerContext, observerContext].entries()) {
    // tsx's keepNames helper is referenced by functions serialized into page.evaluate.
    await context.addInitScript('globalThis.__name = (fn) => fn;');
    await context.addInitScript((index) => {
      localStorage.setItem('su:render-quality:v1', 'economy');
      localStorage.setItem('su:help-tip:v1', '1');
      localStorage.setItem('su:chat-close:v1', 'never');
      const originalNow = Date.now.bind(Date);
      (window as any).__reviewSkewMs = index ? 3 * 60 * 60 * 1000 : 0;
      Date.now = () => originalNow() + (window as any).__reviewSkewMs;
    }, index);
  }
  const owner = await ownerContext.newPage();
  const observer = await observerContext.newPage();
  const pages = [owner, observer];
  for (const page of pages) {
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.text().includes('Colyseus reconnection')) reconnectLog.push(message.text());
    });
  }
  await owner.goto(app.url);
  await owner.locator('#telegram-login').click();
  await owner.locator('#profile-form').waitFor({ state: 'visible' });
  const cookie = (await ownerContext.cookies()).find((value) => value.name === 'su_session')!;
  await setAccountAdmin(fixture.store, `${cookie.name}=${cookie.value}`);
  await owner.goto(`${app.url}/?diagnostics=1`);
  await owner.locator('#join:not([disabled])').click();
  await playing(owner);
  await command(owner, '/time 17 --stop');
  await command(owner, '/weather --rain --fog --no-clouds');
  const initialRoom = {
    clock: app.room.state.dayFrozenHour,
    phase: app.room.state.dayStartPhaseMs,
    epoch: app.room.state.worldEpoch,
  };
  await delay(1600);
  await observer.goto(`${app.url}/?diagnostics=1`);
  await observer.locator('#join:not([disabled])').waitFor();
  const lobby = await state(observer);
  assert.equal(lobby.worldHour, 17, 'lobby preview uses HTTP clock');
  assert.equal(lobby.rendering.weather.rain, 0, 'lobby has different weather');
  await observer.locator('#join').click();
  await playing(observer);
  await expectHour(pages, 17, '17:00');
  const joined = await state(observer);
  assert.equal(joined.rendering.weather.rain, 1);
  assert.equal(joined.rendering.weather.fog, 1);
  assert.equal(joined.rendering.weather.wetness, 1);
  assert.equal(app.room.state.dayFrozenHour, initialRoom.clock);
  assert.equal(app.room.state.dayStartPhaseMs, initialRoom.phase);
  await agree(pages, 'lateJoin');
  checks.push(
    'late join from clear lobby snaps established rain/fog/wetness; +3h wall clock and different timezones agree',
  );
  await observer.screenshot({ path: `${output}/late-join-rain.png` });

  await command(owner, '/weather --snow --no-fog --clouds');
  for (const page of pages) {
    await page.waitForFunction(() => {
      const debug = (window as any).__SU_DEBUG__;
      return (
        debug.snapshot().weather.precipitation === 'snow' &&
        debug.report().rendering.weather.snow > 0
      );
    });
    const changed = await state(page);
    assert.ok(changed.rendering.weather.snow < 1, 'live weather eases instead of snapping');
    assert.equal(changed.weather.fog, false);
  }
  await agree(pages, 'liveWeather');
  await expectHour(pages, 17, '17:00');
  checks.push(
    'live snow/cloud/fog changes reach both connected clients and interpolate without resetting time',
  );

  for (const [argument, hour, text] of [
    ['5', 5, '05:00'],
    ['00:00', 0, '00:00'],
    ['12:00', 12, '12:00'],
    ['23:00', 23, '23:00'],
    ['--set 13:15', 13.25, '13:15'],
    ['-s 05:45', 5.75, '05:45'],
    ['17', 17, '17:00'],
  ] as const) {
    await command(owner, `/time ${argument}`);
    await expectHour(pages, hour, text);
  }
  for (const text of [
    '/time 17 --set 5',
    '/time 17 --reset',
    '/time --set 17 --reset',
    '/time --stop --start',
  ]) {
    await command(owner, text, false);
    assert.equal(app.room.state.dayFrozenHour, 17);
  }
  await command(observer, '/time 5', false);
  assert.equal(app.room.state.dayFrozenHour, 17);
  assert.match((await observer.locator('#notice').textContent()) ?? '', /Неизвестная команда/);
  await command(owner, '/help time');
  assert.match(await owner.locator('#commands-panel').innerText(), /ЧЧ\[:ММ\]/);
  checks.push(
    '24h positional/--set/-s commands, minute precision and conflicts; guest denial preserves server authority; S-48 help remains available',
  );

  await command(owner, '/time 23');
  await delay(800);
  const selectors = [
    '#clock-chip',
    '#chat-input',
    '#commands-panel',
    '.command-entry',
    '.command-usage',
    '.command-flags dd',
    '.chat-line.sys',
    '.player-label',
  ];
  const daySamples = transition(owner, selectors, 'day');
  const reducedSamples = transition(observer, ['#clock-chip', '#chat-input'], 'day');
  await command(owner, '/time 12');
  measurements.commandDayTransition = await daySamples;
  measurements.reducedMotionTransition = await reducedSamples;
  const day = measurements.commandDayTransition as Awaited<ReturnType<typeof transition>>;
  smooth(day, '#clock-chip', 'background');
  smooth(day, '#chat-input', 'background');
  smooth(day, '.command-entry', 'background');
  smooth(day, '.command-usage', 'color');
  smooth(day, '.command-flags dd', 'color');
  const reduced = measurements.reducedMotionTransition as Awaited<ReturnType<typeof transition>>;
  assert.ok(
    reduced.samples.every(
      (sample) =>
        sample.styles['#clock-chip'].background === reduced.after['#clock-chip'].background,
    ),
    'reduced motion switches on first rendered frame',
  );
  const reverse = transition(owner, selectors, 'night');
  await command(owner, '/time 5');
  measurements.commandNightTransition = await reverse;
  smooth(
    measurements.commandNightTransition as Awaited<ReturnType<typeof transition>>,
    '#clock-chip',
    'background',
  );
  checks.push(
    'live commands interpolate clock, input, /help cards and text in both directions; reduced motion is immediate',
  );

  // Frozen clocks alone would mask the original Date.now()-based 12-hour inversion.
  await command(owner, '/time --start');
  for (const hour of [17, 5]) {
    await command(owner, `/time ${hour}`);
    assert.equal(app.room.state.dayFrozenHour, -1);
    assert.match(
      (await owner.locator('#notice').textContent()) ?? '',
      new RegExp(`${String(hour).padStart(2, '0')}:00`),
    );
    const samples = await Promise.all(
      pages.map(async (page) => {
        await page.waitForFunction((hour) => {
          const value = (window as any).__SU_DEBUG__.snapshot().worldHour;
          const clock = document.querySelector('#clock-text')?.textContent;
          return (
            value >= hour &&
            value < hour + 0.05 &&
            clock?.startsWith(`${String(hour).padStart(2, '0')}:`)
          );
        }, hour);
        return state(page);
      }),
    );
    for (const sample of samples) {
      assert.ok(sample.worldHour >= hour && sample.worldHour < hour + 0.05);
      assert.ok(Math.abs(sample.rendering.hour - sample.worldHour) < 0.02);
      assert.ok(sample.clock.startsWith(`${String(hour).padStart(2, '0')}:`));
    }
    measurements[`runningTime${hour}`] = samples.map(({ clock, worldHour, rendering }) => ({
      clock,
      worldHour,
      lightingHour: rendering.hour,
    }));
  }
  checks.push(
    'running /time 17 and /time 5 agree in HUD and lighting across skewed wall clocks, without freezing',
  );

  const dawn = transition(owner, selectors, 'day');
  await command(owner, '/time 06:59 --start');
  measurements.naturalDawn = await dawn;
  smooth(
    measurements.naturalDawn as Awaited<ReturnType<typeof transition>>,
    '#clock-chip',
    'background',
  );
  await agree(pages, 'runningClock');
  for (const skew of [12 * 60_000, -3 * 60 * 60_000]) {
    await observer.evaluate((skew) => ((window as any).__reviewSkewMs = skew), skew);
    await delay(500);
    await agree(pages, `clockSkew${skew}`);
  }
  checks.push(
    'automatic dawn interpolates during a running shared day; changing client wall clock by +12min/-3h does not change world time',
  );

  const peerId = (await state(observer)).sessionId;
  await observerContext.setOffline(true);
  (app.room.clients.getById(peerId)! as WebSocketClient).ref.terminate();
  await observer.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
  );
  const offlineBefore = await state(observer);
  await command(owner, '/time 23 --stop');
  await command(owner, '/weather --snow --fog --no-clouds');
  const beforeReconnect = await state(owner);
  await delay(1500);
  const offlineAfter = await state(observer);
  assert.ok(
    offlineAfter.worldTimeMs - offlineBefore.worldTimeMs >= 1500,
    'room time continues through the network pause',
  );
  assert.ok(
    offlineAfter.worldHour > 7 && offlineAfter.worldHour < 8,
    'offline clock keeps its last phase',
  );
  measurements.networkPause = {
    before: offlineBefore.worldTimeMs,
    after: offlineAfter.worldTimeMs,
    hour: offlineAfter.worldHour,
  };
  await observerContext.setOffline(false);
  await playing(observer);
  await expectHour(pages, 23, '23:00');
  const recovered = await state(observer);
  assert.equal(recovered.sessionId, peerId);
  assert.equal(recovered.rendering.weather.snow, 1);
  assert.equal(recovered.rendering.weather.snowCover, 1);
  assert.equal(recovered.rendering.weather.fog, 1);
  assert.equal(app.room.state.dayStartPhaseMs, initialRoom.phase);
  assert.equal(app.room.state.worldEpoch, initialRoom.epoch);
  assert.equal(beforeReconnect.dayClock.frozenHour, app.room.state.dayFrozenHour);
  await agree(pages, 'sdkReconnect');
  await observer.screenshot({ path: `${output}/reconnect-snow.png` });
  checks.push(
    'network pause and SDK reconnect receive changed time/snow/fog immediately, preserving the other player and room identity',
  );

  await observer.reload();
  await playing(observer);
  await expectHour(pages, 23, '23:00');
  assert.equal((await state(observer)).rendering.weather.snowCover, 1);
  await agree(pages, 'reloadReconnect');
  checks.push(
    'stored-token reload reconnect keeps clock and established snow without lobby interpolation',
  );

  await owner.locator('#commands-panel .pop-close').click();
  await owner.locator('#help-toggle').click();
  const settingSelectors = ['#help-panel', '.setting-label', '.help-note', '.pop-sub', '.ui-kbd'];
  const manual = transition(owner, settingSelectors, 'day');
  await owner.locator('[data-theme-mode="day"]').click();
  measurements.manualTheme = await manual;
  smooth(
    measurements.manualTheme as Awaited<ReturnType<typeof transition>>,
    '.setting-label',
    'color',
  );
  const buttonTransitions = await owner.locator('#help-close').evaluate((element) => ({
    properties: getComputedStyle(element).transitionProperty,
    duration: getComputedStyle(element).transitionDuration,
  }));
  assert.match(buttonTransitions.properties, /transform/);
  assert.match(buttonTransitions.duration, /0.28s/);
  await owner.locator('[data-theme-mode="auto"]').click();
  await delay(800);
  await owner.screenshot({ path: `${output}/night-settings.png` });
  measurements.buttonTransitions = buttonTransitions;
  checks.push(
    'manual theme interpolation includes settings labels; button transform transitions survive',
  );
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  const report = {
    result: 'passed',
    browser: browser.version(),
    checks,
    measurements,
    reconnectLog,
    errors,
  };
  await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: report.result, browser: report.browser, checks }, null, 2));
} catch (error) {
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify({ error: String(error), checks, measurements, reconnectLog, errors }, null, 2) +
      '\n',
  );
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
}
