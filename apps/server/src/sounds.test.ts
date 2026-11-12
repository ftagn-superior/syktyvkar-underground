import { describe, expect, it, vi } from 'vitest';
import { parseWorldSoundEvent, type WorldSoundEvent } from '@su/contracts';
import { deliverWorldSound } from './sounds.js';
import { WorldRoom } from './world-room.js';
import { PlayerSchema, WorldState } from '@su/protocol';

const event: WorldSoundEvent = {
  worldEpoch: 'epoch',
  eventId: 'epoch:1',
  serverTick: 123,
  kind: 'place',
  position: { x: 1, y: 2, z: 3 },
  typeId: 'wooden-crate',
  entityId: 'crate',
  actorId: 'actor-session',
  operationId: 'operation',
  strength: 1,
};

describe('transient world sound delivery', () => {
  it('the room assigns unique IDs and maps actor entity IDs to sessions without sending to preparing players', () => {
    // Exercise the actual room publication method without starting a server or changing a database.
    const room = Object.create(WorldRoom.prototype) as WorldRoom;
    const state = new WorldState();
    state.worldEpoch = 'epoch';
    state.serverTick = 123;
    const player = new PlayerSchema();
    player.entityId = 'actor-entity';
    player.x = 1;
    player.y = 2;
    player.z = 3;
    state.players.set('actor-session', player);
    state.players.set('preparing', player);
    const send = vi.fn(),
      preparing = vi.fn();
    Object.defineProperty(room, 'state', { value: state });
    Object.assign(room, {
      soundSequence: 0,
      sessions: new Map([
        ['actor-session', { entityId: 'actor-entity', connected: true }],
        ['preparing', { entityId: 'other-entity', connected: true, plan: {} }],
      ]),
      clients: [
        { sessionId: 'actor-session', send },
        { sessionId: 'preparing', send: preparing },
      ],
    });
    const publish = (
      room as unknown as {
        publishWorldSound: (
          sound: Omit<WorldSoundEvent, 'worldEpoch' | 'eventId' | 'serverTick'>,
        ) => void;
      }
    ).publishWorldSound.bind(room);
    publish({ ...event, actorId: 'actor-entity' });
    publish({ ...event, actorId: 'actor-entity' });
    expect(send.mock.calls[0]).toEqual(['worldSound', { ...event, eventId: 'epoch:1' }]);
    expect(send.mock.calls[1][1].eventId).toBe('epoch:2');
    expect(preparing).not.toHaveBeenCalled();
  });
  it('sends intact metadata to connected spawned clients inside the inclusive 40m radius', () => {
    const sends = Array.from({ length: 6 }, () => vi.fn());
    deliverWorldSound(event, [
      { connected: true, position: event.position, send: sends[0] },
      { connected: true, position: { x: 41, y: 2, z: 3 }, send: sends[1] },
      { connected: true, position: { x: 41.01, y: 2, z: 3 }, send: sends[2] },
      { connected: false, position: event.position, send: sends[3] },
      { connected: true, send: sends[4] },
      { connected: true, position: { x: 1, y: 42.01, z: 3 }, send: sends[5] },
    ]);
    expect(sends[0]).toHaveBeenCalledExactlyOnceWith(event);
    expect(sends[1]).toHaveBeenCalledExactlyOnceWith(event);
    for (const send of sends.slice(2)) expect(send).not.toHaveBeenCalled();
  });
  it('keeps a disconnect during delivery from breaking other recipients or persistence', () => {
    const send = vi.fn();
    expect(() =>
      deliverWorldSound(event, [
        {
          connected: true,
          position: event.position,
          send: () => {
            throw new Error('closed');
          },
        },
        { connected: true, position: event.position, send },
      ]),
    ).not.toThrow();
    expect(send).toHaveBeenCalledExactlyOnceWith(event);
  });
  it('rejects malformed positions, identities, kinds and non-normalized strengths', () => {
    expect(parseWorldSoundEvent(event)).toEqual(event);
    for (const patch of [
      { strength: Infinity },
      { strength: -0.1 },
      { strength: 1.1 },
      { serverTick: -1 },
      { position: { x: NaN, y: 0, z: 0 } },
      { actorId: 42 },
      { kind: 'music' },
      { eventId: '' },
    ])
      expect(parseWorldSoundEvent({ ...event, ...patch })).toBeUndefined();
  });
});
