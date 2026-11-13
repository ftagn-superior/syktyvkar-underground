import { describe, expect, it, vi } from 'vitest';
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
  const ghost = { dispose: vi.fn() };
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
    catalogPanel: { hide: vi.fn() },
    assetId: 'bench',
    pose: { position: { x: 12, y: 0, z: 8 } },
    yawStep: 3,
    focused: true,
    confirm: { disabled: false },
    panel: { hidden: false },
    generation: 1,
    controller,
    ghost,
  });
  const submit = () => (tool as PlacementMethods).place();
  return { tool: tool as StaticPlacement, session, ghost, controller, mode, canvas, submit };
}

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
