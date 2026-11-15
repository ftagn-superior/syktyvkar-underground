import { ANIMATION_CATALOG_VERSION } from '@su/contracts';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WorldInfo } from '@su/contracts';

// Model already-open v16–v22 bundles, including both incompatible v20 releases.
// Catalog-map protocol v23 retains graphics/world-v6 and rejects older tabs before loading.
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
  worldEpoch: 'city-hlod-catalogs-23',
  protocolVersion: 23,
  catalogVersions: { animations: ANIMATION_CATALOG_VERSION },
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
  expect(actual.PROTOCOL_VERSION).toBeGreaterThan(22);
  current.protocolVersion = actual.PROTOCOL_VERSION;
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

describe.each([16, 17, 18, 19, 20, 21, 22])(
  'legacy v%i tab discovering graphics and catalog-map protocol',
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

describe('animation catalog release compatibility independent of protocol number', () => {
  beforeEach(async () => {
    legacy.protocol = (
      await vi.importActual<typeof import('@su/contracts')>('@su/contracts')
    ).PROTOCOL_VERSION;
  });
  it.each([
    undefined,
    {},
    { animations: 'older-catalog' },
    { reactions: 'reaction-only-release' },
    { ...current.catalogVersions, reactions: 'unsupported-release' },
  ])('rejects catalog %s before resources or reservation', async (version) => {
    fetchWorld.mockImplementation(async () =>
      Response.json({ ...current, catalogVersions: version }),
    );
    await expect(instance.load()).rejects.toThrow('VERSION_MISMATCH');
    expect(instance.reloadRequired).toBe(true);
    expect(fetchWorld).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('rejects a changed catalog during publication refresh', async () => {
    instance.info = current;
    instance.state = 'ready';
    fetchWorld.mockImplementation(async () =>
      Response.json({ ...current, catalogVersions: { animations: 'new-catalog' } }),
    );
    await expect(instance.refreshPublication()).rejects.toThrow('VERSION_MISMATCH');
    expect(instance.reloadRequired).toBe(true);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('requires reload when recovery discovers another catalog with the same protocol', async () => {
    instance.info = current;
    instance.state = 'reconnecting';
    fetchWorld.mockImplementation(async () =>
      Response.json({
        ...current,
        worldEpoch: `${current.worldEpoch}-restarted`,
        catalogVersions: { animations: 'new-catalog' },
      }),
    );
    (instance as unknown as { beginRecoveryCheck(): void }).beginRecoveryCheck();
    await vi.waitFor(() => expect(instance.state).toBe('ready'));
    expect(instance.reloadRequired).toBe(true);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Перезагрузите страницу'));
    expect(reserve).not.toHaveBeenCalled();
  });
});
