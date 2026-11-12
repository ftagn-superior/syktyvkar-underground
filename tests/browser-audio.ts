import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { createGameServer } from './helpers/game-server.js';
import { createAccountFixture } from './helpers/account-fixture.js';
import { launchTestBrowser } from './helpers/browser.js';
import { buildWorld } from '../tools/world-build/src/index.js';

// Run after the client build. All SQL writes live in the fixture's private schema.
if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('Set SU_TEST_DATABASE_URL and build the client before running browser-audio.ts.');

interface AudioSnapshot {
  ready: boolean;
  unlocked: boolean;
  active: boolean;
  loadedAssets: number;
  failedAssets: number;
  errors: number;
  dropped: number;
  played: Record<string, number>;
  activeWorldVoices: number;
  activeUiVoices: number;
  listener?: { x: number; y: number; z: number };
  settings: { muted: boolean; volume: number; worldVolume: number; uiVolume: number };
}

const fixture = await createAccountFixture(process.env.SU_TEST_DATABASE_URL);
const temporary = await mkdtemp(join(tmpdir(), 'su-browser-audio-'));
const output = 'output/playwright/audio';
const checks: string[] = [];
const errors: string[] = [];
let app: Awaited<ReturnType<typeof createGameServer>> | undefined;
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;

async function audio(page: Page): Promise<AudioSnapshot> {
  return page.evaluate(() => (window as any).__SU_DEBUG__.audio());
}
async function snapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
}
const count = (state: AudioSnapshot, cue: string) => state.played[cue] ?? 0;
const total = (state: AudioSnapshot) => Object.values(state.played).reduce((sum, n) => sum + n, 0);

async function playing(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    undefined,
    { timeout: 30_000 },
  );
}
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__SU_DEBUG__?.audio().ready, undefined, {
    timeout: 30_000,
  });
  const state = await audio(page);
  assert.equal(state.loadedAssets, 17, 'all 17 real WAV assets are fetched and decoded');
  assert.equal(state.failedAssets, 0);
  assert.equal(state.errors, 0);
}
async function audible(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = (window as any).__SU_DEBUG__?.audio();
    return state?.active && state.unlocked && state.listener;
  });
}
async function cueCount(page: Page, cue: string, expected: number): Promise<void> {
  await page.waitForFunction(
    ({ cue, expected }) => ((window as any).__SU_DEBUG__.audio().played[cue] ?? 0) >= expected,
    { cue, expected },
  );
  assert.equal(count(await audio(page), cue), expected, `${cue} plays exactly ${expected} times`);
}
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const velocity = (window as any).__SU_DEBUG__.snapshot().authoritative?.velocity;
    return velocity && Math.hypot(velocity.x, velocity.z) < 0.08;
  });
  // Allow the remote interpolation timeline and any already-started short sounds to settle.
  await page.waitForTimeout(350);
}
function checked(message: string): void {
  checks.push(message);
  console.log('Audio:', message);
}

try {
  await mkdir(output, { recursive: true });
  await cp('content', join(temporary, 'content'), { recursive: true });
  const source = join(temporary, 'content/worlds/physics-lab/world.json');
  const authored = JSON.parse(await readFile(source, 'utf8'));
  authored.bounds.min.x = authored.bounds.min.z = -60;
  authored.bounds.max.x = authored.bounds.max.z = 60;
  authored.entities = authored.entities.filter((entity: any) => entity.entityId === 'ground-01');
  authored.entities[0].size.x = authored.entities[0].size.z = 120;
  authored.initialItems = [
    {
      seedId: 'audio-crate',
      typeId: 'wooden-crate',
      position: { x: -3, y: 0.52, z: 2 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
  ];
  await writeFile(source, JSON.stringify(authored));
  await writeFile(
    join(temporary, 'content/worlds/physics-lab/cells/0_0.json'),
    JSON.stringify({ formatVersion: 2, cellId: '0_0', buildings: [], statics: [] }),
  );
  const release = join(temporary, 'release');
  await buildWorld(source, release);
  app = await createGameServer({ port: 0, accounts: fixture, worldDirectory: release });
  fixture.config.publicOrigin = app.url;
  browser = await launchTestBrowser({
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const contexts = await Promise.all(
    [0, 1].map(() => browser!.newContext({ viewport: { width: 1280, height: 900 } })),
  );
  const [owner, observer] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const [index, page] of [owner, observer].entries()) {
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => errors.push(`page ${index}: ${error.message}`));
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/audio/') && !response.ok())
        errors.push(`page ${index}: audio HTTP ${response.status()}`);
    });
    // Both clients need real active AudioContexts while inspecting a shared event. This is
    // browser focus emulation, not a production hook or a replacement of playback counters.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }
  await owner.goto(app.url + '/?diagnostics=1', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await owner.locator('#telegram-login').click();
  await owner.locator('#profile-form').waitFor({ state: 'visible' });
  for (const page of [owner, observer]) {
    await page.goto(app.url + '/?diagnostics=1', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await ready(page);
    await page.locator('#join:not([disabled])').click();
    await playing(page);
    await audible(page);
    await cueCount(page, 'ui:spawn', 1);
  }
  await owner.bringToFront();
  await Promise.all([audible(owner), audible(observer)]);
  await owner.waitForTimeout(600);
  for (const page of [owner, observer]) assert.equal(count(await audio(page), 'ui:spawn'), 1);
  checked('17 assets decode; ordinary join unlocks audio; each local spawn sounds once');

  const beforeHelp = await audio(owner);
  await owner.locator('#help-toggle').click();
  await owner.locator('#help-panel').waitFor({ state: 'visible' });
  await cueCount(owner, 'ui:open', count(beforeHelp, 'ui:open') + 1);
  await owner.waitForTimeout(120);
  await owner.locator('#help-close').click();
  await owner.locator('#help-panel').waitFor({ state: 'hidden' });
  await cueCount(owner, 'ui:close', count(beforeHelp, 'ui:close') + 1);
  await owner.waitForTimeout(200);
  assert.equal(count(await audio(owner), 'ui:open'), count(beforeHelp, 'ui:open') + 1);
  assert.equal(count(await audio(owner), 'ui:close'), count(beforeHelp, 'ui:close') + 1);
  checked('help menu has one sound per actual open and close transition');

  const beforePickup = await Promise.all([audio(owner), audio(observer)]);
  await owner.locator('#world').focus();
  await owner.locator('.su-ctx[aria-keyshortcuts="Z"]:not([hidden])').waitFor();
  await owner.keyboard.press('z');
  await owner.waitForFunction(() => {
    const state = (window as any).__SU_DEBUG__.snapshot();
    return (
      state.items.length === 0 &&
      state.inventory.slots.flatMap((slot: any) => slot.items).length === 1
    );
  });
  await Promise.all([
    cueCount(owner, 'ui:pickup', count(beforePickup[0], 'ui:pickup') + 1),
    cueCount(observer, 'pickup', count(beforePickup[1], 'pickup') + 1),
  ]);
  await owner.waitForTimeout(600);
  assert.equal(count(await audio(owner), 'ui:pickup'), count(beforePickup[0], 'ui:pickup') + 1);
  assert.equal(count(await audio(owner), 'pickup'), count(beforePickup[0], 'pickup'));
  assert.equal(count(await audio(observer), 'pickup'), count(beforePickup[1], 'pickup') + 1);
  checked('confirmed pickup sounds once for its owner and once in the nearby observer world');

  await owner.keyboard.press('x');
  await owner.locator('.inventory-choice').first().click();
  await owner.getByRole('button', { name: 'Разместить в мире', exact: true }).click();
  const confirm = owner.getByRole('button', { name: 'Разместить', exact: true });
  let validPlacement = false;
  for (const y of [420, 400, 440, 460, 480, 500, 380]) {
    for (const x of [580, 600, 620, 660, 680, 700, 540, 740]) {
      await owner.mouse.move(x, y);
      await owner.waitForTimeout(60);
      if (await confirm.isEnabled()) {
        validPlacement = true;
        break;
      }
    }
    if (validPlacement) break;
  }
  assert.ok(validPlacement, 'normal placement preview finds a supported nearby position');
  const beforePlace = await Promise.all([audio(owner), audio(observer)]);
  await confirm.click();
  await owner.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().items.length === 1);
  await Promise.all([
    cueCount(owner, 'place', count(beforePlace[0], 'place') + 1),
    cueCount(observer, 'place', count(beforePlace[1], 'place') + 1),
  ]);
  await owner.waitForTimeout(600);
  assert.equal(count(await audio(owner), 'place'), count(beforePlace[0], 'place') + 1);
  assert.equal(count(await audio(observer), 'place'), count(beforePlace[1], 'place') + 1);
  checked(
    'confirmed placement sounds once on both clients, without a duplicate from state replication',
  );

  await owner.locator('#world').focus();
  const ownerId = (await snapshot(owner)).authoritative.entityId;
  const beforeReaction = await Promise.all([audio(owner), audio(observer)]);
  await owner.keyboard.press('r');
  await owner.locator('.reaction-choice[data-reaction-id="hello"]:not([disabled])').click();
  await Promise.all([
    cueCount(owner, 'reaction', count(beforeReaction[0], 'reaction') + 1),
    cueCount(observer, 'reaction', count(beforeReaction[1], 'reaction') + 1),
  ]);
  await observer
    .locator(`.player-reaction[data-entity-id="${ownerId}"][data-reaction-id="hello"]`)
    .waitFor();
  await owner.waitForTimeout(900);
  assert.equal(count(await audio(owner), 'reaction'), count(beforeReaction[0], 'reaction') + 1);
  assert.equal(count(await audio(observer), 'reaction'), count(beforeReaction[1], 'reaction') + 1);
  checked('a new reaction sounds once on both clients; later replicated frames do not replay it');

  await observer.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await playing(observer);
  await ready(observer);
  await observer.locator('#world').click();
  await audible(observer);
  await observer
    .locator(`.player-reaction[data-entity-id="${ownerId}"][data-reaction-id="hello"]`)
    .waitFor();
  await observer.waitForTimeout(500);
  assert.equal((await audio(observer)).settings.muted, false);
  assert.equal(count(await audio(observer), 'ui:spawn'), 0);
  assert.equal(count(await audio(observer), 'reaction'), 0);
  await owner.bringToFront();
  await audible(owner);
  checked('an unmuted reconnect restores the existing sticker without a spawn or reaction replay');

  const beforeWalk = await Promise.all([audio(owner), audio(observer)]);
  await owner.locator('#world').focus();
  await owner.keyboard.down('a');
  try {
    await owner.waitForFunction(
      (before) => ((window as any).__SU_DEBUG__.audio().played.step ?? 0) >= before + 3,
      count(beforeWalk[0], 'step'),
    );
  } finally {
    await owner.keyboard.up('a');
  }
  await settle(owner);
  assert.ok(count(await audio(observer), 'step') > count(beforeWalk[1], 'step'));
  const idleCounts = await Promise.all([audio(owner), audio(observer)]);
  await owner.waitForTimeout(700);
  for (const [index, page] of [owner, observer].entries())
    assert.equal(count(await audio(page), 'step'), count(idleCounts[index], 'step'));
  checked(
    'grounded walking produces own and nearby footsteps; stopping leaves both clients silent',
  );

  // At alpha=PI/4, W+A travels along negative world X into this fixture's open ground.
  const observerPosition = (await snapshot(observer)).authoritative.position;
  const beforeRun = count(await audio(owner), 'run');
  await owner.keyboard.down('Shift');
  await owner.keyboard.down('a');
  await owner.keyboard.down('w');
  try {
    await owner.waitForFunction((origin) => {
      const state = (window as any).__SU_DEBUG__.snapshot();
      const position = state.authoritative.position;
      return Math.hypot(position.x - origin.x, position.z - origin.z) > 36;
    }, observerPosition);
  } finally {
    await owner.keyboard.up('w');
    await owner.keyboard.up('a');
    await owner.keyboard.up('Shift');
  }
  await settle(owner);
  assert.ok(count(await audio(owner), 'run') > beforeRun);
  const farBefore = await Promise.all([audio(owner), audio(observer)]);
  await owner.keyboard.down('Shift');
  await owner.keyboard.down('a');
  await owner.keyboard.down('w');
  try {
    await owner.waitForFunction(
      (before) => ((window as any).__SU_DEBUG__.audio().played.run ?? 0) >= before + 3,
      count(farBefore[0], 'run'),
    );
  } finally {
    await owner.keyboard.up('w');
    await owner.keyboard.up('a');
    await owner.keyboard.up('Shift');
  }
  await settle(owner);
  await audible(observer);
  const farAfter = await audio(observer);
  assert.equal(count(farAfter, 'run'), count(farBefore[1], 'run'));
  assert.equal(count(farAfter, 'step'), count(farBefore[1], 'step'));
  assert.ok(
    farAfter.dropped > farBefore[1].dropped,
    'far events are culled while observer audio stays active',
  );
  const beforeFarReaction = await Promise.all([audio(owner), audio(observer)]);
  await owner.keyboard.press('r');
  await owner.locator('.reaction-choice[data-reaction-id="like"]:not([disabled])').click();
  await cueCount(owner, 'reaction', count(beforeFarReaction[0], 'reaction') + 1);
  await observer
    .locator(`.player-reaction[data-entity-id="${ownerId}"][data-reaction-id="like"]`)
    .waitFor({ state: 'attached' });
  await owner.waitForTimeout(400);
  assert.equal(count(await audio(observer), 'reaction'), count(beforeFarReaction[1], 'reaction'));
  checked(
    'running sounds locally; beyond the audible radius the active observer hears neither running nor a fresh reaction',
  );

  await owner.locator('#help-toggle').click();
  await owner.locator('.audio-settings > summary').click();
  await owner.screenshot({ path: `${output}/settings-open.png` });
  await owner.locator('#audio-toggle').click();
  assert.equal((await audio(owner)).settings.muted, true);
  const mutedBefore = total(await audio(owner));
  await owner.locator('#help-close').click();
  await owner.locator('#world').focus();
  await owner.keyboard.down('d');
  await owner.waitForTimeout(750);
  await owner.keyboard.up('d');
  await settle(owner);
  assert.equal(total(await audio(owner)), mutedBefore, 'muted gameplay never starts voices');
  await owner.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await playing(owner);
  await ready(owner);
  assert.equal((await audio(owner)).settings.muted, true, 'mute survives a real page reload');
  await owner.locator('#world').click();
  await owner.keyboard.down('d');
  await owner.waitForTimeout(750);
  await owner.keyboard.up('d');
  await settle(owner);
  const mutedAfterReload = await audio(owner);
  assert.equal(total(mutedAfterReload), 0, 'reconnection and subsequent movement stay muted');
  assert.equal(mutedAfterReload.activeWorldVoices, 0);
  assert.equal(mutedAfterReload.activeUiVoices, 0);
  checked(
    'mute stops playback, persists across reload, and suppresses reconnect and movement cues',
  );

  assert.deepEqual(errors, []);
  const finalAudio = await Promise.all([audio(owner), audio(observer)]);
  for (const state of finalAudio) {
    assert.equal(state.errors, 0);
    assert.equal(state.failedAssets, 0);
  }
  await owner.screenshot({ path: `${output}/muted-after-reload.png` });
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      { result: 'passed', browser: browser.version(), checks, audio: finalAudio },
      null,
      2,
    ),
  );
  console.log(`Audio browser regression passed (${checks.length} checks).`);
} finally {
  await browser?.close();
  await app?.close();
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
