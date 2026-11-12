import { describe, expect, it } from 'vitest';
import type { WorldSoundEvent } from '@su/contracts';
import { WorldSoundEvents } from './world-sound-events';

const event: WorldSoundEvent = {
  worldEpoch: 'epoch',
  eventId: 'impact-1',
  serverTick: 100,
  kind: 'impact',
  entityId: 'box',
  typeId: 'wooden-crate',
  position: { x: 0, y: 0, z: 0 },
  strength: 0.8,
};
const context = { epoch: 'epoch', serverTick: 100, sessionId: 'self', now: 1000, active: true };
describe('transient world sound delivery', () => {
  it('aligns remote events with display interpolation and never repeats duplicates', () => {
    const queue = new WorldSoundEvents();
    queue.receive(event, context);
    queue.receive(event, context);
    expect(queue.drain(1050, true)).toEqual([]);
    expect(queue.drain(1100, true)).toEqual([event]);
    queue.receive(event, { ...context, now: 1200 });
    expect(queue.drain(1300, true)).toEqual([]);
  });
  it('plays an initiating player confirmation without the remote delay', () => {
    const queue = new WorldSoundEvents();
    const own = { ...event, actorId: 'self', kind: 'place' as const, operationId: 'op' };
    queue.receive(own, context);
    expect(queue.drain(1000, true)).toEqual([own]);
  });
  it('discards hidden, stale, wrong epoch and stalled-frame events', () => {
    const queue = new WorldSoundEvents();
    queue.receive(event, { ...context, active: false });
    queue.receive(event, context);
    queue.receive({ ...event, eventId: 'old', serverTick: 1 }, context);
    queue.receive({ ...event, eventId: 'elsewhere', worldEpoch: 'other' }, context);
    queue.receive({ ...event, eventId: 'late' }, context);
    expect(queue.drain(1600, true)).toEqual([]);
  });
  it('drops pending events on suspension and bounds bursts', () => {
    const queue = new WorldSoundEvents();
    queue.receive(event, context);
    expect(queue.drain(1001, false)).toEqual([]);
    expect(queue.drain(1200, true)).toEqual([]);
    for (let i = 0; i < 100; i++) queue.receive({ ...event, eventId: `burst-${i}` }, context);
    expect(queue.drain(1100, true)).toHaveLength(64);
    queue.clear();
    queue.receive(event, context);
    expect(queue.drain(1100, true)).toEqual([event]);
  });
});
