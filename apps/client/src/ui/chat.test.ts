import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandHelpEntry } from '@su/contracts';
import { ChatConsole, type ChatCompletionSource } from './chat';
import { ChatSettings } from './chat-settings';

/** Small DOM surface; capture and real focus policy belong to the browser scenario. */
class Control extends EventTarget {
  hidden = false;
  disabled = false;
  readOnly = false;
  value = '';
  textContent = '';
  id = '';
  className = '';
  selectionStart: number | null = null;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Control[] = [];
  parent?: Control;
  setAttribute = vi.fn((name: string, value: string) => {
    this.attributes[name] = value;
  });
  removeAttribute = vi.fn((name: string) => {
    delete this.attributes[name];
  });
  setSelectionRange = vi.fn((start: number) => {
    this.selectionStart = start;
  });
  replaceChildren = vi.fn((...nodes: Control[]) => {
    this.children = nodes;
    for (const node of nodes) node.parent = this;
  });
  append = vi.fn((...nodes: Control[]) => {
    this.children.push(...nodes);
    for (const node of nodes) node.parent = this;
  });
  closest = vi.fn((selector: string): Control | null => {
    const className = selector.startsWith('.') ? selector.slice(1) : '';
    let node: Control | undefined = this;
    while (node) {
      if (className && node.className.split(/\s+/).includes(className)) return node;
      node = node.parent;
    }
    return null;
  });
  focus = vi.fn(() => {
    Object.assign(document, { activeElement: this });
  });
}

function fixture(completion?: ChatCompletionSource) {
  const body = new Control();
  vi.stubGlobal('document', {
    activeElement: body,
    body,
    createElement: () => new Control(),
  });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const toggle = new Control();
  const form = new Control();
  form.hidden = true;
  const input = new Control();
  const status = new Control();
  const canvas = new Control();
  const submit = new Control();
  const suggest = new Control();
  suggest.hidden = true;
  const send = vi.fn(() => true);
  const lifecycle = { beforeOpen: vi.fn(), closed: vi.fn(), canFocus: vi.fn(() => true) };
  const settings = new ChatSettings();
  const chat = new ChatConsole(
    toggle as unknown as HTMLButtonElement,
    form as unknown as HTMLFormElement,
    new Control() as unknown as HTMLElement,
    input as unknown as HTMLInputElement,
    status as unknown as HTMLElement,
    new Control() as unknown as HTMLElement,
    submit as unknown as HTMLButtonElement,
    canvas as unknown as HTMLCanvasElement,
    send,
    lifecycle,
    settings,
    completion ? (suggest as unknown as HTMLElement) : undefined,
    completion,
  );
  chat.update({ available: true, pending: false, remainingMs: 0 });
  const type = (text: string) => {
    input.value = text;
    input.selectionStart = text.length;
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
  return {
    chat,
    toggle,
    form,
    input,
    status,
    suggest,
    canvas,
    send,
    lifecycle,
    settings,
    type,
    key,
  };
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

  it('cycles command and flag suggestions with Tab / Shift+Tab and refreshes on catalog arrival', () => {
    let catalog: CommandHelpEntry[] | undefined;
    const commandsMock = vi.fn(() => catalog);
    const { chat, input, suggest, status, type, key } = fixture({
      commands: commandsMock,
      players: () => ['Маша', 'Гость 2'],
    });
    chat.open('/');
    expect(commandsMock).toHaveBeenCalled();
    expect(suggest.hidden).toBe(true);

    catalog = [
      {
        name: 'time',
        aliases: [],
        category: 'Мир',
        summary: 'Время',
        usage: 'time',
        args: [],
        flags: [
          { name: 'stop', help: 'Остановить' },
          { name: 'start', help: 'Запустить' },
        ],
        conflicts: [['stop', 'start']],
        examples: [],
      },
      {
        name: 'speed',
        aliases: [],
        category: 'Игроки',
        summary: 'Скорость',
        usage: 'speed',
        args: [{ name: '@игрок', optional: true, help: 'Кому', player: true }],
        flags: [],
        conflicts: [],
        examples: [],
      },
    ];
    chat.refreshSuggestions();
    expect(suggest.hidden).toBe(false);
    expect(suggest.children).toHaveLength(2);
    expect(status.textContent).toContain('Tab');

    type('/time --st');
    expect(suggest.children).toHaveLength(2);
    const tab1 = key('Tab');
    expect(tab1.defaultPrevented).toBe(true);
    expect(input.value).toBe('/time --stop ');
    expect(suggest.children[0].attributes['aria-selected']).toBe('true');

    key('Tab');
    expect(input.value).toBe('/time --start ');
    expect(suggest.children[1].attributes['aria-selected']).toBe('true');

    key('Tab', { shiftKey: true });
    expect(input.value).toBe('/time --stop ');

    type('/speed @');
    expect(suggest.children.map((option) => option.children[0].textContent)).toEqual([
      '@Маша',
      '@Гость 2',
    ]);
    const option = suggest.children[1].children[0];
    const click = new Event('click', { bubbles: true });
    Object.defineProperty(click, 'target', { value: option });
    suggest.dispatchEvent(click);
    expect(input.value).toBe('/speed @"Гость 2" ');

    chat.close('escape');
    expect(suggest.hidden).toBe(true);
    chat.dispose();
  });
});
