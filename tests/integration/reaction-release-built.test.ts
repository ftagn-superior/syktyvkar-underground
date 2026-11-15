import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@colyseus/sdk';
import { createDatabaseFixture } from '../helpers/database-fixture.js';

// Настоящий dist/server, отдельная SQL-схема и копия выпуска: исходный dist не меняем.
describe.skipIf(!process.env.SU_TEST_DATABASE_URL)('built reaction release', () => {
  let directory: string,
    database: Awaited<ReturnType<typeof createDatabaseFixture>>,
    databaseUrl: string;
  let child: ChildProcess | undefined;
  let logs = '';
  let exit: Promise<number | null>;
  beforeAll(async () => {
    database = await createDatabaseFixture();
    const url = new URL(process.env.SU_TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    databaseUrl = url.href;
    directory = await mkdtemp(join(tmpdir(), 'su-built-reactions-'));
    for (const path of [
      'dist/worlds/physics-lab',
      'dist/model-catalogs/physics-lab',
      'dist/client/reactions',
    ]) {
      await mkdir(join(directory, path, '..'), { recursive: true });
      await cp(path, join(directory, path), { recursive: true });
    }
    await cp(
      'dist/client/reaction-release.json',
      join(directory, 'dist/client/reaction-release.json'),
    );
  });
  afterAll(async () => {
    await stop();
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function start(): Promise<string> {
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
    const address = listener.address() as { port: number };
    await new Promise<void>((done) => listener.close(() => done()));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SU_WORLD: 'physics-lab',
      PORT: String(address.port),
      HOST: '127.0.0.1',
    };
    delete env.PUBLIC_ORIGIN;
    delete env.CLIENT_ID;
    delete env.CLIENT_SECRET;
    logs = '';
    child = spawn(process.execPath, [resolve('dist/server/main.mjs')], {
      cwd: directory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk) => {
      logs += chunk.toString();
    });
    child.stderr!.on('data', (chunk) => {
      logs += chunk.toString();
    });
    exit = new Promise((done, reject) => {
      child!.once('close', done);
      child!.once('error', reject);
    });
    return `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopping = child;
    stopping.kill('SIGTERM');
    const fallback = setTimeout(() => stopping.kill('SIGKILL'), 10000);
    try {
      await exit;
    } finally {
      clearTimeout(fallback);
      child = undefined;
    }
  }
  async function ready(url: string) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (child?.exitCode !== null) throw new Error(logs);
      try {
        if ((await fetch(`${url}/health/ready`)).ok) return;
      } catch {
        /* ещё запускается */
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`Built server readiness timeout: ${logs}`);
  }
  it('accepts a coherent build, rejects a stale JOIN and refuses stale manifests/assets on restart', async () => {
    const manifestPath = join(directory, 'dist/client/reaction-release.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 'old-client' }));
    await start();
    expect(await exit).toBe(1);
    expect(logs).toContain('reaction-release.json');
    expect(logs).toContain('Выпустите клиент и сервер вместе');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const url = await start();
    await ready(url);
    const info = await (await fetch(`${url}/api/world`)).json();
    expect(info.catalogVersions.reactions).toBe(manifest.version);
    expect(Object.keys(info.catalogVersions).sort()).toEqual(['animations', 'reactions']);
    const sdk = new Client(url);
    for (const key of ['reactions', 'animations']) {
      for (const missing of [false, true]) {
        const catalogVersions = { ...info.catalogVersions, [key]: 'old-client' };
        if (missing) delete catalogVersions[key];
        await expect(sdk.joinById(info.roomId, { ...info, catalogVersions })).rejects.toThrow(
          'VERSION_MISMATCH',
        );
      }
    }
    const room = await sdk.joinById(info.roomId, info);
    await room.leave();
    const assetPath = join(directory, 'dist/client/reactions/hello.svg');
    const original = await readFile(assetPath, 'utf8');
    await writeFile(assetPath, original + '\n');
    const response = await fetch(`${url}/reactions/hello.svg?v=${manifest.version}`);
    expect(await response.text()).toBe(original);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${url}/reactions/hello.svg?v=old-client`)).status).toBe(410);
    await stop();
    await start();
    expect(await exit).toBe(1);
    expect(logs).toContain('Каталог реакций не совпадает со сборкой сервера');
  }, 45000);
});
