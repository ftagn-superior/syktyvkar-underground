import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';
import { Client } from '@colyseus/sdk';
import type { Page } from 'playwright';
import { prepareAnimationRigFixture } from './helpers/animation-rig-fixture';
import { launchTestBrowser } from './helpers/browser';
import { createDelayRelay } from './helpers/tcp-delay';
import { hudClick } from './helpers/hud';
import {
  AVATAR_SKINS,
  ANIMATIONS,
  ANIMATION_CATALOG_VERSION,
  type WorldInfo,
} from '../packages/contracts/src';
import { rigDefinitions, rigClips } from './fixtures/animation-rig';
import { restingPose } from '../apps/client/src/rendering/avatars/locomotion';

assert.ok(process.env.SU_TEST_DATABASE_URL, 'Use a dedicated SU_TEST_DATABASE_URL');
const fixture = await prepareAnimationRigFixture();
process.chdir(fixture.root);
const { createGameServer } = await import(
  pathToFileURL(join(fixture.root, 'tests/helpers/game-server.ts')).href
);
const app = await createGameServer({ port: 0 });
const relay = await createDelayRelay(new URL(app.url), {
  name: 'rig-observer',
  rttMs: 100,
  jitterMs: 20,
});
const galleryHTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#101820;color:#fff;font:20px sans-serif">
<canvas style="display:block;width:1600px;height:2400px"></canvas>
<div style="position:absolute;inset:10px 0 auto 0;display:flex;justify-content:space-around;font-weight:bold"><span>Сидение</span><span>Лежание</span><span>На боку</span><span>Колесо на месте</span></div>
<div id="motion" style="position:absolute;top:42px;left:25px;color:#bacbd6"></div>
<div style="position:absolute;left:10px;top:95px;height:2260px;display:grid;grid-template-rows:repeat(8,1fr);align-items:center">${AVATAR_SKINS.map((s) => `<span style="max-width:135px">${s.label}</span>`).join('')}</div>
<div style="position:absolute;left:400px;top:2220px;width:1200px;display:flex;justify-content:space-around;color:#f2b8a2"><span>Недоступно в коляске</span><span>Недоступно в коляске</span><span>Недоступно в коляске</span></div>
<script type="module" src="/tests/helpers/animation-rig-gallery.ts"></script></body></html>`;
const gallery = await createServer({
  root: fixture.root,
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'rig-gallery',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] !== '/rig-gallery') return next();
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(galleryHTML);
        });
      },
    },
  ],
});
await gallery.listen();
const galleryURL = gallery.resolvedUrls!.local[0] + 'rig-gallery';
const browser = await launchTestBrowser();
const errors: string[] = [],
  checks: string[] = [];
const matrix: unknown[] = [];
const snap = (page: Page) => page.evaluate(() => (window as any).__SU_DEBUG__.snapshot());
const avatar = (page: Page, entity: string) =>
  page.evaluate(
    (id) => (window as any).__SU_DEBUG__.avatars().find((a: any) => a.entityId === id),
    entity,
  );
async function idle(page: Page) {
  await page.waitForFunction(
    () => {
      const s = (window as any).__SU_DEBUG__.snapshot().animation;
      return !s.busy && !s.pending && !s.moving && s.grounded;
    },
    undefined,
    { timeout: 35000 },
  );
}
async function choose(page: Page, id: string) {
  await idle(page);
  await hudClick(page, '#animations-toggle');
  await page.locator(`[data-animation-id="${id}"]:not([disabled])`).click();
}
async function active(page: Page, entity: string, id: string) {
  await page.waitForFunction(
    ({ entity, id }) => {
      const a = (window as any).__SU_DEBUG__.avatars().find((a: any) => a.entityId === entity);
      return (
        a?.animation.reason === 'playing' && a.animation.id === id && a.animation.weight > 0.99
      );
    },
    { entity, id },
  );
}
try {
  const info: WorldInfo = await fetch(app.url + '/api/world').then((r) => r.json());
  assert.deepEqual(Object.keys(info.catalogVersions!).sort(), ['animations', 'reactions']);
  await assert.rejects(
    new Client(app.url).joinById(info.roomId, {
      ...info,
      catalogVersions: { ...info.catalogVersions, animations: ANIMATION_CATALOG_VERSION },
    }),
    /VERSION_MISMATCH/,
  );
  checks.push(
    'same-protocol client with the pre-fixture catalog is rejected; reactions and animations both remain mandatory',
  );
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })),
  );
  const pages: Page[] = [];
  for (const [index, context] of contexts.entries()) {
    await context.addInitScript(() => localStorage.setItem('su:render-quality:v1', 'economy'));
    const page = await context.newPage();
    pages.push(page);
    page.setDefaultTimeout(25000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto((index ? relay.url : app.url) + '/?diagnostics=1', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.locator('#join:not([disabled])').waitFor({ timeout: 60000 });
    await page
      .locator(`input[name="avatar-skin"][value="${index ? 'standard' : 'minifigure'}"]`)
      .check();
    await page.locator('#join').click();
    await page.waitForFunction(
      () => (window as any).__SU_DEBUG__?.snapshot().connection === 'playing',
    );
  }
  const [sender, observer] = pages;
  const id = (await snap(sender)).authoritative.entityId;
  const player = () =>
    [...app.room.state.players.values()].find((p: any) => p.entityId === id) as any;
  const initial = (await snap(sender)).authoritative;
  for (const skin of AVATAR_SKINS) {
    player().skinId = skin.id;
    for (const page of pages)
      await page.waitForFunction(
        ({ id, skin }) =>
          (window as any).__SU_DEBUG__
            .avatars()
            .some((a: any) => a.entityId === id && a.skinId === skin),
        { id, skin: skin.id },
      );
    for (const definition of rigDefinitions) {
      if (skin.id === 'bear-wheelchair' && definition.id !== 'rig-sit') {
        await idle(sender);
        await hudClick(sender, '#animations-toggle');
        assert.equal(
          await sender.locator(`[data-animation-id="${definition.id}"]`).isDisabled(),
          true,
        );
        await sender.keyboard.press('Escape');
        continue;
      }
      await choose(sender, definition.id);
      await Promise.all(pages.map((page) => active(page, id, definition.id)));
      for (const reduced of [false, true]) {
        for (const page of pages)
          await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
        // Sample an actual rendered frame after the media event on both independent clients.
        for (const page of pages) {
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
          const actual = await avatar(page, id);
          const clip = rigClips[definition.id as keyof typeof rigClips];
          const sampler = skin.id === 'bear-wheelchair' ? clip.seated! : clip;
          const expected = restingPose();
          sampler.sample(expected, actual.animation.elapsedMs, reduced);
          for (const channel of sampler.mask) {
            const error =
              channel === 'rootPitch' || channel === 'rootYaw' || channel === 'rootRoll'
                ? Math.abs(
                    Math.atan2(
                      Math.sin(actual.pose[channel] - expected[channel]),
                      Math.cos(actual.pose[channel] - expected[channel]),
                    ),
                  )
                : Math.abs(actual.pose[channel] - expected[channel]);
            assert.ok(error < 0.001, `${skin.id}/${definition.id}/${channel}/${reduced}: ${error}`);
          }
          if (skin.id !== 'bear-wheelchair')
            assert.ok(
              actual.rig.bounds.min.y >= -0.01 && actual.rig.bounds.min.y <= 0.05,
              `support ${actual.rig.bounds.min.y}`,
            );
          matrix.push({
            skin: skin.id,
            clip: definition.id,
            reduced,
            client: page === sender ? 'own' : 'observer',
            elapsedMs: actual.animation.elapsedMs,
            pose: actual.pose,
            bounds: actual.rig.bounds,
          });
        }
      }
      const after = (await snap(sender)).authoritative;
      assert.ok(
        Math.hypot(after.position.x - initial.position.x, after.position.z - initial.position.z) <
          0.02,
      );
      assert.deepEqual(after.rotation, initial.rotation);
      if (skin.id === 'minifigure')
        await observer.screenshot({ path: join(fixture.output, `network-${definition.id}.png`) });
    }
    console.log(`Verified network poses: ${skin.id}`);
  }
  checks.push(
    'all 29 supported clip/skin pairs render their declared joints and contact on own client and independent 100ms/jitter observer, with both motion settings; wheelchair rejects the other three choices',
  );
  const propIds = ['smoke-cigarette', 'drink-beer', 'use-laptop'].filter((id) =>
    ANIMATIONS.some((a) => a.id === id),
  );
  if (propIds.length) {
    assert.equal(propIds.length, 3, 'S-34 integration keeps all three prepared actions');
    for (const skin of ['minifigure', 'bear-wheelchair']) {
      player().skinId = skin;
      for (const page of pages)
        await page.waitForFunction(
          ({ id, skin }) =>
            (window as any).__SU_DEBUG__
              .avatars()
              .some((a: any) => a.entityId === id && a.skinId === skin),
          { id, skin },
        );
      for (const propId of propIds) {
        await choose(sender, propId);
        await Promise.all(pages.map((page) => active(page, id, propId)));
        for (const page of pages)
          assert.ok(
            (await avatar(page, id)).prop?.opacity > 0.99,
            `${skin}/${propId} prop survives v2 integration`,
          );
      }
      await choose(sender, 'rig-sit');
      await Promise.all(pages.map((page) => active(page, id, 'rig-sit')));
      for (const page of pages)
        assert.equal(
          (await avatar(page, id)).prop,
          undefined,
          'ground replacement releases the cosmetic prop',
        );
    }
    checks.push(
      'S-34 cigarette/beer/laptop remain visible on performer and observer after v2 playback, including wheelchair; replacement releases their props',
    );
  }
  player().skinId = 'minifigure';
  for (const page of pages) await page.emulateMedia({ reducedMotion: 'no-preference' });
  await choose(sender, 'rig-lie');
  await active(sender, id, 'rig-lie');
  await choose(sender, 'wave');
  await active(sender, id, 'wave');
  await sender.waitForFunction((id) => {
    const a = (window as any).__SU_DEBUG__.avatars().find((a: any) => a.entityId === id);
    return a.supportWeight === 0 && a.pose.rootPitch === 0 && a.pose.leftKnee === 0;
  }, id);
  await choose(sender, 'rig-sit');
  await active(sender, id, 'rig-sit');
  await sender.locator('#world').focus();
  await sender.keyboard.down('s');
  try {
    await sender.waitForFunction(
      (id) =>
        (window as any).__SU_DEBUG__.avatars().find((a: any) => a.entityId === id).animation
          .reason !== 'playing',
      id,
    );
  } finally {
    await sender.keyboard.up('s');
  }
  for (const page of pages)
    await page.waitForFunction((id) => {
      const a = (window as any).__SU_DEBUG__.avatars().find((a: any) => a.entityId === id);
      return a.supportWeight === 0 && a.pose.rootPitch === 0;
    }, id);
  checks.push(
    'idle replacement restores v1 joints/root; actual movement cancels ground on both clients without the old five-second slide',
  );
  // Test harness moves the real capsule to a legal stand near the wall; the request still uses the public UI/server path.
  const physical = (app.room as any).world;
  assert.equal(physical.respawnPlayerAtPosition(id, { x: 4, y: 0.915, z: -3.8 }), true);
  await sender.waitForFunction(() => {
    const s = (window as any).__SU_DEBUG__.snapshot();
    return s.authoritative.position.z < -3.5 && s.animation.grounded;
  });
  assert.equal(
    physical.checkAnimationSpace(id),
    false,
    'standable place beside passage-left is too narrow for a ground pose',
  );
  await choose(sender, 'rig-lie');
  await sender.waitForFunction(() =>
    (window as any).__SU_DEBUG__.snapshot().animation.message.includes('свободное ровное место'),
  );
  assert.equal(player().animationId, '');
  assert.equal(physical.respawnPlayerAtPosition(id, initial.position), true);
  await sender.waitForFunction(
    (position) =>
      Math.hypot(
        (window as any).__SU_DEBUG__.snapshot().authoritative.position.x - position.x,
        (window as any).__SU_DEBUG__.snapshot().authoritative.position.z - position.z,
      ) < 0.1,
    initial.position,
  );
  await choose(sender, 'rig-cartwheel');
  await active(sender, id, 'rig-cartwheel');
  player().skinId = 'bear-wheelchair';
  await sender.waitForFunction((id) => {
    const a = (window as any).__SU_DEBUG__.avatars().find((a: any) => a.entityId === id);
    return (
      a.skinId === 'bear-wheelchair' && a.animation.reason !== 'playing' && a.supportWeight === 0
    );
  }, id);
  checks.push(
    'wall clearance is enforced by physics with a user-facing reason; a live switch to wheelchair cancels an unsupported cartwheel',
  );
  player().skinId = 'minifigure';
  await choose(sender, 'rig-side');
  await active(sender, id, 'rig-side');
  await contexts[0].setOffline(true);
  await sender.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'reconnecting',
  );
  await contexts[0].setOffline(false);
  await sender.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  await idle(sender);
  assert.equal(player().animationId, '');
  checks.push('performer reconnect restores an ordinary upright pose without replay');
  await hudClick(sender, '#animations-toggle');
  await sender.locator('#animation-preview summary').click();
  const sequence = player().animationSequence;
  for (const skin of AVATAR_SKINS)
    for (const definition of rigDefinitions) {
      await sender.locator('#animation-preview-skin').selectOption(skin.id);
      await sender.locator('#animation-preview-clip').selectOption(definition.id);
      if (skin.id === 'bear-wheelchair' && definition.id !== 'rig-sit') {
        assert.equal(await sender.locator('#animation-preview-canvas').isHidden(), true);
        assert.match(await sender.locator('#animation-preview-note').innerText(), /недоступно/);
      } else assert.equal(await sender.locator('#animation-preview-canvas').isVisible(), true);
    }
  await sender.locator('#animation-preview-skin').selectOption('minifigure');
  await sender.locator('#animation-preview-clip').selectOption('rig-cartwheel');
  await sender.locator('#animation-preview-reduced').check();
  assert.match(await sender.locator('#animation-preview-note').innerText(), /подготовка к колесу/);
  assert.equal(player().animationSequence, sequence);
  checks.push(
    'real menu preview covers the skin/clip matrix, explains seated/unavailable/static alternatives and sends no action',
  );
  const galleryPage = await browser.newPage({ viewport: { width: 1600, height: 2400 } });
  galleryPage.on('pageerror', (error) => errors.push(error.message));
  await galleryPage.goto(galleryURL);
  await galleryPage.waitForFunction(() => (window as any).rigGalleryReady);
  for (const [name, ms, reduced] of [
    ['matrix-normal', 3000, false],
    ['matrix-reduced', 3000, true],
    ['matrix-cartwheel-quarter', 1500, false],
  ] as const) {
    await galleryPage.evaluate(({ ms, reduced }) => (window as any).rigGalleryPose(ms, reduced), {
      ms,
      reduced,
    });
    await galleryPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await galleryPage.screenshot({ path: join(fixture.output, name + '.png') });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    browser: browser.version(),
    result: 'passed',
    checks,
    matrix,
    relay: relay.metrics(),
    errors,
    limitations: [
      'Chromium/Linux/SwiftShader only; no mobile, gamepad or hardware-GPU acceptance',
      'ground support is conservative and static; upright collision capsule, no slope IK or cloth physics',
    ],
  };
  await writeFile(join(fixture.output, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        result: report.result,
        checks,
        samples: matrix.length,
        galleryURL,
        appURL: app.url,
        output: fixture.output,
      },
      null,
      2,
    ),
  );
  if (process.argv.includes('--interactive-review')) {
    console.log(
      'INTERACTIVE_REVIEW_READY: press Enter to close local servers and remove the source fixture.',
    );
    await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  }
} finally {
  await browser.close();
  await gallery.close();
  await relay.close();
  await app.close();
  process.chdir(fixture.original);
  await rm(fixture.root, { recursive: true, force: true });
}
