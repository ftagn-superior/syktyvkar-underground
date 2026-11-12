import { launchTestBrowser } from './helpers/browser.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createGameServer } from '../apps/server/src/index.js';

// This proxy can corrupt a real immutable response while preserving its cache headers.
// Browser routing disables HTTP caching, so route.fulfill cannot cover this regression.
const app = await createGameServer({ port: 0 });
const info = await fetch(`${app.url}/api/world`).then((response) => response.json());
const manifest = await fetch(app.url + info.manifestUrl).then((response) => response.json());
const modelFile = (Object.values(manifest.assets)[0] as { modelFile: string }).modelFile;
const modelPath = `/worlds/physics-lab/${modelFile}`;
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
  const targetModel = incoming.url === modelPath;
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
  }, modelPath);
  assert.notEqual(seed.hash, manifest.files[modelFile], 'fixture must seed corrupted bytes');
  assert.ok(seed.cache?.includes('immutable'));
  assert.equal(assetRequests, 1);
  corrupt = false;
  await page.goto(url + '/?diagnostics=1');
  await page.waitForFunction(() => (window as any).__SU_DEBUG__?.snapshot().connection === 'ready');
  assert.equal(assetRequests, 1, 'models wait for the server preparation plan');
  assert.equal(matchmakingRequests, 0, 'the header alone cannot reserve a guest seat');
  assert.equal(await page.locator('#join-label').textContent(), 'Войти');
  await page.locator('#join').click();
  await page.waitForFunction(
    () => (window as any).__SU_DEBUG__.snapshot().connection === 'playing',
  );
  assert.equal(assetRequests, 2, 'cached corruption is replaced by one network reload');
  await page.locator('#leave').click();
  await page.waitForFunction(() => (window as any).__SU_DEBUG__.snapshot().connection === 'ready');
  await context.close();

  // Models are verified after the server reserves a preparation seat; no character exists until ready.
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
  await broken.locator('#join').click();
  await broken.waitForFunction(() => !!(window as any).__SU_DEBUG__?.snapshot().areaProblem);
  assert.equal(assetRequests - beforeRequests, 2, 'permanent damage receives only one retry');
  assert.ok(matchmakingRequests > beforeMatchmaking);
  assert.equal(app.room.state.players.size, 0);
  await broken.locator('#area-retry').waitFor();
  await broken.waitForFunction(
    () => document.querySelector('#area-retry')?.textContent === 'Обновить страницу',
  );
  await Promise.all([broken.waitForEvent('load'), broken.locator('#area-retry').click()]);
  await broken.waitForFunction(
    () => (window as any).__SU_DEBUG__?.snapshot().connection === 'ready',
  );
  await broken.locator('#join').click();
  await broken.waitForFunction(() => !!(window as any).__SU_DEBUG__?.snapshot().areaProblem);
  assert.equal(
    app.room.state.players.size,
    0,
    'a corrupt model never activates a character after reload',
  );
  assert.deepEqual(errors, []);
  const result = {
    date: new Date().toISOString(),
    browser: browser.version(),
    result: 'passed',
    checks: [
      'A corrupt immutable HTTP cache entry is replaced by one verified network retry.',
      'The recovered world can enter and leave a real multiplayer session.',
      'Persistent GLB corruption keeps the reserved seat in preparation without spawning, including after reload.',
    ],
    browserErrors: errors,
  };
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/assets.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  await brokenContext.close();
} finally {
  await browser?.close();
  for (const tunnel of tunnels) tunnel.destroy();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await app.close();
}
