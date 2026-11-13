import {
  createWorldPublication,
  type WorldPublication,
} from '../../../../packages/world-release/src/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PROTOCOL_VERSION,
  loadWorldBundle,
  type WorldInfo,
  type WorldManifest,
} from '@su/contracts';
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
let publicationA: WorldPublication, publicationB: WorldPublication;
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
  const world = await loadWorldBundle(manifest, (path) => readFile(join(directory, path)));
  const compiled = Object.fromEntries(
    await Promise.all(
      Object.entries(manifest.assets).map(async ([id, asset]) => [
        id,
        {
          version: asset.version,
          bounds: asset.bounds,
          physics: world.buildingAssets[id],
          model: asset.modelFile ? await readFile(join(directory, asset.modelFile)) : undefined,
          collision: await readFile(join(directory, asset.collisionFile)),
          parts: await readFile(join(directory, asset.partsFile)),
        },
      ]),
    ),
  );
  publicationA = createWorldPublication(
    {
      ...world,
      routes: {
        'context-a': [
          { x: 0, z: 0 },
          { x: 1, z: 1 },
        ],
      },
    },
    manifest.grid,
    compiled,
  );
  publicationB = createWorldPublication(
    {
      ...world,
      routes: {
        'context-b': [
          { x: 0, z: 0 },
          { x: 2, z: 2 },
        ],
      },
    },
    manifest.grid,
    compiled,
  );
  info = {
    roomId: 'room',
    assetReleaseVersion: 'a'.repeat(64),
    layoutRevision: 1,
    layoutHash: 'b'.repeat(64),
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
  it('ignores initial metadata arriving after disposal', async () => {
    const instance = session();
    const delayed = deferred<Response>();
    const previousFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) =>
      String(url) === '/api/world' ? delayed.promise : previousFetch(url, init),
    );
    const loading = instance.load();
    instance.dispose();
    delayed.resolve(Response.json(info));
    await loading;
    expect(instance.info).toBeUndefined();
    expect(instance.definition).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('keeps the newer load when an earlier metadata request finishes last', async () => {
    const instance = session();
    const delayed = deferred<Response>();
    const previousFetch = globalThis.fetch;
    let first = true;
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/world' && first) {
        first = false;
        return delayed.promise;
      }
      return previousFetch(url, init);
    });
    const old = instance.load();
    await instance.load();
    instance.markPrepared();
    delayed.resolve(Response.json({ ...info, worldEpoch: 'obsolete' }));
    await old;
    expect(instance.info.worldEpoch).toBe(info.worldEpoch);
    expect(instance.state).toBe('ready');
  });

  it('can report diagnostics before metadata arrives', () => {
    expect(session().diagnostics()).toMatchObject({
      connection: 'loading',
      publication: { mapVersion: undefined },
    });
  });

  it('ignores a preview refresh after a newer load owns the world context', async () => {
    const instance = session();
    await instance.load();
    instance.markPrepared();
    const delayed = deferred<Response>();
    const previousFetch = globalThis.fetch;
    let first = true;
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/world' && first) {
        first = false;
        return delayed.promise;
      }
      return previousFetch(url, init);
    });
    const refresh = instance.refreshPublication();
    await instance.load();
    instance.markPrepared();
    delayed.resolve(Response.json({ ...info, worldEpoch: 'obsolete' }));
    await refresh;
    expect(instance.info.worldEpoch).toBe(info.worldEpoch);
    expect(instance.state).toBe('ready');
  });

  it('ignores an old manifest response after a newer publication has replaced the context', async () => {
    const instance = session();
    await instance.load();
    instance.markPrepared();
    const delayed = deferred<Response>();
    const previousFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url), 'http://localhost/').pathname;
      if (path === '/worlds/layout-a/manifest.json') return delayed.promise;
      if (path.startsWith('/worlds/layout-b/')) {
        const file = path.slice('/worlds/layout-b/'.length);
        return file === 'manifest.json'
          ? Response.json(publicationB.manifest)
          : new Response(Uint8Array.from(publicationB.payloads.get(file)!));
      }
      return previousFetch(url, init);
    });
    const context = instance as unknown as {
      changePublication: (info: WorldInfo) => Promise<void>;
    };
    const old = context.changePublication({
      ...info,
      mapVersion: publicationA.manifest.mapVersion,
      simulationConfigHash: publicationA.manifest.simulationConfigHash,
      manifestUrl: '/worlds/layout-a/manifest.json',
      layoutRevision: 2,
    });
    await context.changePublication({
      ...info,
      mapVersion: publicationB.manifest.mapVersion,
      simulationConfigHash: publicationB.manifest.simulationConfigHash,
      manifestUrl: '/worlds/layout-b/manifest.json',
      layoutRevision: 3,
    });
    delayed.resolve(Response.json(publicationA.manifest));
    await old;
    expect(instance.info.mapVersion).toBe(publicationB.manifest.mapVersion);
    expect(instance.info.layoutRevision).toBe(3);
    expect(instance.definition.routes).toHaveProperty('context-b');
    expect(instance.state).toBe('ready');
  });

  it('can retry the same publication after leaving during an earlier download', async () => {
    const instance = session();
    await instance.load();
    instance.markPrepared();
    const delayed = deferred<Response>();
    const previousFetch = globalThis.fetch;
    let manifests = 0;
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url), 'http://localhost/').pathname;
      if (path.startsWith('/worlds/layout-b/')) {
        const file = path.slice('/worlds/layout-b/'.length);
        if (file === 'manifest.json') {
          manifests++;
          return manifests === 1
            ? delayed.promise
            : Promise.resolve(Response.json(publicationB.manifest));
        }
        return Promise.resolve(new Response(Uint8Array.from(publicationB.payloads.get(file)!)));
      }
      return previousFetch(url, init);
    });
    const context = instance as unknown as {
      changePublication: (info: WorldInfo) => Promise<void>;
    };
    const next = {
      ...info,
      mapVersion: publicationB.manifest.mapVersion,
      simulationConfigHash: publicationB.manifest.simulationConfigHash,
      manifestUrl: '/worlds/layout-b/manifest.json',
      layoutRevision: 2,
    };
    const cancelled = context.changePublication(next);
    await instance.leave();
    const current = context.changePublication(next);
    await until(() => manifests === 2);
    await current;
    delayed.resolve(Response.json(publicationB.manifest));
    await cancelled;
    expect(instance.definition.routes).toHaveProperty('context-b');
    expect(instance.state).toBe('ready');
  });

  it('recovers a restarted world with a new layout through preflight without requiring an application reload', async () => {
    const instance = session();
    await instance.load();
    instance.markPrepared();
    const next = {
      ...info,
      worldEpoch: 'new-epoch',
      mapVersion: publicationB.manifest.mapVersion,
      simulationConfigHash: publicationB.manifest.simulationConfigHash,
      manifestUrl: '/worlds/layout-b/manifest.json',
      layoutRevision: 3,
    };
    const previousFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url), 'http://localhost/').pathname;
      if (path === '/api/world') return Response.json(next);
      if (path.startsWith('/worlds/layout-b/')) {
        const file = path.slice('/worlds/layout-b/'.length);
        return file === 'manifest.json'
          ? Response.json(publicationB.manifest)
          : new Response(Uint8Array.from(publicationB.payloads.get(file)!));
      }
      return previousFetch(url, init);
    });
    sessionStorage.setItem('su:static-operation:account', 'pending-request');
    instance.state = 'reconnecting';
    (instance as unknown as { beginRecoveryCheck: () => void }).beginRecoveryCheck();
    await until(() => instance.state === 'ready');
    expect(instance.reloadRequired).toBe(false);
    await instance.join();
    expect(instance.info.mapVersion).toBe(next.mapVersion);
    expect(instance.definition.routes).toHaveProperty('context-b');
    expect(sessionStorage.getItem('su:static-operation:account')).toBe('pending-request');
  });

  it('sounds a fresh denied item action once but keeps its replay silent after SDK reconnect', async () => {
    const messages = new Map<string, (value: unknown) => void>();
    let drop: (() => void) | undefined;
    let reconnect: (() => void) | undefined;
    const room = {
      sessionId: 'self',
      reconnectionToken: 'token',
      reconnection: {},
      state: { players: new Map(), items: new Map(), serverTick: 0 },
      onStateChange: vi.fn(),
      onDrop: (callback: () => void) => {
        drop = callback;
      },
      onReconnect: (callback: () => void) => {
        reconnect = callback;
      },
      onLeave: vi.fn(),
      onError: vi.fn(),
      onMessage: (name: string, callback: (value: unknown) => void) => messages.set(name, callback),
      send: vi.fn(),
    };
    mocks.reserve.mockResolvedValueOnce(room);
    mocks.createPhysics.mockResolvedValueOnce({ ...physics(), syncRemote: vi.fn() });
    const instance = session();
    instance.accountId = 'account';
    const feedback = vi.fn();
    instance.onActionFeedback = feedback;
    await instance.load();
    instance.markPrepared();
    await instance.join();
    expect(instance.room).toBe(room);
    const itemResult = messages.get('itemResult')!;
    const pendingId = () =>
      JSON.parse(sessionStorage.getItem('su:item-operation:account')!).operationId as string;

    // Rendering/area preparation is independent of this message lifecycle regression.
    instance.state = 'playing';
    instance.itemAction({ kind: 'pickup', itemId: 'crate-01' });
    const first = { operationId: pendingId(), ok: false, code: 'OUT_OF_REACH' };
    itemResult(first);
    itemResult(first);
    expect(feedback).toHaveBeenCalledExactlyOnceWith('error');

    instance.itemAction({ kind: 'pickup', itemId: 'crate-01' });
    const replay = { operationId: pendingId(), ok: false, code: 'OUT_OF_REACH' };
    drop!();
    expect(instance.state).toBe('reconnecting');
    expect(instance.itemPending).toBe(true);
    reconnect!();
    await Promise.resolve();
    expect(instance.room).toBe(room); // SDK reconnect did not run cleanup or reserve a new room.
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    instance.state = 'playing';
    itemResult(replay);
    expect(instance.itemPending).toBe(false);
    expect(feedback).toHaveBeenCalledExactlyOnceWith('error');
  });

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
