import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatConsole } from './chat';
import { ChatSettings } from './chat-settings';

/** Small DOM surface; capture and real focus policy belong to the browser scenario. */
class Control extends EventTarget {
  hidden = false;
  disabled = false;
  value = '';
  textContent = '';
  dataset: Record<string, string> = {};
  setAttribute = vi.fn();
  setSelectionRange = vi.fn();
  focus = vi.fn(() => {
    Object.assign(document, { activeElement: this });
  });
}

function fixture() {
  const body = new Control();
  vi.stubGlobal('document', { activeElement: body, body });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const toggle = new Control();
  const form = new Control();
  form.hidden = true;
  const input = new Control();
  const canvas = new Control();
  const submit = new Control();
  const send = vi.fn(() => true);
  const lifecycle = { beforeOpen: vi.fn(), closed: vi.fn(), canFocus: vi.fn(() => true) };
  const settings = new ChatSettings();
  const chat = new ChatConsole(
    toggle as unknown as HTMLButtonElement,
    form as unknown as HTMLFormElement,
    new Control() as unknown as HTMLElement,
    input as unknown as HTMLInputElement,
    new Control() as unknown as HTMLElement,
    new Control() as unknown as HTMLElement,
    submit as unknown as HTMLButtonElement,
    canvas as unknown as HTMLCanvasElement,
    send,
    lifecycle,
    settings,
  );
  chat.update({ available: true, pending: false, remainingMs: 0 });
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };
  const key = (code: string, properties = {}) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), {
      code,
      shiftKey: false,
      repeat: false,
      ...properties,
    });
    form.dispatchEvent(event);
    return event;
  };
  return { chat, toggle, form, input, canvas, send, lifecycle, settings, type, key };
}

afterEach(() => vi.unstubAllGlobals());

describe('chat interaction lifecycle', () => {
  it.each([
    ['enter', false, true],
    ['enter', true, false],
    ['shift-enter', false, false],
    ['shift-enter', true, true],
    ['never', false, false],
    ['never', true, false],
  ] as const)('honors %s with shift=%s before ending the interaction', (mode, shiftKey, closes) => {
    const { chat, type, key, settings, lifecycle } = fixture();
    settings.setCloseMode(mode);
    chat.open();
    type('message');
    key('Enter', { shiftKey });
    expect(chat.isOpen).toBe(!closes);
    expect(lifecycle.closed).toHaveBeenCalledTimes(closes ? 1 : 0);
    chat.dispose();
  });

  it('closes synchronously after sending, before any result, without choosing world focus', () => {
    const { chat, type, key, send, lifecycle, canvas } = fixture();
    chat.open();
    type('message');
    key('Enter');
    expect(send).toHaveBeenCalledWith('message');
    expect(chat.isOpen).toBe(false);
    expect(lifecycle.closed).toHaveBeenCalledOnce();
    expect(lifecycle.closed).toHaveBeenCalledWith('send');
    expect(canvas.focus).not.toHaveBeenCalled();
    chat.complete(true);
    expect(lifecycle.closed).toHaveBeenCalledTimes(1);
    chat.dispose();
  });

  it('uses the same close lifecycle for Escape and the toggle button, once per interaction', () => {
    const { chat, key, toggle, lifecycle } = fixture();
    chat.open();
    key('Escape');
    chat.close('escape');
    expect(lifecycle.closed).toHaveBeenCalledOnce();
    expect(lifecycle.closed).toHaveBeenCalledWith('escape');
    chat.open();
    toggle.dispatchEvent(new Event('click'));
    expect(lifecycle.closed.mock.calls.map(([reason]) => reason)).toEqual(['escape', 'button']);
    chat.dispose();
  });

  it('keeps the interaction across sends that leave the form open and repeated open calls', () => {
    const { chat, type, key, settings, lifecycle } = fixture();
    settings.setCloseMode('never');
    chat.open();
    type('first');
    key('Enter');
    chat.complete(true);
    chat.open();
    type('second');
    key('Enter', { shiftKey: true });
    expect(chat.isOpen).toBe(true);
    expect(lifecycle.beforeOpen).toHaveBeenCalledTimes(1);
    expect(lifecycle.closed).not.toHaveBeenCalled();
    chat.close('button');
    expect(lifecycle.closed).toHaveBeenCalledOnce();
    expect(lifecycle.closed).toHaveBeenCalledWith('button');
    chat.dispose();
  });

  it('does not finish on rejected sends, IME or repeated Enter', () => {
    const { chat, type, key, send, lifecycle, input } = fixture();
    chat.open();
    type('message');
    input.dispatchEvent(new Event('compositionstart'));
    key('Enter');
    input.dispatchEvent(new Event('compositionend'));
    key('Enter', { repeat: true });
    expect(send).not.toHaveBeenCalled();
    send.mockReturnValue(false);
    key('Enter');
    expect(chat.isOpen).toBe(true);
    expect(lifecycle.closed).not.toHaveBeenCalled();
    chat.dispose();
  });

  it('inserts a help command without restarting an already open interaction', () => {
    const { chat, input, lifecycle } = fixture();
    chat.insert('/help ');
    expect(chat.isOpen).toBe(true);
    expect(input.value).toBe('/help ');
    expect(lifecycle.beforeOpen).toHaveBeenCalledOnce();
    chat.insert('/speed --help');
    expect(input.value).toBe('/speed --help');
    expect(lifecycle.beforeOpen).toHaveBeenCalledOnce();
    expect(lifecycle.closed).not.toHaveBeenCalled();
    chat.dispose();
  });

  it('preserves the system-close reason and does not refocus over a newer panel', () => {
    const { chat, input, lifecycle } = fixture();
    chat.open();
    input.focus.mockClear();
    Object.assign(document, { activeElement: document.body });
    lifecycle.canFocus.mockReturnValue(false);
    chat.complete(true);
    expect(input.focus).not.toHaveBeenCalled();
    chat.update({ available: false, pending: false, remainingMs: 0 });
    expect(lifecycle.closed).toHaveBeenCalledOnce();
    expect(lifecycle.closed).toHaveBeenCalledWith('unavailable');
    chat.dispose();
  });
});
