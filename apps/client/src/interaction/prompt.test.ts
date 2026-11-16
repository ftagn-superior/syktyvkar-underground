import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTERACTION_KINDS, type Interactable } from './interactable';
import { InteractionSystem } from './prompt';

class Control extends EventTarget {
  hidden = false;
  isContentEditable = false;
  textContent = '';
  className = '';
  type = '';
  offsetWidth = 0;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Control[] = [];
  classList = { add: vi.fn(), remove: vi.fn() };
  constructor(private readonly tag = 'button') {
    super();
  }
  matches(selector: string): boolean {
    return selector.split(',').includes(this.tag);
  }
  append(...children: Control[]): void {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  remove = vi.fn();
}

function candidate(
  id: string,
  kind: keyof typeof INTERACTION_KINDS,
  distance: number,
): Interactable {
  return {
    id,
    kind,
    ...INTERACTION_KINDS[kind],
    objectName: id,
    getAnchor: () => ({ x: 0, y: 0, z: 0 }),
    getDistance: vi.fn(() => distance),
    onActivate: vi.fn(),
    setHighlighted: vi.fn(),
  };
}

function fixture() {
  const body = new Control('body');
  const win = new EventTarget();
  vi.stubGlobal('HTMLElement', Control);
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { body, createElement: (tag: string) => new Control(tag) });
  const pickup = candidate('box', 'pickup', 2);
  const stop = candidate('bus-stop', 'bus', 1);
  let candidates: Interactable[] = [stop, pickup];
  const host = {
    player: () => ({ x: 0, y: 0, z: 0 }),
    candidates: () => candidates,
    project: (_anchor: unknown, out: { visible: boolean }) => {
      out.visible = true;
    },
    enabled: vi.fn(() => true),
    keys: vi.fn(() => true),
  };
  const system = new InteractionSystem(host);
  system.tick(0);
  const button = body.children[0]!.children[0]!;
  const key = (code = 'Space', properties = {}, target?: Control) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), {
      code,
      repeat: false,
      ...properties,
    });
    if (target) Object.defineProperty(event, 'target', { value: target });
    win.dispatchEvent(event);
    return event;
  };
  return {
    system,
    host,
    pickup,
    stop,
    button,
    win,
    key,
    setCandidates: (next: Interactable[]) => {
      candidates = next;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('context interaction keyboard ownership', () => {
  it('activates exactly the displayed priority target and leaves Z unbound', () => {
    const f = fixture();
    expect(f.button.dataset.interactionId).toBe('box');
    expect(f.button.attributes['aria-keyshortcuts']).toBe('Space');
    expect(f.button.children[0]!.textContent).toBe('Пробел');
    expect(f.key('KeyZ').defaultPrevented).toBe(false);
    expect(f.pickup.onActivate).not.toHaveBeenCalled();
    expect(f.key().defaultPrevented).toBe(true);
    expect(f.pickup.onActivate).toHaveBeenCalledOnce();
    expect(f.stop.onActivate).not.toHaveBeenCalled();
    f.setCandidates([f.stop]);
    f.system.tick(100);
    expect(f.button.dataset.interactionId).toBe('bus-stop');
    expect(f.key('Space', { repeat: true }).defaultPrevented).toBe(true);
    expect(f.stop.onActivate).not.toHaveBeenCalled();
    f.win.dispatchEvent(Object.assign(new Event('keyup'), { code: 'Space' }));
    f.key();
    expect(f.stop.onActivate).toHaveBeenCalledOnce();
    f.system.dispose();
  });

  it('prevents scrolling with no nearby target, including repeated Space', () => {
    const f = fixture();
    f.setCandidates([]);
    f.system.tick(100);
    f.system.tick(300);
    expect(f.button.hidden).toBe(true);
    expect(f.key().defaultPrevented).toBe(true);
    expect(f.key('Space', { repeat: true }).defaultPrevented).toBe(true);
    expect(f.pickup.onActivate).not.toHaveBeenCalled();
    f.system.dispose();
  });

  it.each(['input', 'textarea', 'select', 'contenteditable'])('leaves Space to %s', (tag) => {
    const f = fixture();
    const target = new Control(tag);
    target.isContentEditable = tag === 'contenteditable';
    expect(f.key('Space', {}, target).defaultPrevented).toBe(false);
    expect(f.pickup.onActivate).not.toHaveBeenCalled();
    f.system.dispose();
  });

  it('checks panel and device ownership again between frames', () => {
    const f = fixture();
    f.host.enabled.mockReturnValue(false);
    expect(f.key().defaultPrevented).toBe(false);
    f.host.enabled.mockReturnValue(true);
    f.host.keys.mockReturnValue(false);
    expect(f.key().defaultPrevented).toBe(false);
    expect(f.pickup.onActivate).not.toHaveBeenCalled();
    f.system.dispose();
  });

  it('respects a consumed event and modifier shortcuts', () => {
    const f = fixture();
    const consumed = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Space' });
    consumed.preventDefault();
    f.win.dispatchEvent(consumed);
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'])
      expect(f.key('Space', { [modifier]: true }).defaultPrevented).toBe(false);
    expect(f.pickup.onActivate).not.toHaveBeenCalled();
    f.system.dispose();
  });

  it('does not activate a target that left range during the prompt hold', () => {
    const f = fixture();
    vi.mocked(f.pickup.getDistance).mockReturnValue(4);
    f.key();
    f.button.dispatchEvent(new Event('click'));
    expect(f.pickup.onActivate).not.toHaveBeenCalled();
    f.system.dispose();
  });
});
