import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WorldInfo } from '@su/contracts';

// Model already-open v16/v17/v18/v19 bundles. The combined terrain/saved-position
// release must stop legacy tabs before they load a catalog or reserve a room.
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
  worldEpoch: 'terrain-live-saved-position-20',
  protocolVersion: 20,
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
  expect(actual.PROTOCOL_VERSION).toBe(20);
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

describe.each([16, 17, 18, 19])(
  'legacy v%i tab discovering terrain live protocol v20',
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
