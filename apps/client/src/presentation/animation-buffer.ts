import { findAnimation, TICK_RATE, type AnimationPlayback } from '@su/contracts';
import type { DisplayAnimation } from './display-state';

export const REMOTE_INTERPOLATION_MS = 100;
const TICK_MS = 1000 / TICK_RATE;
interface Snapshot {
  time: number;
  tick: number;
  grounded: boolean;
  paused: boolean;
}
interface Transition {
  time: number;
  playback: AnimationPlayback;
}
export interface AnimationSource {
  entityId: string;
  revision: number;
  grounded: boolean;
  animationId: string;
  animationSequence: number;
  animationStartedAtTick: number;
  animationEndsAtTick: number;
  animationChangedAtTick: number;
}

/** Discrete visual state on the same server-clock timeline as Predict's positions. */
export class AnimationBuffer {
  private readonly entities = new Map<
    string,
    {
      identity: string;
      epoch: string;
      snapshots: Snapshot[];
      transitions: Transition[];
    }
  >();

  capture(
    epoch: string,
    tick: number,
    time: number,
    players: Iterable<AnimationSource>,
    paused: boolean,
  ): void {
    const live = new Set<string>();
    for (const player of players) {
      live.add(player.entityId);
      const identity = `${epoch}/${player.entityId}/${player.revision}`;
      let history = this.entities.get(player.entityId);
      const playback: AnimationPlayback = {
        animationId: findAnimation(player.animationId)?.id ?? null,
        sequence: player.animationSequence,
        startedAtTick: player.animationStartedAtTick,
        endsAtTick: player.animationEndsAtTick,
        changedAtTick: player.animationChangedAtTick,
      };
      if (!history || history.identity !== identity) {
        history = { identity, epoch, snapshots: [], transitions: [{ time: -Infinity, playback }] };
        this.entities.set(player.entityId, history);
      } else {
        const previous = history.transitions.at(-1)!.playback;
        if (
          previous.sequence !== playback.sequence ||
          previous.animationId !== playback.animationId
        ) {
          const effectiveTime = time - Math.max(0, tick - playback.changedAtTick) * TICK_MS;
          history.transitions.push({
            time: Math.max(history.transitions.at(-1)!.time, effectiveTime),
            playback,
          });
        }
      }
      history.snapshots.push({ time, tick, grounded: player.grounded, paused });
      // Keep a predecessor around a generous interpolation window, with hard count bounds.
      while (
        history.snapshots.length > 2 &&
        (history.snapshots[1].time < time - 2000 || history.snapshots.length > 64)
      )
        history.snapshots.shift();
      while (
        history.transitions.length > 1 &&
        (history.transitions[1].time < time - 2000 || history.transitions.length > 64)
      )
        history.transitions.shift();
    }
    for (const id of this.entities.keys()) if (!live.has(id)) this.entities.delete(id);
  }

  sample(
    entityId: string,
    time: number,
  ): { grounded: boolean; animation: DisplayAnimation } | undefined {
    const history = this.entities.get(entityId);
    if (!history) return;
    const samples = history.snapshots;
    let previous = samples[0];
    let next: Snapshot | undefined;
    for (const sample of samples) {
      if (sample.time <= time) previous = sample;
      else {
        next = sample;
        break;
      }
    }
    const tick =
      next && next.time > previous.time
        ? previous.tick +
          (next.tick - previous.tick) *
            Math.max(0, (time - previous.time) / (next.time - previous.time))
        : previous.tick + (previous.paused ? 0 : Math.max(0, time - previous.time) / TICK_MS);
    let playback = history.transitions[0].playback;
    for (const transition of history.transitions) {
      if (transition.time > time) break;
      playback = transition.playback;
    }
    return {
      grounded: previous.grounded,
      animation: { ...playback, worldEpoch: history.epoch, displayTick: tick, displayTimeMs: time },
    };
  }

  clear(): void {
    this.entities.clear();
  }
  get size(): number {
    return this.entities.size;
  }
}
