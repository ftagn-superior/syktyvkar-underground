import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEUTRAL_INPUT } from '@su/contracts';
import { GamepadInput, gamepadStick, type GamepadInputOptions } from './gamepad';

function pad(index = 0, mapping: GamepadMappingType = 'standard'): Gamepad {
  return {
    id: `Xbox ${index}`,
    index,
    connected: true,
    mapping,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 })),
    timestamp: 0,
    vibrationActuator: null,
  } as unknown as Gamepad;
}
function button(controller: Gamepad, index: number, value: number): void {
  (controller.buttons as GamepadButton[])[index] = {
    pressed: value >= 0.5,
    touched: value > 0,
    value,
  };
}
function axes(controller: Gamepad, leftX: number, leftY: number, rightX = 0, rightY = 0): void {
  (controller.axes as number[]).splice(0, 4, leftX, leftY, rightX, rightY);
}

describe('Gamepad API adapter', () => {
  let controllers: (Gamepad | null)[];
  let browserWindow: EventTarget;
  let browserDocument: EventTarget & { hidden: boolean; hasFocus: () => boolean };
  let read: ReturnType<typeof vi.fn>;
  let requestFrame: ReturnType<typeof vi.fn>;
  const instances: GamepadInput[] = [];
  beforeEach(() => {
    controllers = [];
    browserWindow = new EventTarget();
    browserDocument = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true });
    read = vi.fn(() => controllers);
    requestFrame = vi.fn(() => 17);
    vi.stubGlobal('window', browserWindow);
    vi.stubGlobal('document', browserDocument);
    vi.stubGlobal('navigator', { getGamepads: read });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });
  afterEach(() => {
    for (const instance of instances.splice(0)) instance.dispose();
    vi.unstubAllGlobals();
  });
  function input(overrides: Partial<GamepadInputOptions> = {}) {
    const callbacks = {
      canSelect: vi.fn(() => true),
      onSelected: vi.fn(),
      onDisconnected: vi.fn(),
      onInterrupted: vi.fn(),
      onPoll: vi.fn(),
      onStatus: vi.fn(),
    };
    const adapter = new GamepadInput({ ...callbacks, ...overrides });
    instances.push(adapter);
    return { adapter, ...callbacks };
  }
  function select(adapter: GamepadInput, controller: Gamepad, start = 0) {
    adapter.poll(start);
    button(controller, 0, 1);
    adapter.poll(start + 1);
    button(controller, 0, 0);
    adapter.poll(start + 2);
    adapter.poll(start + 102);
    expect(adapter.snapshot().ready).toBe(true);
  }

  it('does not select on connection or drift, selects a nonzero sparse index, and consumes A', () => {
    const controller = pad(3);
    controllers = [null, null, null, controller];
    axes(controller, 0.5, 0);
    const { adapter, onSelected, onPoll } = input();
    adapter.poll(0);
    expect(adapter.snapshot()).toMatchObject({ supportedCount: 1, activeIndex: null });
    expect(onSelected).not.toHaveBeenCalled();
    button(controller, 0, 1);
    adapter.poll(10);
    expect(onSelected).toHaveBeenCalledExactlyOnceWith(3);
    expect(adapter.snapshot()).toMatchObject({ activeIndex: 3, ready: false });
    expect(onPoll.mock.calls.some(([commands]) => commands.a)).toBe(false);
    adapter.poll(1000);
    expect(adapter.read(0)).toEqual(NEUTRAL_INPUT);
  });

  it('chooses the smallest index only when two controllers press A in the same poll', () => {
    const high = pad(7);
    const low = pad(2);
    controllers = [high, null, low];
    const { adapter, onSelected } = input();
    adapter.poll(0);
    button(high, 0, 1);
    button(low, 0, 1);
    adapter.poll(1);
    expect(onSelected).toHaveBeenCalledExactlyOnceWith(2);
    button(low, 0, 0);
    adapter.poll(2);
    adapter.poll(102);
    axes(high, 1, 1, 1, 1);
    adapter.poll(103);
    expect(adapter.read(0)).toEqual(NEUTRAL_INPUT);
    expect(adapter.cameraX).toBe(0);
  });

  it('selects an already connected controller on its first revealed A press', () => {
    const controller = pad();
    button(controller, 0, 1);
    controllers = [controller];
    const { adapter, onSelected } = input();
    adapter.poll(1);
    expect(onSelected).toHaveBeenCalledExactlyOnceWith(0);
    expect(adapter.snapshot().ready).toBe(false);
  });

  it('does not steal A from a field or background page, requiring a fresh press', () => {
    const controller = pad();
    controllers = [controller];
    const { adapter, canSelect, onSelected } = input();
    canSelect.mockReturnValue(false);
    adapter.poll(0);
    button(controller, 0, 1);
    adapter.poll(1);
    canSelect.mockReturnValue(true);
    adapter.poll(2);
    expect(onSelected).not.toHaveBeenCalled();
    button(controller, 0, 0);
    adapter.poll(3);
    browserDocument.hidden = true;
    button(controller, 0, 1);
    adapter.poll(4);
    browserDocument.hidden = false;
    adapter.poll(5);
    expect(onSelected).not.toHaveBeenCalled();
    button(controller, 0, 0);
    adapter.poll(6);
    button(controller, 0, 1);
    adapter.poll(7);
    expect(onSelected).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('requires all assigned controls neutral for 100 uninterrupted milliseconds', () => {
    const controller = pad();
    controllers = [controller];
    const { adapter } = input();
    button(controller, 0, 1);
    adapter.poll(0);
    button(controller, 0, 0);
    axes(controller, 0, 0, 0, 0.2);
    adapter.poll(1);
    adapter.poll(1000);
    expect(adapter.snapshot().ready).toBe(false);
    axes(controller, 0, 0);
    button(controller, 7, 0.11);
    adapter.poll(1001);
    adapter.poll(2000);
    expect(adapter.snapshot().ready).toBe(false);
    button(controller, 7, 0.1);
    adapter.poll(2001);
    adapter.poll(2100);
    expect(adapter.snapshot()).toMatchObject({ ready: false, neutral: true });
    button(controller, 3, 1);
    adapter.poll(2101);
    button(controller, 3, 0);
    adapter.poll(2102);
    adapter.poll(2201);
    expect(adapter.snapshot().ready).toBe(false);
    adapter.poll(2202);
    expect(adapter.snapshot().ready).toBe(true);
  });

  it('remaps continuous movement at the actual camera angle and applies RT hysteresis', () => {
    const controller = pad();
    controllers = [controller];
    const { adapter } = input();
    select(adapter, controller);
    axes(controller, 0, -0.59, 0.59, 0);
    adapter.poll(103);
    for (const angle of [0, Math.PI / 4, Math.PI / 2, -Math.PI]) {
      const movement = adapter.read(angle);
      expect(Math.hypot(movement.moveX, movement.moveZ)).toBeCloseTo(0.5);
      expect(movement.moveX).toBeCloseTo(-Math.cos(angle) * 0.5);
      expect(movement.moveZ).toBeCloseTo(-Math.sin(angle) * 0.5);
    }
    expect(adapter.cameraX).toBeCloseTo(0.5);
    for (const [value, sprint] of [
      [0.54, false],
      [0.55, true],
      [0.5, true],
      [0.46, true],
      [0.45, false],
      [0.5, false],
    ] as const) {
      button(controller, 7, value);
      adapter.poll(104);
      expect(adapter.read(0).sprint).toBe(sprint);
    }
    axes(controller, 0, 0, 1, 0);
    adapter.poll(105);
    expect(adapter.read(0).moveX).toBe(0);
    expect(adapter.cameraX).toBe(1);
    axes(controller, 1, -1, 0, 0);
    adapter.poll(106);
    expect(Math.hypot(adapter.read(0).moveX, adapter.read(0).moveZ)).toBeCloseTo(1);
    expect(adapter.cameraX).toBe(0);
  });

  it('emits one edge for A/B/Y, while movement and diagnostics never consume commands', () => {
    const controller = pad();
    controllers = [controller];
    const { adapter, onPoll } = input();
    select(adapter, controller);
    onPoll.mockClear();
    for (const index of [0, 1, 3]) button(controller, index, 1);
    adapter.poll(103);
    expect(onPoll.mock.lastCall?.[0]).toMatchObject({ a: true, b: true, y: true });
    for (let i = 0; i < 5; i++) {
      adapter.snapshot();
      adapter.read(0);
      void adapter.cameraX;
    }
    expect(onPoll).toHaveBeenCalledTimes(1);
    adapter.poll(1000);
    expect(onPoll.mock.lastCall?.[0]).toMatchObject({ a: false, b: false, y: false });
    for (const index of [0, 1, 3]) button(controller, index, 0);
    adapter.poll(1001);
    button(controller, 0, 1);
    adapter.poll(1002);
    expect(onPoll.mock.lastCall?.[0].a).toBe(true);
  });

  it('repeats the dpad at 350/120ms with one step after a long frame and no diagonal commands', () => {
    const controller = pad();
    controllers = [controller];
    const { adapter, onPoll } = input();
    select(adapter, controller);
    button(controller, 13, 1);
    adapter.poll(103);
    expect(onPoll.mock.lastCall?.[0].down).toBe(true);
    adapter.poll(452);
    expect(onPoll.mock.lastCall?.[0].down).toBe(false);
    adapter.poll(453);
    expect(onPoll.mock.lastCall?.[0].down).toBe(true);
    adapter.poll(572);
    expect(onPoll.mock.lastCall?.[0].down).toBe(false);
    adapter.poll(573);
    expect(onPoll.mock.lastCall?.[0].down).toBe(true);
    adapter.poll(5000);
    expect(onPoll.mock.lastCall?.[0].down).toBe(true);
    adapter.poll(5001);
    expect(onPoll.mock.lastCall?.[0].down).toBe(false);
    button(controller, 15, 1);
    adapter.poll(5002);
    expect(onPoll.mock.lastCall?.[0]).toMatchObject({ down: false, right: false });
    button(controller, 13, 0);
    adapter.poll(5003);
    expect(onPoll.mock.lastCall?.[0].right).toBe(true);
    button(controller, 14, 1);
    adapter.poll(5004);
    expect(onPoll.mock.lastCall?.[0]).toMatchObject({ left: false, right: false });
  });

  it('resets every command and held repeat until neutral after a context transition', () => {
    const controller = pad();
    controllers = [controller];
    const { adapter, onPoll } = input();
    select(adapter, controller);
    axes(controller, 1, -1, 1, 0);
    button(controller, 7, 1);
    button(controller, 3, 1);
    adapter.poll(103);
    adapter.reset();
    adapter.reset();
    expect(adapter.read(0)).toEqual(NEUTRAL_INPUT);
    expect(adapter.cameraX).toBe(0);
    adapter.poll(1000);
    expect(onPoll.mock.lastCall?.[0].y).toBe(false);
    expect(adapter.snapshot().ready).toBe(false);
    axes(controller, 0, 0);
    button(controller, 7, 0);
    button(controller, 3, 0);
    adapter.poll(1001);
    adapter.poll(1101);
    expect(adapter.snapshot().ready).toBe(true);
    expect(adapter.read(0)).toEqual(NEUTRAL_INPUT);
    button(controller, 3, 1);
    adapter.poll(1102);
    expect(onPoll.mock.lastCall?.[0].y).toBe(true);
  });

  it('disconnects immediately, does not reuse an index or held A, and requires explicit selection', () => {
    const controller = pad(4);
    controllers = [controller];
    const { adapter, onDisconnected, onSelected } = input();
    select(adapter, controller);
    axes(controller, 1, 0, 1, 0);
    adapter.poll(103);
    const event = Object.assign(new Event('gamepaddisconnected'), { gamepad: controller });
    browserWindow.dispatchEvent(event);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot().activeIndex).toBeNull();
    expect(adapter.read(0)).toEqual(NEUTRAL_INPUT);
    const replacement = pad(4);
    button(replacement, 0, 1);
    controllers = [replacement];
    adapter.poll(104);
    adapter.poll(105);
    expect(onSelected).toHaveBeenCalledTimes(1);
    button(replacement, 0, 0);
    adapter.poll(106);
    button(replacement, 0, 1);
    adapter.poll(107);
    expect(onSelected).toHaveBeenCalledTimes(2);
    expect(adapter.snapshot().ready).toBe(false);
  });

  it('discovers disappearance from fresh polls even without a disconnect event', () => {
    const controller = pad();
    controllers = [controller];
    const { adapter, onDisconnected } = input();
    select(adapter, controller);
    controllers = [null];
    adapter.poll(103);
    adapter.poll(104);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot()).toMatchObject({
      supportedCount: 0,
      activeIndex: null,
      ready: false,
    });
  });

  it('rejects unsupported mappings, short layouts, and nonfinite data', () => {
    const unknown = pad(0, '');
    const short = pad(1);
    (short.axes as number[]).pop();
    controllers = [unknown, short];
    button(unknown, 0, 1);
    button(short, 0, 1);
    const { adapter, onSelected } = input();
    adapter.poll(0);
    expect(adapter.snapshot()).toMatchObject({ issue: 'unsupported', supportedCount: 0 });
    expect(onSelected).not.toHaveBeenCalled();
    const invalid = pad(2);
    axes(invalid, Number.NaN, 0);
    controllers = [invalid];
    button(invalid, 0, 1);
    adapter.poll(1);
    expect(adapter.snapshot()).toMatchObject({ issue: 'invalid-data', supportedCount: 0 });
    expect(onSelected).not.toHaveBeenCalled();
  });

  it('ignores invalid data from another controller while the selected controller stays valid', () => {
    const controller = pad(2);
    controllers = [controller];
    const { adapter, onPoll, onDisconnected } = input();
    select(adapter, controller);
    const other = pad(7);
    axes(other, Number.NaN, 0);
    button(other, 3, 1);
    controllers = [controller, other];
    axes(controller, 0, -0.59, 0.59, 0);
    button(controller, 0, 1);
    adapter.poll(103);
    expect(adapter.snapshot()).toMatchObject({
      activeIndex: 2,
      supportedCount: 1,
      ready: true,
      issue: null,
    });
    expect(Math.hypot(adapter.read(0).moveX, adapter.read(0).moveZ)).toBeCloseTo(0.5);
    expect(adapter.cameraX).toBeCloseTo(0.5);
    expect(onPoll.mock.lastCall?.[0]).toMatchObject({ a: true, y: false });
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('handles an absent or throwing API, publishes stable status once, and recovers explicitly', () => {
    vi.stubGlobal('navigator', {});
    const { adapter, onStatus, onDisconnected } = input();
    adapter.poll(0);
    adapter.poll(1);
    expect(adapter.snapshot()).toMatchObject({ apiAvailable: false, issue: 'unavailable' });
    expect(onStatus).toHaveBeenCalledTimes(1);
    vi.stubGlobal('navigator', { getGamepads: read });
    const controller = pad();
    controllers = [controller];
    select(adapter, controller, 10);
    read.mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    adapter.poll(113);
    const statusCount = onStatus.mock.calls.length;
    adapter.poll(114);
    expect(onStatus).toHaveBeenCalledTimes(statusCount);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot()).toMatchObject({
      issue: 'api-error',
      activeIndex: null,
      ready: false,
    });
    read.mockImplementation(() => controllers);
    button(controller, 0, 1);
    adapter.poll(115);
    expect(adapter.snapshot().activeIndex).toBeNull();
    button(controller, 0, 0);
    adapter.poll(116);
    button(controller, 0, 1);
    adapter.poll(117);
    expect(adapter.snapshot().activeIndex).toBe(0);
  });

  it('suppresses all input on blur/visibility, resets on resize, and disposes on pagehide', () => {
    const controller = pad();
    controllers = [controller];
    const { adapter, onInterrupted, onPoll } = input();
    select(adapter, controller);
    axes(controller, 1, 0, 1, 0);
    adapter.poll(103);
    browserWindow.dispatchEvent(new Event('blur'));
    expect(onInterrupted).toHaveBeenLastCalledWith('blur');
    expect(adapter.read(0)).toEqual(NEUTRAL_INPUT);
    button(controller, 3, 1);
    adapter.poll(104);
    expect(onPoll.mock.lastCall?.[0].y).toBe(false);
    browserWindow.dispatchEvent(new Event('focus'));
    adapter.poll(1000);
    expect(adapter.snapshot().ready).toBe(false);
    axes(controller, 0, 0);
    button(controller, 3, 0);
    adapter.poll(1001);
    adapter.poll(1101);
    browserWindow.dispatchEvent(new Event('resize'));
    expect(onInterrupted).toHaveBeenLastCalledWith('resize');
    expect(adapter.snapshot().ready).toBe(false);
    browserDocument.hidden = true;
    browserDocument.dispatchEvent(new Event('visibilitychange'));
    expect(onInterrupted).toHaveBeenLastCalledWith('hidden');
    adapter.start();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    browserWindow.dispatchEvent(new Event('pagehide'));
    expect(onInterrupted).toHaveBeenLastCalledWith('pagehide');
    expect(cancelAnimationFrame).toHaveBeenCalledWith(17);
    expect(adapter.snapshot()).toMatchObject({ activeIndex: null, pageActive: false });
    const calls = onPoll.mock.calls.length;
    adapter.poll(2000);
    adapter.start();
    expect(onPoll).toHaveBeenCalledTimes(calls);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    onInterrupted.mockClear();
    browserWindow.dispatchEvent(new Event('blur'));
    expect(onInterrupted).not.toHaveBeenCalled();
  });

  it('runs exactly one independent RAF chain and never polls from read methods', () => {
    const { adapter } = input();
    adapter.start();
    adapter.start();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    const tick = requestFrame.mock.calls[0][0] as FrameRequestCallback;
    tick(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(requestFrame).toHaveBeenCalledTimes(2);
    adapter.read(0);
    adapter.snapshot();
    void adapter.cameraX;
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('gamepad radial stick', () => {
  it('has a continuous 0.18 deadzone and preserves speed and direction on diagonals', () => {
    expect(gamepadStick(0, 0)).toEqual({ x: 0, y: 0 });
    expect(gamepadStick(0.18, 0)).toEqual({ x: 0, y: 0 });
    expect(gamepadStick(0.1, 0.1)).toEqual({ x: 0, y: 0 });
    expect(gamepadStick(0.180001, 0).x).toBeLessThan(0.00001);
    expect(gamepadStick(0.59, 0).x).toBeCloseTo(0.5);
    for (const value of [1, 2, 100]) {
      const result = gamepadStick(value, -value);
      expect(Math.hypot(result.x, result.y)).toBeCloseTo(1);
      expect(result.x).toBeCloseTo(-result.y);
    }
    expect(gamepadStick(Number.NaN, 1)).toEqual({ x: 0, y: 0 });
  });
});
