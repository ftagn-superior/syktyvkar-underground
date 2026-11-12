import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createGameServer } from './helpers/game-server.js';
import { build } from 'esbuild';
import type { WorldManifest } from '../packages/contracts/src/index.js';
import { hudClick } from './helpers/hud.js';

// This proxy can corrupt a real immutable response while preserving its cache headers.
// Browser routing disables HTTP caching, so route.fulfill cannot cover this regression.
const app = await createGameServer({ port: 0 });
const info = await fetch(`${app.url}/api/world`).then((response) => response.json());
const manifest: WorldManifest = await fetch(app.url + info.manifestUrl).then((response) =>
  response.json(),
);
const modelFile = Object.values(manifest.assets)[0].modelFile;
const packFile = manifest.cells.flatMap((cell) => cell.graphicsPacks ?? [])[0];
assert.ok(packFile, 'Current publisher must provide an actual graphics pack for this test');
let targetPath = `/worlds/physics-lab/${packFile}`;
// A tiny browser fixture exercises the actual legacy resource loader independently
// of the production manifest identity and multiplayer handshake.
const legacyLoader = await build({
  stdin: {
    contents: "export { VerifiedResources } from './apps/client/src/streaming/resources.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
let corrupt = true;
let assetRequests = 0;
let matchmakingRequests = 0;
const tunnels = new Set<Socket>();
const proxy = createServer((incoming, outgoing) => {
  if (incoming.url === '/cache-fixture') {
    outgoing.setHeader('content-type', 'text/html');
    outgoing.end(
      '<!doctype html><title>Asset cache fixture</title><body>Asset cache fixture</body>',
    );
    return;
  }
  if (incoming.url === '/resource-loader-fixture.js') {
    outgoing.setHeader('content-type', 'text/javascript');
    outgoing.end(legacyLoader.outputFiles[0].text);
    return;
  }
  const targetModel = incoming.url === targetPath;
  if (targetModel) assetRequests++;
  if (incoming.url?.startsWith('/matchmake/')) matchmakingRequests++;
  const upstream = request(
    app.url + incoming.url,
    { method: incoming.method, headers: incoming.headers },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      if (targetModel && corrupt && response.statusCode === 200) {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          bytes[bytes.length - 1] ^= 1;
          outgoing.end(bytes);
        });
      } else response.pipe(outgoing);
    },
  );
  upstream.on('error', (error) => outgoing.destroy(error));
  incoming.pipe(upstream);
});
proxy.on('upgrade', (incoming, socket, head) => {
  const upstream = connect(Number(new URL(app.url).port), '127.0.0.1');
  tunnels.add(upstream);
  upstream.once('close', () => tunnels.delete(upstream));
  upstream.once('connect', () => {
    const headers = incoming.rawHeaders.reduce(
      (text, value, index, entries) =>
        index % 2 === 0 ? `${text}${value}: ${entries[index + 1]}\r\n` : text,
      '',
    );
    upstream.write(
      `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${headers}\r\n`,
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', () => {
      proxy.off('error', reject);
      resolve();
    });
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  browser = await launchTestBrowser();
  const errors: string[] = [];
  const context = await browser.newContext({ viewport: { width: 960, height: 640 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`cache recovery: ${error.stack ?? error.message}`));
  await page.goto(url + '/cache-fixture');
  const seed = await page.evaluate(async (path) => {
    const response = await fetch(path, { cache: 'force-cache' });
    const bytes = await response.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    return { hash, cache: response.headers.get('cache-control') };
  }, targetPath);
  assert.notEqual(seed.hash, manifest.files[packFile], 'fixture must seed corrupted bytes');
  assert.ok(seed.cache?.includes('immutable'));
  assert.equal(assetRequests, 1);
  corrupt = false;
  await page.goto(url + '/?diagnostics=1');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__?.snapshot().connection === 'ready');
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().streaming?.backgroundReady,
  );
  assert.equal(
    assetRequests,
    2,
    'static preview replaces corrupt cached bytes with one verified network reload',
  );
  assert.equal(matchmakingRequests, 0, 'the header alone cannot reserve a guest seat');
  assert.equal(await page.locator('#join-label').textContent(), 'Войти в мир');
  await page.locator('#join').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  assert.equal(assetRequests, 2, 'cached corruption is replaced by one network reload');
  await hudClick(page, '#leave');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().connection === 'ready');
  await context.close();

  // Static preview verifies models without a reserved seat; persistent damage never creates a character.
  corrupt = true;
  const beforeRequests = assetRequests;
  const beforeMatchmaking = matchmakingRequests;
  const brokenContext = await browser.newContext({ viewport: { width: 960, height: 640 } });
  const broken = await brokenContext.newPage();
  broken.on('pageerror', (error) =>
    errors.push(`permanent corruption: ${error.stack ?? error.message}`),
  );
  await broken.goto(url + '/?diagnostics=1');
  await broken.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'ready',
  );
  assert.equal(matchmakingRequests, beforeMatchmaking);
  await broken.waitForFunction(() => !!(window as any).__SU_DEBUG__?.snapshot().areaProblem);
  assert.equal(assetRequests - beforeRequests, 2, 'permanent damage receives only one retry');
  assert.equal(matchmakingRequests, beforeMatchmaking);
  assert.equal(app.room.diagnostics().sessions, 0);
  assert.equal(app.room.state.players.size, 0);
  await broken.locator('#area-retry').waitFor();
  await broken.waitForFunction(
    () => document.querySelector('#area-retry')?.textContent === 'Обновить страницу',
  );
  await Promise.all([broken.waitForEvent('load'), broken.locator('#area-retry').click()]);
  await broken.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'ready',
  );
  await broken.waitForFunction(() => !!(window as any).__SU_DEBUG__?.snapshot().areaProblem);
  assert.equal(
    app.room.state.players.size,
    0,
    'a corrupt graphics pack never activates a character after reload',
  );
  await brokenContext.close();

  // Legacy manifests still use independently hashed GLB files. The same actual
  // browser HTTP cache must recover once, and reject permanently damaged bytes.
  targetPath = `/worlds/physics-lab/${modelFile}`;
  const legacyManifest = {
    ...manifest,
    cells: manifest.cells.map(({ graphicsPacks: _packs, ...cell }) => cell),
  };
  const legacyContext = await browser.newContext();
  const legacy = await legacyContext.newPage();
  legacy.on('pageerror', (error) => errors.push(`legacy resources: ${error.message}`));
  await legacy.goto(url + '/cache-fixture');
  const beforeLegacy = assetRequests;
  await legacy.evaluate(async (path) => {
    await (await fetch(path, { cache: 'force-cache' })).arrayBuffer();
  }, targetPath);
  assert.equal(assetRequests, beforeLegacy + 1);
  corrupt = false;
  const verifyLegacy = async (target: typeof legacy) =>
    target.evaluate(
      async ({ manifest, modelFile }) => {
        const moduleUrl = '/resource-loader-fixture.js';
        const { VerifiedResources } = await import(moduleUrl);
        const resources = new VerifiedResources(manifest, '/worlds/physics-lab/');
        try {
          await resources.prefetchGraphics(manifest.cells[0].cellId);
          const bytes = await resources.read(modelFile);
          return { ok: true, bytes: bytes.byteLength, diagnostics: resources.diagnostics() };
        } catch (error) {
          return { ok: false, error: String(error), diagnostics: resources.diagnostics() };
        } finally {
          resources.dispose();
        }
      },
      { manifest: legacyManifest, modelFile },
    );
  const legacyRecovery = await verifyLegacy(legacy);
  assert.equal(legacyRecovery.ok, true);
  assert.equal(legacyRecovery.diagnostics.integrityRetries, 1);
  assert.equal(
    assetRequests,
    beforeLegacy + 2,
    'legacy cached GLB is replaced by one network reload',
  );
  await legacyContext.close();
  corrupt = true;
  const brokenLegacyContext = await browser.newContext();
  const brokenLegacy = await brokenLegacyContext.newPage();
  brokenLegacy.on('pageerror', (error) => errors.push(`legacy permanent damage: ${error.message}`));
  await brokenLegacy.goto(url + '/cache-fixture');
  const beforeBrokenLegacy = assetRequests;
  const legacyFailure = await verifyLegacy(brokenLegacy);
  assert.equal(legacyFailure.ok, false);
  assert.match(legacyFailure.error ?? '', /SHA-256 mismatch/);
  assert.equal(legacyFailure.diagnostics.integrityRetries, 1);
  assert.equal(legacyFailure.diagnostics.cacheBytes, 0);
  assert.equal(assetRequests, beforeBrokenLegacy + 2, 'legacy permanent damage receives one retry');
  await brokenLegacyContext.close();
  assert.deepEqual(errors, []);
  const result = {
    date: new Date().toISOString(),
    browser: browser.version(),
    result: 'passed',
    checks: [
      'A corrupt immutable graphics pack in the HTTP cache is replaced by one verified network retry.',
      'The recovered world can enter and leave a real multiplayer session.',
      'Persistent graphics pack corruption leaves static preview without reserving a seat or spawning, including after reload.',
      'Legacy individual GLB files recover from cached corruption with one reload and reject persistent corruption with one retry.',
    ],
    legacy: { recovered: legacyRecovery.ok, rejectedPermanentDamage: !legacyFailure.ok },
    browserErrors: errors,
  };
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/assets.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  for (const tunnel of tunnels) tunnel.destroy();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await app.close();
}
