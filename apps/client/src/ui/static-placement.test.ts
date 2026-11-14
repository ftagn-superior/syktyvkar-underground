import { afterEach, describe, expect, it, vi } from 'vitest';
import { staticPlacementRotation } from '@su/contracts';
import { StaticPlacement } from './static-placement';

type PlacementMethods = { place(): void };

function fixture(accepted = true) {
  const tool = Object.create(StaticPlacement.prototype);
  const session = {
    state: 'playing',
    staticPlacementPending: false,
    staticRemovalPending: false,
    placeStatic: vi.fn(() => {
      session.staticPlacementPending = accepted;
      return accepted;
    }),
  };
  const ghost = { dispose: vi.fn(), show: vi.fn() };
  const controller = new AbortController();
  const mode = vi.fn();
  const canvas = { focus: vi.fn() };
  Object.assign(tool, {
    session,
    canvas,
    mode,
    available: () => true,
    effect: { kind: 'staticPlacement' },
    catalog: { placementCatalogVersion: 'catalog-version' },
    catalogPanel: { hide: vi.fn(), diagnostics: () => ({}) },
    assetId: 'bench',
    pose: { position: { x: 12, y: 0, z: 8 } },
    yawStep: 3,
    focused: true,
    confirm: { disabled: false },
    cancelButton: { disabled: false },
    otherModel: { disabled: false },
    status: { textContent: '' },
    panel: { hidden: false },
    generation: 1,
    controller,
    ghost,
  });
  const submit = () => (tool as PlacementMethods).place();
  return { tool: tool as StaticPlacement, session, ghost, controller, mode, canvas, submit };
}

afterEach(() => vi.unstubAllGlobals());

describe('static placement submission ownership', () => {
  it('releases the ghost and input mode immediately while the persisted request stays pending', () => {
    const f = fixture();
    f.submit();
    expect(f.session.placeStatic).toHaveBeenCalledExactlyOnceWith(
      { x: 12, z: 8 },
      3,
      'bench',
      'catalog-version',
    );
    expect(f.tool.active).toBe(false);
    expect(f.ghost.dispose).toHaveBeenCalledOnce();
    expect(f.controller.signal.aborted).toBe(true);
    expect(f.mode).toHaveBeenLastCalledWith(false);
    expect(f.canvas.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(f.session.staticPlacementPending).toBe(true);
    f.submit();
    f.tool.close();
    expect(f.session.placeStatic).toHaveBeenCalledOnce();
    expect(f.session.staticPlacementPending).toBe(true);
  });

  it('previews a nonzero terrain support height but submits only X/Z and releases controls', () => {
    vi.stubGlobal('document', { hidden: false });
    const f = fixture();
    const bounds = { min: { x: -100, y: -20, z: -100 }, max: { x: 100, y: 100, z: 100 } };
    const surface = vi.fn((from: { x: number; z: number }) => ({
      entityId: 'terrain-ground',
      point: { x: from.x, y: 11.4, z: from.z },
      normal: { x: 0, y: 1, z: 0 },
    }));
    Object.assign(f.session, {
      definition: { bounds },
      manifest: {
        assets: {
          bench: { bounds: { min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 2, z: 0.5 } } },
        },
      },
      staticPlacementSurface: surface,
      worldPaused: false,
    });
    Object.assign(f.tool, {
      catalog: {
        placementCatalogVersion: 'catalog-version',
        groundY: null,
        yawSteps: 24,
        terrain: { groundEntityIds: ['terrain-ground'] },
        models: [
          {
            assetId: 'bench',
            placement: {
              kind: 'ground-anchor',
              anchor: { x: 0, y: 1, z: 0 },
              contactRadius: 0.1,
              maximumTerrainReliefMetres: 0.3,
              contactDatum: 'anchor',
            },
          },
        ],
      },
      view: () => ({
        pointerRay: () => ({ from: { x: 12, y: 50, z: 8 }, to: { x: 12, y: -50, z: 8 } }),
      }),
    });
    f.tool.frame();
    const pose = { position: { x: 12, y: 10.4, z: 8 }, rotation: staticPlacementRotation(3) };
    expect(f.ghost.show).toHaveBeenLastCalledWith(pose);
    expect(f.tool.diagnostics().pose).toEqual(pose);
    expect(surface).toHaveBeenCalledTimes(10);
    f.submit();
    expect(f.session.placeStatic).toHaveBeenCalledExactlyOnceWith(
      { x: 12, z: 8 },
      3,
      'bench',
      'catalog-version',
    );
    expect(f.session.staticPlacementPending).toBe(true);
    expect(f.tool.active).toBe(false);
    expect(f.ghost.dispose).toHaveBeenCalledOnce();
    expect(f.mode).toHaveBeenLastCalledWith(false);
  });

  it('preserves the preview when the session cannot persist and send the request', () => {
    const f = fixture(false);
    f.submit();
    expect(f.tool.active).toBe(true);
    expect(f.ghost.dispose).not.toHaveBeenCalled();
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.mode).not.toHaveBeenCalled();
  });

  it('rejects a new submission and opening while either static operation is pending', async () => {
    for (const key of ['staticPlacementPending', 'staticRemovalPending'] as const) {
      const f = fixture();
      f.session[key] = true;
      f.submit();
      expect(f.session.placeStatic).not.toHaveBeenCalled();
      f.tool.close();
      await f.tool.open({ kind: 'staticPlacement' } as Parameters<StaticPlacement['open']>[0]);
      expect(f.tool.active).toBe(false);
    }
  });
});
