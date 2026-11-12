import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROTOCOL_VERSION, type WorldInfo, type WorldManifest } from '@su/contracts';
import type { PredictionWorld } from '@su/simulation/prediction';
import { buildWorld } from '../../../../tools/world-build/src/index.js';
import { GameSession } from './session';

const mocks = vi.hoisted(() => ({
  createPhysics: vi.fn(),
  reserve: vi.fn(),
  reconnect: vi.fn(),
}));
vi.mock('@su/simulation/prediction', () => ({
  createLocalPredictionWorld: mocks.createPhysics,
}));
vi.mock('@colyseus/sdk', () => ({
  Client: class {
    joinById = mocks.reserve;
    reconnect = mocks.reconnect;
  },
  CloseCode: {},
  Predict: {},
}));

let directory: string;
let manifest: WorldManifest;
let info: WorldInfo;
const sessions: GameSession[] = [];
const requests: string[] = [];
const events: string[] = [];
let wasmResponse: () => Promise<Response>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(predicate()).toBe(true);
}
function physics() {
  return {
    clear: vi.fn(),
    dispose: vi.fn(),
    retainStatic: vi.fn(),
    releaseStatic: vi.fn(),
    staticDiagnostics: () => ({
      entities: 0,
      references: 0,
      buildings: { instances: 0, assets: 0, shapes: 0, references: 0 },
      bodies: 0,
      items: 0,
      remotePlayers: 0,
    }),
  };
}
function session() {
  const instance = new GameSession(vi.fn(), vi.fn());
  sessions.push(instance);
  return instance;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-session-lazy-'));
  manifest = await buildWorld(resolve('content/worlds/physics-lab/world.json'), directory);
  info = {
    roomId: 'room',
    worldEpoch: 'epoch',
    protocolVersion: PROTOCOL_VERSION,
    mapVersion: manifest.mapVersion,
    simulationConfigHash: manifest.simulationConfigHash,
    manifestUrl: '/worlds/test/manifest.json',
    maxPlayers: 8,
    available: true,
  };
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  requests.length = events.length = 0;
  vi.stubGlobal('location', new URL('http://localhost/'));
  vi.stubGlobal('document', { hidden: false });
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  wasmResponse = async () => new Response(new Uint8Array([0, 97, 115, 109]));
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    const path = new URL(String(url), 'http://localhost/').pathname;
    requests.push(path);
    if (path === '/api/world') return Response.json(info);
    if (path.endsWith('.wasm')) {
      events.push('wasm');
      return wasmResponse();
    }
    if (path.endsWith('/manifest.json')) return Response.json(manifest);
    return new Response(await readFile(join(directory, path.slice('/worlds/test/'.length))));
  });
  mocks.createPhysics.mockImplementation(async () => {
    events.push('physics');
    return physics();
  });
  // Reservation ends the fixture; real room/message lifecycle remains covered by browser tests.
  mocks.reserve.mockImplementation(async () => {
    events.push('reserve');
    throw new Error('Fixture reservation ended');
  });
  mocks.reconnect.mockImplementation(async () => {
    events.push('reconnect');
    throw new Error('Fixture restoration ended');
  });
});
afterEach(() => {
  for (const instance of sessions.splice(0)) instance.dispose();
  vi.unstubAllGlobals();
});

describe('lazy gameplay physics', () => {
  it('loads and streams a graphical preview without requesting WASM or creating physics', async () => {
    const instance = session();
    await instance.load();
    const retain = vi.fn();
    instance.connectGraphics({
      prepareCellAssets: async () => () => {},
      retainStatic: retain,
      releaseStatic: vi.fn(),
    });
    instance.updateVisualArea({ x: 0, y: 0, z: 0 }, 500);
    await until(() => {
      instance.frame(performance.now(), 1 / 60, { moveX: 0, moveZ: 0, sprint: false });
      return instance.diagnostics().streaming?.backgroundReady === true;
    });
    expect(retain).toHaveBeenCalled();
    expect(requests.some((path) => path.endsWith('.wasm'))).toBe(false);
    expect(mocks.createPhysics).not.toHaveBeenCalled();
    expect(instance.diagnostics().predictionWorlds).toBe(0);
    expect(instance.diagnostics().physics.bodies).toBe(0);
  });

  it('prepares physics before reservation and reuses the initialized world on another entry', async () => {
    const instance = session();
    await instance.load();
    instance.markPrepared();
    await instance.join();
    expect(events).toEqual(['wasm', 'physics', 'reserve']);
    await instance.join();
    expect(mocks.reserve).toHaveBeenCalledTimes(2);
    expect(mocks.createPhysics).toHaveBeenCalledTimes(1);
    expect(requests.filter((path) => path.endsWith('.wasm'))).toHaveLength(1);
    expect(instance.diagnostics().predictionWorlds).toBe(1);
  });

  it('does not initialize or reserve after leaving during a late WASM response', async () => {
    const response = deferred<Response>();
    wasmResponse = () => response.promise; // Deliberately ignores abort, like a late response.
    const instance = session();
    await instance.load();
    const joining = instance.join();
    await until(() => events.includes('wasm'));
    await instance.leave();
    response.resolve(new Response(new Uint8Array([0, 97, 115, 109])));
    await joining;
    expect(mocks.createPhysics).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(instance.state).toBe('ready');
    expect(instance.diagnostics().predictionWorlds).toBe(0);
  });

  it('also initializes physics before restoring an existing browser session', async () => {
    const instance = session();
    await instance.load();
    sessionStorage.setItem(
      'su:session:v1',
      JSON.stringify({ token: 'saved-token', epoch: info.worldEpoch, actionId: 7 }),
    );
    await instance.restore();
    expect(events).toEqual(['wasm', 'physics', 'reconnect']);
    expect(mocks.reconnect).toHaveBeenCalledWith('saved-token', expect.anything());
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('disposes a late physics world after the session is disposed', async () => {
    const pending = deferred<PredictionWorld>();
    const world = physics();
    mocks.createPhysics.mockReturnValueOnce(pending.promise);
    const instance = session();
    await instance.load();
    const joining = instance.join();
    await until(() => mocks.createPhysics.mock.calls.length === 1);
    instance.dispose();
    pending.resolve(world as unknown as PredictionWorld);
    await joining;
    expect(world.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(instance.diagnostics().predictionWorlds).toBe(0);
  });

  it('can retry a failed WASM request without breaking the available preview', async () => {
    const instance = session();
    await instance.load();
    wasmResponse = async () => new Response(null, { status: 503 });
    await instance.join();
    expect(instance.state).toBe('ready');
    expect(mocks.reserve).not.toHaveBeenCalled();
    wasmResponse = async () => new Response(new Uint8Array([0, 97, 115, 109]));
    await instance.join();
    expect(mocks.createPhysics).toHaveBeenCalledTimes(1);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
  });

  it('never lets a cancelled initialization replace a newer gameplay world', async () => {
    const old = physics();
    const current = physics();
    const pending = deferred<PredictionWorld>();
    mocks.createPhysics.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(current);
    const instance = session();
    await instance.load();
    const joining = instance.join();
    await until(() => mocks.createPhysics.mock.calls.length === 1);
    await instance.leave();
    await instance.join();
    pending.resolve(old as unknown as PredictionWorld);
    await joining;
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(current.dispose).not.toHaveBeenCalled();
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(instance.diagnostics().predictionWorlds).toBe(1);
  });
});
