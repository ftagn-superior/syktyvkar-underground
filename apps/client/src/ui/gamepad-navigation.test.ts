import { afterEach, describe, expect, it, vi } from 'vitest';
import { GamepadNavigation } from './gamepad-navigation';

function fixture() {
  const doc = { activeElement: null as unknown };
  vi.stubGlobal('document', doc);
  const makeElement = (disabled = false) => {
    const classes = new Set<string>();
    const node = {
      disabled,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
      },
      getAttribute: () => null,
      focus: vi.fn(() => {
        doc.activeElement = node;
      }),
      scrollIntoView: vi.fn(),
      click: vi.fn(),
    };
    return node;
  };
  const first = makeElement();
  const unavailable = makeElement(true);
  const last = makeElement();
  const navigation = new GamepadNavigation();
  const items = [
    { id: 'join', element: first as unknown as HTMLElement },
    { id: 'unavailable', element: unavailable as unknown as HTMLElement },
    { id: 'audio', element: last as unknown as HTMLElement },
  ];
  return { doc, makeElement, first, unavailable, last, navigation, items };
}

afterEach(() => vi.unstubAllGlobals());

describe('explicit gamepad menu navigation', () => {
  it('does not wrap at either edge and leaves disabled items visible and inactive', () => {
    const { navigation, items, first, unavailable, last } = fixture();
    navigation.setContext('lobby', items);
    expect(first.focus).toHaveBeenCalledTimes(1);
    expect(navigation.handle('up')).toBe(false);
    navigation.handle('down');
    expect(navigation.selectedId).toBe('unavailable');
    expect(unavailable.classList.contains('gamepad-focus')).toBe(true);
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.focus).not.toHaveBeenCalled();
    expect(navigation.handle('a')).toBe(false);
    expect(unavailable.click).not.toHaveBeenCalled();
    navigation.handle('down');
    expect(navigation.handle('down')).toBe(false);
    navigation.handle('a');
    expect(last.click).toHaveBeenCalledTimes(1);
  });

  it('preserves logical focus on asynchronous DOM replacement and leaves repeated refreshes stable', () => {
    const { navigation, items, makeElement, last } = fixture();
    navigation.setContext('lobby', items);
    navigation.handle('down');
    navigation.handle('down');
    const replacement = makeElement();
    const nextItems = [
      ...items.slice(0, 2),
      { id: 'audio', element: replacement as unknown as HTMLElement },
    ];
    navigation.setContext('lobby', nextItems);
    expect(navigation.selectedId).toBe('audio');
    expect(last.classList.contains('gamepad-focus')).toBe(false);
    expect(replacement.classList.contains('gamepad-focus')).toBe(true);
    expect(replacement.focus).toHaveBeenCalledTimes(1);
    expect(replacement.scrollIntoView).toHaveBeenCalledTimes(1);
    navigation.setContext('lobby', nextItems);
    expect(replacement.focus).toHaveBeenCalledTimes(1);
    expect(replacement.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('does not steal focus from browser profile editing and focuses a waiting control when enabled', () => {
    const { navigation, items, doc, first } = fixture();
    first.disabled = true;
    navigation.setContext('lobby', items);
    expect(first.focus).not.toHaveBeenCalled();
    first.disabled = false;
    navigation.setContext('lobby', items);
    expect(first.focus).toHaveBeenCalledTimes(1);
    const profileInput = {};
    doc.activeElement = profileInput;
    navigation.setContext('lobby', items);
    expect(doc.activeElement).toBe(profileInput);
    expect(first.focus).toHaveBeenCalledTimes(1);
  });

  it('replaces covered targets, returns to a preferred item and resets if a logical item disappears', () => {
    const { navigation, items, first, last } = fixture();
    navigation.setContext('menu', items);
    navigation.setContext('confirmation', [
      { id: 'stay', element: last as unknown as HTMLElement },
    ]);
    navigation.handle('a');
    expect(last.click).toHaveBeenCalledTimes(1);
    expect(first.click).not.toHaveBeenCalled();
    navigation.setContext('menu', items, 'audio');
    expect(navigation.selectedId).toBe('audio');
    navigation.setContext('menu', items.slice(0, 2));
    expect(navigation.selectedId).toBe('join');
    navigation.clear();
    expect(first.classList.contains('gamepad-focus')).toBe(false);
    expect(navigation.handle('a')).toBe(false);
  });

  it('adjusts only the explicit directional setting and never opens a native select on A', () => {
    const { navigation, first } = fixture();
    const adjust = vi.fn();
    const activate = vi.fn();
    navigation.setContext('menu', [
      { id: 'quality', element: first as unknown as HTMLElement, adjust, activate },
    ]);
    navigation.handle('left');
    navigation.handle('right');
    navigation.handle('a');
    expect(adjust.mock.calls).toEqual([[-1], [1]]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(first.click).not.toHaveBeenCalled();
  });
});
