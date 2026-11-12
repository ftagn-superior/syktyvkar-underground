import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirstPersonInput } from './first-person';

class Element extends EventTarget {}
class Canvas extends Element {
  requestPointerLock = vi.fn<() => Promise<void>>(() => new Promise(() => {}));
}
function fixture() {
  const canvas = new Canvas();
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    pointerLockElement: null as Canvas | null,
    exitPointerLock: vi.fn(),
  });
  const win = new EventTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('HTMLElement', Element);
  const options = {
    eligible: vi.fn(() => true),
    prepare: vi.fn(),
    reset: vi.fn(),
    modeChanged: vi.fn(),
    stateChanged: vi.fn(),
    look: vi.fn(),
    notice: vi.fn(),
  };
  const input = new FirstPersonInput(canvas as unknown as HTMLCanvasElement, options);
  const lock = (locked: boolean) => {
    doc.pointerLockElement = locked ? canvas : null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  return { canvas, doc, win, options, input, lock };
}
afterEach(() => vi.unstubAllGlobals());

describe('confirmed first-person capture lifecycle', () => {
  it('activates only after browser confirmation and resumes only after a fresh action', () => {
    const { input, options, lock, canvas } = fixture();
    input.toggle();
    expect(input.requesting).toBe(true);
    expect(input.selected).toBe(false);
    lock(true);
    expect(input.selected).toBe(true);
    expect(input.locked).toBe(true);
    input.suspend();
    expect(input.locked).toBe(false);
    expect(input.selected).toBe(true);
    lock(false);
    expect(canvas.requestPointerLock).toHaveBeenCalledTimes(1);
    input.request();
    lock(true);
    expect(input.locked).toBe(true);
    input.overview();
    lock(false);
    expect(options.modeChanged.mock.calls.map(([mode]) => mode)).toEqual([true, true, false]);
    input.dispose();
  });
  it('releases a late successful response after cancellation without changing mode', () => {
    const { input, options, lock, doc, canvas } = fixture();
    input.toggle();
    input.toggle();
    input.request(); // No overlapping request while the cancelled browser request is unresolved.
    expect(canvas.requestPointerLock).toHaveBeenCalledTimes(1);
    lock(true);
    expect(input.selected).toBe(false);
    expect(input.locked).toBe(false);
    expect(doc.exitPointerLock).toHaveBeenCalledTimes(1);
    expect(options.modeChanged).not.toHaveBeenCalledWith(true);
    input.dispose();
  });
  it('keeps overview on rejection and never auto captures after focus or visibility changes', async () => {
    const { input, options, canvas, win, doc } = fixture();
    canvas.requestPointerLock.mockRejectedValueOnce(new Error('denied'));
    input.request();
    await Promise.resolve();
    expect(input.requesting).toBe(false);
    expect(input.selected).toBe(false);
    expect(options.notice).toHaveBeenCalledOnce();
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(canvas.requestPointerLock).toHaveBeenCalledOnce();
    input.dispose();
  });
  it('clears capture and input on blur and ignores late confirmation when no longer eligible', () => {
    const { input, options, win, lock, doc } = fixture();
    input.request();
    options.eligible.mockReturnValue(false);
    lock(true);
    expect(doc.exitPointerLock).toHaveBeenCalledOnce();
    expect(input.selected).toBe(false);
    win.dispatchEvent(new Event('blur'));
    expect(input.requesting).toBe(false);
    expect(options.reset).toHaveBeenCalled();
    input.dispose();
  });
  it('disposal removes listeners and clears selected mode', () => {
    const { input, options, lock } = fixture();
    input.request();
    lock(true);
    input.dispose();
    options.modeChanged.mockClear();
    lock(true);
    expect(input.selected).toBe(false);
    expect(options.modeChanged).not.toHaveBeenCalled();
  });
  it('releases a browser response arriving after disposal', () => {
    const { input, options, lock, doc } = fixture();
    input.request();
    input.dispose();
    options.modeChanged.mockClear();
    lock(true);
    expect(doc.exitPointerLock).toHaveBeenCalledOnce();
    expect(options.modeChanged).not.toHaveBeenCalled();
    lock(true);
    expect(doc.exitPointerLock).toHaveBeenCalledOnce();
  });
});
