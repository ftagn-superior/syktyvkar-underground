import { describe, expect, it, vi } from 'vitest';
import type { PlaceStaticResult } from '@su/contracts';
import { StaticPlacement } from './static-placement';

const methods = StaticPlacement.prototype as unknown as {
  result: (this: unknown, result: PlaceStaticResult) => Promise<void>;
  recoverLayout: (this: unknown) => Promise<void>;
};
const handleResult = methods.result;

function recoveryFixture() {
  let finish!: () => void;
  const refresh = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const state = {
    active: true,
    generation: 1,
    recovering: false,
    errorMessage: '',
    effect: { catalog: { placementCatalogVersion: 'old' } },
    confirm: { disabled: false },
    otherModel: { disabled: false },
    cancelButton: { disabled: true },
    retryModel: { hidden: true, textContent: '', focus: vi.fn() },
    retryRecovery: undefined as (() => void) | undefined,
    status: { textContent: '' },
    freshPointer: true,
    freshConfirmKey: true,
    releaseGhost: vi.fn(),
    loadCatalog: vi.fn(),
    recoverLayout: methods.recoverLayout,
    session: {
      refreshPublication: vi.fn(() => refresh),
      info: { placementCatalog: { placementCatalogVersion: 'current' } },
    },
  };
  return { state, finish };
}

describe('placement result recovery ownership', () => {
  it('does not reopen or reset a replacement tool after its refresh completes', async () => {
    const { state, finish } = recoveryFixture();
    const recovering = handleResult.call(state, {
      operationId: 'op',
      ok: false,
      code: 'CATALOG_CHANGED',
    });
    expect(state.recovering).toBe(true);
    // The user closed this tool and opened another while discovery was in flight.
    state.generation++;
    state.recovering = false;
    const replacement = { placementCatalogVersion: 'replacement' };
    state.effect.catalog = replacement;
    finish();
    await recovering;
    expect(state.loadCatalog).not.toHaveBeenCalled();
    expect(state.effect.catalog).toBe(replacement);
    expect(state.recovering).toBe(false);
  });
  it('blocks confirmation until the new revision is discovered and requires fresh input', async () => {
    const { state, finish } = recoveryFixture();
    const recovering = handleResult.call(state, {
      operationId: 'op',
      ok: false,
      code: 'LAYOUT_CHANGED',
    });
    expect(state.confirm.disabled).toBe(true);
    expect(state.otherModel.disabled).toBe(true);
    expect(state.freshPointer).toBe(false);
    expect(state.freshConfirmKey).toBe(false);
    expect(state.recovering).toBe(true);
    finish();
    await recovering;
    expect(state.recovering).toBe(false);
  });
  it('reopens from the refreshed catalog reference rather than fetching the old process URL', async () => {
    const { state, finish } = recoveryFixture();
    const recovering = handleResult.call(state, {
      operationId: 'op',
      ok: false,
      code: 'ASSET_NOT_ALLOWED',
    });
    finish();
    await recovering;
    expect(state.effect.catalog).toBe(state.session.info.placementCatalog);
    expect(state.loadCatalog).toHaveBeenCalledOnce();
  });
  it('keeps confirmation disabled after discovery fails and requires an explicit successful refresh', async () => {
    const { state, finish } = recoveryFixture();
    state.session.refreshPublication.mockRejectedValueOnce(new Error('Offline'));
    await handleResult.call(state, { operationId: 'op', ok: false, code: 'LAYOUT_CHANGED' });
    expect(state.recovering).toBe(true);
    expect(state.confirm.disabled).toBe(true);
    expect(state.otherModel.disabled).toBe(true);
    expect(state.cancelButton.disabled).toBe(false);
    expect(state.retryModel.hidden).toBe(false);
    expect(state.retryModel.textContent).toBe('Повторить обновление');
    expect(state.session.refreshPublication).toHaveBeenCalledOnce();
    state.retryRecovery!();
    expect(state.session.refreshPublication).toHaveBeenCalledTimes(2);
    expect(state.confirm.disabled).toBe(true);
    finish();
    await vi.waitFor(() => expect(state.recovering).toBe(false));
    expect(state.retryModel.hidden).toBe(true);
    expect(state.freshPointer).toBe(false);
    expect(state.freshConfirmKey).toBe(false);
  });
});
