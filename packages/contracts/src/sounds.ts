import type { Vec3 } from './index.js';

/** Transient presentation event, never part of saved world state or replayed input. */
export interface WorldSoundEvent {
  worldEpoch: string;
  eventId: string;
  serverTick: number;
  kind: 'place' | 'pickup' | 'impact';
  position: Vec3;
  typeId: string;
  entityId: string;
  /** Colyseus session ID of the initiating player, when there is one. */
  actorId?: string;
  operationId?: string;
  /** Presentation strength, normalized to [0, 1], not a physical impulse. */
  strength: number;
}

export function parseWorldSoundEvent(value: unknown): WorldSoundEvent | undefined {
  if (!value || typeof value !== 'object') return;
  const event = value as WorldSoundEvent;
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 160;
  if (
    !id(event.worldEpoch) ||
    !id(event.eventId) ||
    !id(event.typeId) ||
    !id(event.entityId) ||
    !['place', 'pickup', 'impact'].includes(event.kind) ||
    !Number.isSafeInteger(event.serverTick) ||
    event.serverTick < 0 ||
    !Number.isFinite(event.strength) ||
    event.strength < 0 ||
    event.strength > 1 ||
    !event.position ||
    ![event.position.x, event.position.y, event.position.z].every(Number.isFinite) ||
    (event.actorId !== undefined && !id(event.actorId)) ||
    (event.operationId !== undefined && !id(event.operationId))
  )
    return;
  return event;
}
