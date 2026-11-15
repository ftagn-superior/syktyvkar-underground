import { describe, expect, it } from 'vitest';
import { Encoder, Decoder } from '@colyseus/schema';
import { NEUTRAL_INPUT } from '@su/contracts';
import {
  MoveInputSchema,
  PlayerSchema,
  applyEntityState,
  readMoveInput,
  toPlayerState,
  writeMoveInput,
} from './index.js';

describe('player speed on the wire', () => {
  it('replicates /speed as integer percent and omits the normal speed', () => {
    const base = {
      entityId: 'p',
      kind: 'player' as const,
      revision: 1,
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      grounded: true,
    };
    const source = new PlayerSchema();
    const decoded = new PlayerSchema();
    const encoder = new Encoder(source);
    const decoder = new Decoder(decoded);
    for (const speedScale of [undefined, 1.25, 0.1, 4, undefined]) {
      applyEntityState(source, { ...base, ...(speedScale ? { speedScale } : {}) });
      decoder.decode(encoder.encode());
      encoder.discardChanges();
      expect(decoded.speedPercent).toBe(Math.round((speedScale ?? 1) * 100));
      expect(toPlayerState(decoded).speedScale).toBe(speedScale);
    }
  });
});

describe('facing on the existing input wire', () => {
  it('round trips zero, angle changes, backward motion and neutral over successive deltas', () => {
    const input = new MoveInputSchema();
    const encoder = new Encoder(input);
    const decoded = new MoveInputSchema();
    const decoder = new Decoder(decoded);
    for (const command of [
      NEUTRAL_INPUT,
      { ...NEUTRAL_INPUT, facingYaw: 0 },
      { moveX: 0, moveZ: -1, facingYaw: 1.2 },
      NEUTRAL_INPUT,
    ]) {
      writeMoveInput(input, command);
      decoder.decode(encoder.encode());
      encoder.discardChanges();
      expect(readMoveInput(decoded)).toEqual({ sprint: false, ...command });
    }
    expect(decoded.hasFacing).toBe(false);
    expect(decoded.facingYaw).toBe(0);
  });
  it('ignores nonfinite orientation in an untrusted schema', () => {
    const input = new MoveInputSchema();
    input.hasFacing = true;
    input.facingYaw = NaN;
    expect(readMoveInput(input)).toEqual(NEUTRAL_INPUT);
  });
});
