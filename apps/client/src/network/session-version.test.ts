import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WorldInfo } from '@su/contracts';
import { CLIENT_CATALOG_VERSIONS } from '../presentation/catalog-versions';

// v24 combines bus travel, LOD/HLOD and required catalog versions. Prior v23
// contracts stop before resource loads or reservation, along with older releases.
const { reserve, legacy } = vi.hoisted(() => ({ reserve: vi.fn(), legacy: { protocol: 16 } }));
vi.mock('@su/contracts', async (original) => ({
  ...(await original<typeof import('@su/contracts')>()),
  get PROTOCOL_VERSION() {
    return legacy.protocol;
  },
}));
vi.mock('@colyseus/sdk', () => ({
  Client: class {
    joinById = reserve;
    reconnect = reserve;
  },
  CloseCode: {},
  Predict: {},
}));
import { GameSession } from './session';

const current: WorldInfo = {
  roomId: 'new-room',
  worldEpoch: 'bus-city-hlod-catalogs-24',
  protocolVersion: 24,
  catalogVersions: { ...CLIENT_CATALOG_VERSIONS },
  assetReleaseVersion: 'a'.repeat(64),
  layoutRevision: 2,
  layoutHash: 'b'.repeat(64),
  mapVersion: 'c'.repeat(64),
  simulationConfigHash: 'd'.repeat(64),
  manifestUrl: '/worlds/test/manifest.json',
  maxPlayers: 8,
  available: true,
};
let instance: GameSession;
let onState: Mock<(state: string, message?: string) => void>;
let onNotice: Mock<(message: string) => void>;
let fetchWorld: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('@su/contracts')>('@su/contracts');
  expect(actual.PROTOCOL_VERSION).toBe(24);
  reserve.mockClear();
  vi.stubGlobal('location', new URL('http://localhost/'));
  vi.stubGlobal('document', { hidden: false });
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  fetchWorld = vi.fn(async () => Response.json(current));
  vi.stubGlobal('fetch', fetchWorld);
  onState = vi.fn();
  onNotice = vi.fn();
  instance = new GameSession(onState, onNotice);
});
afterEach(() => {
  instance?.dispose();
  vi.unstubAllGlobals();
});

describe.each([16, 17, 18, 19, 20, 21, 22, 23])(
  'legacy v%i tab discovering bus, graphics and catalog protocol v24',
  (version) => {
    beforeEach(() => {
      legacy.protocol = version;
    });
    it('requires reload before initial manifest/catalog download or room reservation', async () => {
      await expect(instance.load()).rejects.toThrow('VERSION_MISMATCH');
      expect(instance.reloadRequired).toBe(true);
      expect(fetchWorld).toHaveBeenCalledTimes(1);
      expect(fetchWorld.mock.calls[0][0]).toBe('/api/world');
      expect(reserve).not.toHaveBeenCalled();
    });
    it('requires reload on discovery refresh even when map geometry is unchanged', async () => {
      instance.info = { ...current, protocolVersion: version };
      instance.state = 'ready';
      await expect(instance.refreshPublication()).rejects.toThrow('VERSION_MISMATCH');
      expect(instance.reloadRequired).toBe(true);
      expect(fetchWorld).toHaveBeenCalledTimes(1);
      expect(reserve).not.toHaveBeenCalled();
    });
    it('stops recovery after the new server epoch and tells the legacy player to reload', async () => {
      instance.info = { ...current, protocolVersion: version, worldEpoch: `old-${version}` };
      instance.state = 'reconnecting';
      (instance as unknown as { beginRecoveryCheck(): void }).beginRecoveryCheck();
      await vi.waitFor(() => expect(instance.state).toBe('ready'));
      expect(instance.reloadRequired).toBe(true);
      expect(onState).toHaveBeenLastCalledWith('ready', undefined);
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Перезагрузите страницу'));
      expect(reserve).not.toHaveBeenCalled();
    });
  },
);

describe.each([
  { name: 'missing map', versions: undefined },
  { name: 'empty map', versions: {} },
  { name: 'missing animations', versions: { reactions: CLIENT_CATALOG_VERSIONS.reactions } },
  { name: 'missing reactions', versions: { animations: CLIENT_CATALOG_VERSIONS.animations } },
  { name: 'changed reactions', versions: { ...CLIENT_CATALOG_VERSIONS, reactions: 'previous' } },
  { name: 'changed animations', versions: { ...CLIENT_CATALOG_VERSIONS, animations: 'previous' } },
  { name: 'extra collection', versions: { ...CLIENT_CATALOG_VERSIONS, items: 'unsupported' } },
])('catalog compatibility: $name', ({ versions }) => {
  beforeEach(() => {
    legacy.protocol = 24;
  });
  beforeEach(() => {
    fetchWorld.mockImplementation(async () =>
      Response.json({ ...current, catalogVersions: versions }),
    );
  });
  it('requires reload before resource download', async () => {
    await expect(instance.load()).rejects.toThrow('VERSION_MISMATCH');
    expect(instance.reloadRequired).toBe(true);
    expect(fetchWorld).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('requires reload on publication refresh even when the map is unchanged', async () => {
    instance.info = current;
    instance.state = 'ready';
    await expect(instance.refreshPublication()).rejects.toThrow('VERSION_MISMATCH');
    expect(instance.reloadRequired).toBe(true);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('requires reload before room reservation or reconnection', async () => {
    instance.info = current;
    instance.state = 'ready';
    await instance.join();
    expect(instance.reloadRequired).toBe(true);
    expect(reserve).not.toHaveBeenCalled();
    instance.state = 'reconnecting';
    await instance.join({ token: 'previous-token', epoch: current.worldEpoch, actionId: 0 });
    expect(instance.reloadRequired).toBe(true);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('requires reload during recovery when only catalogs changed', async () => {
    instance.info = { ...current, worldEpoch: 'previous-process' };
    instance.state = 'reconnecting';
    (instance as unknown as { beginRecoveryCheck(): void }).beginRecoveryCheck();
    await vi.waitFor(() => expect(instance.state).toBe('ready'));
    expect(instance.reloadRequired).toBe(true);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Перезагрузите страницу'));
    expect(reserve).not.toHaveBeenCalled();
  });
});
