import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StaticRemovalEffect } from '@su/contracts';
import type { GameSession } from '../network/session';
import type { WorldView } from '../rendering/world-view';
import { StaticRemoval } from './static-removal';

class Element extends EventTarget {
  id = '';
  hidden = false;
  disabled = false;
  textContent = '';
  className = '';
  type = '';
  innerHTML = '';
  children: unknown[] = [];
  focus = vi.fn();
  remove = vi.fn();
  setAttribute = vi.fn();
  append(...children: unknown[]) {
    this.children.push(...children);
  }
}
function fire(target: EventTarget, type: string, fields: Record<string, unknown> = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), fields);
  target.dispatchEvent(event);
  return event;
}
const publication = {
  worldEpoch: 'epoch',
  assetReleaseVersion: 'a'.repeat(64),
  layoutRevision: 10,
  layoutHash: 'b'.repeat(64),
  mapVersion: 'c'.repeat(64),
  simulationConfigHash: 'd'.repeat(64),
  manifestUrl: '/manifest.json',
};
const effect: StaticRemovalEffect = {
  kind: 'staticRemoval',
  publication,
  protectedEntityIds: ['ground'],
  modelNames: { building: 'Дом' },
};
const activeTools: StaticRemoval[] = [];
function fixture() {
  const elements: Element[] = [];
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    body: new Element(),
    hasFocus: () => true,
    getElementById: () => undefined,
    createElement: () => {
      const element = new Element();
      elements.push(element);
      return element;
    },
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  const canvas = new Element();
  const objects = new Map([
    [
      'house',
      {
        entityId: 'house',
        assetId: 'building',
        position: { x: 0, y: 0, z: 0 },
        minimum: { x: -5, y: 0, z: -5 },
        maximum: { x: 5, y: 10, z: 5 },
      },
    ],
  ]);
  const view = {
    pickStaticObject: vi.fn(() => objects.get('house')),
    getStaticObject: vi.fn((id: string) => objects.get(id)),
    highlightStaticObject: vi.fn(),
  };
  const session = {
    state: 'playing',
    worldPaused: false,
    staticRemovalPending: false,
    staticPlacementPending: false,
    info: { layoutRevision: 10 },
    removeStatic: vi.fn(() => {
      session.staticRemovalPending = true;
      return true;
    }),
  };
  let available = true;
  const mode = vi.fn();
  const tool = new StaticRemoval(
    session as unknown as GameSession,
    canvas as unknown as HTMLCanvasElement,
    () => view as unknown as WorldView,
    mode,
    () => available,
  );
  const confirm = elements.find((element) => element.id === 'static-removal-confirm')!;
  const panel = elements.find((element) => element.id === 'static-removal')!;
  const status = elements.find((element) => element.className === 'place-status')!;
  const clickCanvas = () => {
    fire(win, 'pointerdown', { button: 0 });
    fire(canvas, 'click', { button: 0, detail: 1 });
  };
  const clickConfirm = () => {
    fire(win, 'pointerdown', { button: 0 });
    fire(confirm, 'click', { button: 0, detail: 1 });
  };
  const f = {
    tool,
    mode,
    session,
    win,
    doc,
    canvas,
    confirm,
    panel,
    status,
    view,
    objects,
    clickCanvas,
    clickConfirm,
    unavailable() {
      available = false;
    },
  };
  activeTools.push(tool);
  return f;
}
afterEach(() => {
  for (const tool of activeTools.splice(0)) tool.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('static removal confirmation', () => {
  it('selects a complete instance, requires a separate deliberate confirmation and sends once while pending', () => {
    const f = fixture();
    f.tool.open(effect);
    f.clickCanvas();
    expect(f.tool.diagnostics().selected).toBe('house');
    expect(f.view.pickStaticObject).toHaveBeenCalledWith(new Set(['ground']));
    expect(f.view.highlightStaticObject).toHaveBeenLastCalledWith('house');
    expect(f.confirm.disabled).toBe(false);
    expect(f.session.removeStatic).not.toHaveBeenCalled();
    fire(f.confirm, 'click', { detail: 0 });
    expect(f.session.removeStatic).not.toHaveBeenCalled();
    f.clickConfirm();
    f.clickConfirm();
    expect(f.session.removeStatic).toHaveBeenCalledExactlyOnceWith('house', publication);
    expect(f.confirm.disabled).toBe(true);
    fire(f.win, 'keydown', { code: 'Escape', repeat: false });
    expect(f.tool.active).toBe(false);
    expect(f.panel.hidden).toBe(true);
    expect(f.mode).toHaveBeenLastCalledWith(false);
    expect(f.view.highlightStaticObject).toHaveBeenLastCalledWith();
    expect(f.canvas.focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(f.session.staticRemovalPending).toBe(true);
  });

  it('ignores right clicks and stale input after blur, then requires a fresh selection', () => {
    const f = fixture();
    f.tool.open(effect);
    fire(f.win, 'pointerdown', { button: 2 });
    fire(f.canvas, 'click', { button: 2, detail: 1 });
    expect(f.tool.diagnostics().selected).toBeUndefined();
    f.clickCanvas();
    fire(f.win, 'pointerdown', { button: 0 });
    fire(f.win, 'blur');
    fire(f.win, 'focus');
    fire(f.confirm, 'click', { button: 0, detail: 1 });
    expect(f.session.removeStatic).not.toHaveBeenCalled();
    expect(f.tool.diagnostics().selected).toBeUndefined();
    expect(f.confirm.disabled).toBe(true);
    f.clickCanvas();
    f.clickConfirm();
    expect(f.session.removeStatic).toHaveBeenCalledOnce();
  });

  it('requires fresh keyboard activation and rejects repeated activation', () => {
    const f = fixture();
    f.tool.open(effect);
    f.clickCanvas();
    expect(fire(f.confirm, 'keydown', { code: 'Enter', repeat: true }).defaultPrevented).toBe(true);
    fire(f.confirm, 'click', { detail: 0 });
    expect(f.session.removeStatic).not.toHaveBeenCalled();
    fire(f.confirm, 'keydown', { code: 'Enter', repeat: false });
    fire(f.confirm, 'click', { detail: 0 });
    fire(f.confirm, 'keyup', { code: 'Enter' });
    expect(f.session.removeStatic).toHaveBeenCalledOnce();
  });

  it('invalidates selection when the instance unloads or the publication changes', () => {
    const f = fixture();
    f.tool.open(effect);
    f.clickCanvas();
    f.objects.delete('house');
    f.tool.frame();
    expect(f.tool.diagnostics().selected).toBeUndefined();
    expect(f.confirm.disabled).toBe(true);
    f.session.info.layoutRevision++;
    f.tool.frame();
    expect(f.tool.active).toBe(false);
    expect(f.panel.hidden).toBe(true);
    expect(f.mode).toHaveBeenLastCalledWith(false);
  });

  it('rechecks the selected instance at confirmation if it unloads between animation frames', () => {
    const f = fixture();
    f.tool.open(effect);
    f.clickCanvas();
    expect(f.confirm.disabled).toBe(false);
    f.objects.delete('house');
    // Deliberately skip frame(): the instance was released just before this click.
    f.clickConfirm();
    expect(f.session.removeStatic).not.toHaveBeenCalled();
    expect(f.tool.diagnostics().selected).toBeUndefined();
    expect(f.confirm.disabled).toBe(true);
  });

  it('blocks writes and closes the tool when touch or graphics loss makes it unavailable', () => {
    const f = fixture();
    f.tool.open(effect);
    f.clickCanvas();
    f.unavailable();
    f.clickConfirm();
    expect(f.session.removeStatic).not.toHaveBeenCalled();
    f.tool.frame();
    expect(f.tool.active).toBe(false);
    expect(f.view.highlightStaticObject).toHaveBeenLastCalledWith();
  });

  it('does not open alongside either sent static operation', () => {
    const f = fixture();
    f.session.staticPlacementPending = true;
    f.tool.open(effect);
    expect(f.tool.active).toBe(false);
    f.session.staticPlacementPending = false;
    f.session.staticRemovalPending = true;
    f.tool.open(effect);
    expect(f.tool.active).toBe(false);
    expect(f.mode).not.toHaveBeenCalled();
  });

  it('keeps the sent request pending when the tool is closed and another panel opens', () => {
    const f = fixture();
    f.tool.open(effect);
    f.clickCanvas();
    f.clickConfirm();
    f.tool.close();
    f.tool.frame();
    f.tool.open(effect);
    expect(f.tool.active).toBe(false);
    expect(f.session.staticRemovalPending).toBe(true);
    expect(f.session.removeStatic).toHaveBeenCalledOnce();
    expect(f.view.highlightStaticObject).toHaveBeenLastCalledWith();
  });

  it('caps hover picking at 20 Hz while keeping explicit clicks exact and locked selection stable', () => {
    const f = fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    f.tool.open(effect);
    f.tool.frame();
    expect(f.view.pickStaticObject).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(110);
    f.tool.frame();
    expect(f.view.pickStaticObject).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(150);
    f.tool.frame();
    expect(f.view.pickStaticObject).toHaveBeenCalledTimes(2);
    f.clickCanvas();
    expect(f.view.pickStaticObject).toHaveBeenCalledTimes(3);
    clock.mockReturnValue(300);
    f.tool.frame();
    expect(f.view.pickStaticObject).toHaveBeenCalledTimes(3);
    expect(f.tool.diagnostics().selected).toBe('house');
  });
});
