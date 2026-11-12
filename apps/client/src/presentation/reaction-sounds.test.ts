import { describe, expect, it } from 'vitest';
import type { DisplayPlayer } from './display-state';
import { ReactionSoundGate } from './reaction-sounds';

const player = (sequence?: number): DisplayPlayer => ({
  entityId: 'player',
  kind: 'player',
  skinId: 'standard',
  position: { x: 0, y: 1, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  velocity: { x: 0, y: 0, z: 0 },
  angularVelocity: { x: 0, y: 0, z: 0 },
  grounded: true,
  revision: 0,
  motionRevision: 0,
  motionEnabled: true,
  connected: true,
  reaction: sequence === undefined ? undefined : { id: 'hello', sequence, remainingMs: Infinity },
});

describe('reaction audio event gate', () => {
  it('plays a new selection once, while initial snapshots and repeated patches are silent', () => {
    const gate = new ReactionSoundGate();
    expect(gate.update([player(1)], true).size).toBe(0);
    expect(gate.update([player(1)], true).size).toBe(0);
    expect([...gate.update([player(2)], true)]).toEqual(['player']);
    expect(gate.update([player(2)], true).size).toBe(0);
    // Expiring or temporarily removing the sticker must not reset the sequence watermark.
    expect(gate.update([player()], true).size).toBe(0);
    expect(gate.update([player(2)], true).size).toBe(0);
    expect(gate.update([player(1)], true).size).toBe(0);
    expect([...gate.update([player(3)], true)]).toEqual(['player']);
  });

  it('allows a first reaction after a silent baseline and consumes expired or unknown reactions', () => {
    const gate = new ReactionSoundGate();
    gate.update([player()], true);
    expect(gate.update([player(1)], true).size).toBe(1);
    const expired = player(2);
    expired.reaction!.remainingMs = 0;
    expect(gate.update([expired], true).size).toBe(0);
    expect(gate.update([player(2)], true).size).toBe(0);
    const unknown = player(3);
    unknown.reaction!.id = 'not-in-catalog';
    expect(gate.update([unknown], true).size).toBe(0);
    expect(gate.update([player(3)], true).size).toBe(0);
  });

  it('treats AOI re-entry as a baseline, including unseen reactions selected while absent', () => {
    const gate = new ReactionSoundGate();
    gate.update([player(1)], true);
    gate.update([], true);
    expect(gate.update([player(2)], true).size).toBe(0);
    expect(gate.update([player(2)], true).size).toBe(0);
    expect(gate.update([player(3)], true).size).toBe(1);
  });

  it.each(['revision', 'motionRevision', 'epoch', 'reconnect'] as const)(
    'baselines %s changes instead of replaying replicated stickers',
    (reason) => {
      const gate = new ReactionSoundGate();
      const before = player(1);
      if (reason === 'reconnect') before.connected = false;
      gate.update([before], true);
      const after = player(2);
      if (reason === 'revision' || reason === 'motionRevision') after[reason]++;
      if (reason === 'epoch')
        after.animation = {
          worldEpoch: 'next-world',
          animationId: null,
          sequence: 0,
          startedAtTick: 0,
          changedAtTick: 0,
          endsAtTick: 0,
          displayTick: 0,
        };
      expect(gate.update([after], true).size).toBe(0);
      after.reaction!.sequence++;
      expect(gate.update([after], true).size).toBe(1);
    },
  );

  it('never queues inaudible or hidden-tab events for later playback', () => {
    const gate = new ReactionSoundGate();
    gate.update([player(1)], true);
    expect(gate.update([player(2)], false).size).toBe(0);
    expect(gate.update([player(2)], true).size).toBe(0);
    gate.suspend(); // The browser may render no frames at all while hidden.
    expect(gate.update([player(3)], true).size).toBe(0);
    expect(gate.update([player(4)], true).size).toBe(1);
    gate.clear();
    expect(gate.update([player(5)], true).size).toBe(0);
  });
});
