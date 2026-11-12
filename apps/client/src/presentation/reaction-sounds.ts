import { findReaction } from '@su/contracts';
import type { DisplayPlayer } from './display-state';

type SeenReaction = { identity: string; sequence: number; frame: number };

/** A sticker snapshot is not an event: only fresh sequence changes in a continuous view sound. */
export class ReactionSoundGate {
  private readonly seen = new Map<string, SeenReaction>();
  private frame = 0;
  private baselineNextFrame = true;

  suspend(): void {
    this.baselineNextFrame = true;
  }

  update(players: readonly DisplayPlayer[], audible: boolean): ReadonlySet<string> {
    const frame = ++this.frame;
    const sounds = new Set<string>();
    for (const player of players) {
      const identity = `${player.animation?.worldEpoch ?? ''}/${player.revision}/${player.motionRevision}/${player.connected !== false}`;
      const previous = this.seen.get(player.entityId);
      const sameIdentity = previous?.identity === identity;
      const active = player.reaction;
      const sequence =
        active && Number.isSafeInteger(active.sequence) && active.sequence >= 0
          ? active.sequence
          : 0;
      if (
        audible &&
        !this.baselineNextFrame &&
        sameIdentity &&
        previous.frame === frame - 1 &&
        sequence > previous.sequence &&
        player.connected !== false &&
        active &&
        active.remainingMs > 0 &&
        findReaction(active.id)
      ) {
        sounds.add(player.entityId);
      }
      // Keep the high-water mark even after the sticker expires or its mesh disappears.
      this.seen.set(player.entityId, {
        identity,
        sequence: sameIdentity ? Math.max(previous.sequence, sequence) : sequence,
        frame,
      });
    }
    this.baselineNextFrame = false;
    // The room has eight players, but it can run through many sessions over time.
    if (this.seen.size > 256)
      for (const [id, history] of this.seen) if (history.frame !== frame) this.seen.delete(id);
    return sounds;
  }

  clear(): void {
    this.seen.clear();
    this.baselineNextFrame = true;
  }
}
