import { parseWorldSoundEvent, TICK_RATE, type WorldSoundEvent } from '@su/contracts';
import { REMOTE_INTERPOLATION_MS } from './animation-buffer';

/** Transient events belong to this live connection, never to state/AOI reconstruction. */
export class WorldSoundEvents {
  private readonly seen = new Map<string, number>();
  private pending: { event: WorldSoundEvent; due: number; received: number }[] = [];

  receive(
    value: unknown,
    context: {
      epoch: string;
      serverTick: number;
      sessionId: string;
      now: number;
      active: boolean;
    },
  ): void {
    const event = parseWorldSoundEvent(value);
    if (!event || event.worldEpoch !== context.epoch) return;
    for (const [key, time] of this.seen) if (context.now - time > 60_000) this.seen.delete(key);
    const key = `${event.worldEpoch}/${event.eventId}`;
    if (this.seen.has(key)) return;
    this.seen.set(key, context.now);
    if (this.seen.size > 1024) this.seen.delete(this.seen.keys().next().value!);
    if (
      !context.active ||
      event.serverTick < context.serverTick - TICK_RATE ||
      event.serverTick > context.serverTick + TICK_RATE * 2
    )
      return;
    this.pending.push({
      event,
      received: context.now,
      due: context.now + (event.actorId === context.sessionId ? 0 : REMOTE_INTERPOLATION_MS),
    });
    if (this.pending.length > 64) this.pending.shift();
  }

  drain(now: number, active: boolean): WorldSoundEvent[] {
    if (!active) {
      this.suspend();
      return [];
    }
    const ready: WorldSoundEvent[] = [];
    this.pending = this.pending.filter((entry) => {
      if (now - entry.received > 500) return false;
      if (entry.due > now) return true;
      ready.push(entry.event);
      return false;
    });
    return ready;
  }

  suspend(): void {
    this.pending.length = 0;
  }
  clear(): void {
    this.suspend();
    this.seen.clear();
  }
}
