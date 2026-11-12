import type { WorldSoundEvent } from '@su/contracts';

export type PhysicsImpact = Pick<
  WorldSoundEvent,
  'entityId' | 'typeId' | 'position' | 'strength' | 'actorId'
>;
const MAX_EVENTS = 32;
const MAX_PAIRS = 2048;
const COOLDOWN_SECONDS = 0.2;

/** A tick may contain several contacts for the same pair. Keep its strongest audible hit. */
export class ImpactCollector {
  private time = 0;
  private readonly candidates = new Map<string, PhysicsImpact>();
  private readonly cooldowns = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();
  private readonly contacts = new Map<string, number>();
  private pending: PhysicsImpact[] = [];

  beginStep(dt: number): void {
    this.time += dt;
    this.candidates.clear();
    for (const [key, until] of this.cooldowns) if (until <= this.time) this.cooldowns.delete(key);
    for (const [id, until] of this.suppressed) if (until <= this.time) this.suppressed.delete(id);
    for (const [pair, last] of this.contacts)
      if (this.time - last > 0.35) this.contacts.delete(pair);
  }
  record(
    pair: string,
    impact: Omit<PhysicsImpact, 'strength'>,
    impulse: number,
    closingSpeed: number,
    onsetOnly = false,
  ): void {
    if (onsetOnly) {
      const ongoing = this.contacts.has(pair);
      if (this.contacts.size >= MAX_PAIRS) this.contacts.delete(this.contacts.keys().next().value!);
      this.contacts.set(pair, this.time);
      if (ongoing) return;
    }
    // Support force while resting is not an impact; velocity also rejects sliding/pushing noise.
    if (
      !Number.isFinite(impulse) ||
      !Number.isFinite(closingSpeed) ||
      impulse < 0.5 ||
      closingSpeed < 0.65 ||
      this.suppressed.has(impact.entityId) ||
      this.cooldowns.has(pair)
    )
      return;
    const strength = Math.min(1, Math.sqrt(impulse / 24) * Math.min(1, closingSpeed / 3));
    if (strength < 0.06) return;
    const previous = this.candidates.get(pair);
    if (
      (!previous && this.candidates.size >= MAX_EVENTS) ||
      (previous && previous.strength >= strength)
    )
      return;
    this.candidates.set(pair, { ...impact, position: { ...impact.position }, strength });
  }
  endStep(): void {
    for (const [pair, event] of this.candidates) {
      if (this.pending.length < MAX_EVENTS) this.pending.push(event);
      if (this.cooldowns.size >= MAX_PAIRS)
        this.cooldowns.delete(this.cooldowns.keys().next().value!);
      this.cooldowns.set(pair, this.time + COOLDOWN_SECONDS);
    }
    this.candidates.clear();
  }
  drain(): PhysicsImpact[] {
    const result = this.pending;
    this.pending = [];
    return result;
  }
  suppress(entityId: string, seconds = 0.25): void {
    if (this.suppressed.size >= MAX_PAIRS)
      this.suppressed.delete(this.suppressed.keys().next().value!);
    this.suppressed.set(entityId, this.time + Math.max(0, seconds));
    this.pending = this.pending.filter((event) => event.entityId !== entityId);
    for (const [pair, event] of this.candidates)
      if (event.entityId === entityId) this.candidates.delete(pair);
  }
  clear(preserveSuppression = false): void {
    this.pending = [];
    this.candidates.clear();
    this.cooldowns.clear();
    this.contacts.clear();
    if (!preserveSuppression) this.suppressed.clear();
  }
}
