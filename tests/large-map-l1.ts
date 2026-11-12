import { prepareSdk } from './helpers/prepare.js';
import { createDatabasePool } from '../apps/server/src/database.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from '@colyseus/sdk';
import {
  canonicalJson,
  PROTOCOL_VERSION,
  WORLD_FORMAT_VERSION,
  worldManifestIdentity,
} from '../packages/contracts/src/index.js';
import { WorldState } from '../packages/protocol/src/index.js';
import { buildWorld } from '../tools/world-build/src/index.js';
import { readWorldDirectory } from '../apps/server/src/world-bundle.js';

if (!process.env.SU_TEST_DATABASE_URL)
  throw new Error('SU_TEST_DATABASE_URL is required: artifacts must use disposable test schemas.');
const admin = createDatabasePool(process.env.SU_TEST_DATABASE_URL);
const schemas = new Set<string>();

const output = process.env.SU_L1_OUTPUT ?? 'output/large-map/l1';
await mkdir(output, { recursive: true });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const temporary = await mkdtemp(join(tmpdir(), 'su-l1-artifact-'));
const evidence: { date: string; result: string; worlds: unknown[] } = {
  date: new Date().toISOString(),
  result: 'running',
  worlds: [],
};

async function portNumber() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  describe: string,
  timeout = 10_000,
) {
  const start = performance.now();
  while (!(await predicate())) {
    if (performance.now() - start > timeout) throw new Error(`Timed out: ${describe}`);
    await delay(20);
  }
}

try {
  await mkdir(join(temporary, 'dist/server'), { recursive: true });
  for (const file of ['main.mjs', 'migrate.mjs', 'migrate-world.mjs', 'HavokPhysics.wasm'])
    await cp(`dist/server/${file}`, join(temporary, 'dist/server', file));
  await cp('dist/client', join(temporary, 'dist/client'), { recursive: true });
  for (const missing of ['apps', 'packages', 'content', 'node_modules']) {
    await assert.rejects(stat(join(temporary, missing)), /ENOENT/);
  }

  for (const worldId of ['physics-lab', 'streaming-lab', 'ring-block']) {
    console.log(`L1: ${worldId}, deterministic release and isolated artifact`);
    const source = `content/worlds/${worldId}/world.json`;
    const first = await buildWorld(source, join(output, worldId, 'release'));
    const second = await buildWorld(source, join(output, worldId, 'repeat'));
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.equal(first.mapVersion, hash(canonicalJson(worldManifestIdentity(first))));
    const worldDirectory = join(temporary, 'dist/worlds', worldId);
    await mkdir(worldDirectory, { recursive: true });
    await writeFile(join(worldDirectory, 'manifest.json'), JSON.stringify(first));
    const sizes = [];
    for (const [file, expected] of Object.entries(first.files)) {
      const bytes = await readFile(join(output, worldId, 'release', file));
      assert.equal(hash(bytes), expected);
      assert.deepEqual(bytes, await readFile(join(output, worldId, 'repeat', file)));
      await mkdir(join(worldDirectory, file, '..'), { recursive: true });
      await writeFile(join(worldDirectory, file), bytes);
      sizes.push({ file, bytes: bytes.byteLength });
    }
    const { definition } = await readWorldDirectory(worldDirectory);
    const header = JSON.parse(await readFile(join(worldDirectory, first.worldFile), 'utf8'));
    assert.equal(header.formatVersion, WORLD_FORMAT_VERSION);
    assert.equal(header.entities, undefined);
    assert.equal(header.buildings, undefined);
    if (worldId !== 'ring-block')
      assert.equal(definition.buildings.length, worldId === 'streaming-lab' ? 1600 : 2);
    else
      assert.ok(
        definition.buildings.length >= 289,
        'city retains placements and adds ground tiles',
      );
    assert.equal(
      first.cells.length,
      worldId === 'streaming-lab' ? 256 : worldId === 'ring-block' ? 40 : 1,
    );
    await writeFile(join(worldDirectory, 'not-listed.txt'), 'unpublished resource');

    const port = await portNumber();
    const url = `http://127.0.0.1:${port}`;
    const schema = `su_artifact_${randomBytes(12).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemas.add(schema);
    const isolatedDatabase = new URL(process.env.SU_TEST_DATABASE_URL!);
    isolatedDatabase.searchParams.set('options', `-c search_path=${schema}`);
    const environment = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SU_WORLD: worldId,
      DATABASE_URL: isolatedDatabase.href,
      PUBLIC_ORIGIN: '',
      CLIENT_ID: '',
      CLIENT_SECRET: '',
    };
    const command = (file: string) =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const process = spawn(globalThis.process.execPath, [`dist/server/${file}`], {
          cwd: temporary,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        process.stdout.on('data', (data) => {
          output += String(data);
        });
        process.stderr.on('data', (data) => {
          output += String(data);
        });
        const timeout = setTimeout(() => {
          process.kill('SIGKILL');
          reject(new Error(`Artifact command timed out: ${file}`));
        }, 20_000);
        process.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        process.on('exit', (code) => {
          clearTimeout(timeout);
          resolve({ code, output });
        });
      });
    const rejected = await command('main.mjs');
    assert.equal(rejected.code, 1, 'startup refuses a fresh unmigrated schema');
    for (const file of ['migrate.mjs', 'migrate-world.mjs', 'migrate.mjs', 'migrate-world.mjs']) {
      const migrated = await command(file);
      assert.equal(migrated.code, 0, `${file}: ${migrated.output}`);
    }
    assert.equal(
      (await admin.query(`SELECT count(*)::int as n FROM ${schema}.persistent_worlds`)).rows[0].n,
      0,
      'migration does not seed',
    );
    const started = performance.now();
    const child = spawn(process.execPath, ['dist/server/main.mjs'], {
      cwd: temporary,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const rooms = new Set<Room<WorldState>>();
    try {
      await until(async () => {
        if (child.exitCode !== null)
          throw new Error(`Artifact exited ${child.exitCode}: ${stdout}\n${stderr}`);
        try {
          return (await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(500) })).ok;
        } catch {
          return false;
        }
      }, 'artifact readiness');
      const readyMs = performance.now() - started;
      assert.equal((await fetch(url)).status, 200);
      const info = await fetch(`${url}/api/world`).then((response) => response.json());
      assert.equal(info.protocolVersion, PROTOCOL_VERSION);
      assert.equal(info.manifestUrl, `/worlds/${worldId}/manifest.json`);
      assert.equal(info.mapVersion, first.mapVersion);
      const received = await fetch(url + info.manifestUrl).then((response) => response.json());
      assert.deepEqual(received, first);
      for (const file of [
        first.worldFile,
        first.cells[0].file,
        Object.values(first.assets)[0].modelFile,
      ]) {
        const response = await fetch(`${url}/worlds/${worldId}/${file}`);
        assert.equal(response.status, 200);
        assert.equal(hash(new Uint8Array(await response.arrayBuffer())), first.files[file]);
      }
      const other = worldId === 'physics-lab' ? 'streaming-lab' : 'physics-lab';
      for (const path of [
        `/worlds/${worldId}/not-listed.txt`,
        `/worlds/${other}/manifest.json`,
        '/package.json',
        '/server/main.mjs',
      ])
        assert.equal((await fetch(url + path)).status, 404, path);
      const sdk = new Client(url);
      await assert.rejects(
        sdk.joinById(info.roomId, { ...info, protocolVersion: 1 }),
        /VERSION_MISMATCH/,
      );
      await assert.rejects(sdk.create('world'));
      const before = await fetch(`${url}/api/diagnostics`).then((response) => response.json());
      assert.equal(
        before.bodies,
        definition.entities.length + definition.buildings.length + definition.initialItems.length,
      );
      assert.equal(before.players, 0);
      for (let i = 0; i < 8; i++) {
        const room = await sdk.joinById<WorldState>(info.roomId, info, WorldState);
        rooms.add(room);
        room.reconnection.enabled = false;
        room.onMessage('problem', () => {});
        room.onMessage('actionResult', () => {});
        room.onMessage('resync', () => {});
        prepareSdk(room);
      }
      await until(
        () =>
          [...rooms].every(
            (room) => room.state?.occupancy === 8 && room.state.players?.has(room.sessionId),
          ),
        'eight occupied seats and each own player',
      );
      await assert.rejects(sdk.joinById(info.roomId, info, WorldState));
      const occupied = await fetch(`${url}/api/diagnostics`).then((response) => response.json());
      assert.equal(occupied.sessions, 8);
      assert.equal(occupied.players, 8);
      assert.equal(occupied.bodies, before.bodies + 8);
      assert.equal(
        (await fetch(`${url}/api/world`).then((response) => response.json())).roomId,
        info.roomId,
      );
      evidence.worlds.push({
        worldId,
        formatVersion: first.formatVersion,
        protocolVersion: PROTOCOL_VERSION,
        grid: first.grid,
        mapVersion: first.mapVersion,
        simulationConfigHash: first.simulationConfigHash,
        cells: first.cells.length,
        buildings: definition.buildings.length,
        entities: definition.entities.length,
        modelIds: Object.keys(first.assets),
        files: sizes,
        readyMs,
        before,
        occupied,
        sourceFreeArtifact: true,
        isolatedDatabase: true,
        unmigratedStartupRejected: true,
        builtMigrationsIdempotent: true,
        migrationsDoNotSeed: true,
        deterministic: true,
        oldProtocolRejected: true,
        ninthRejected: true,
        nonListedFilesRejected: true,
        singleRoom: true,
        result: 'passed',
      });
    } finally {
      await Promise.allSettled([...rooms].map((room) => room.leave()));
      child.kill('SIGTERM');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Artifact did not stop'));
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        if (child.exitCode !== null) {
          clearTimeout(timeout);
          resolve();
        }
      });
      await writeFile(join(output, `${worldId}-server.log`), stdout + '\n' + stderr);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      schemas.delete(schema);
    }
  }
  evidence.result = 'passed';
  await writeFile(join(output, 'artifact.json'), JSON.stringify(evidence, null, 2) + '\n');
  await rm(join(output, 'artifact-failure.json'), { force: true });
  console.log(
    JSON.stringify({ result: evidence.result, worlds: evidence.worlds.length, output }, null, 2),
  );
} catch (error) {
  await writeFile(
    join(output, 'artifact-failure.json'),
    JSON.stringify(
      { ...evidence, error: String(error), stack: error instanceof Error ? error.stack : null },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  for (const schema of schemas) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(temporary, { recursive: true, force: true });
}
