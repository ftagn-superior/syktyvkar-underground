import { describe, expect, it } from 'vitest';
import { Encoder, Decoder } from '@colyseus/schema';
import { NEUTRAL_INPUT } from '@su/contracts';
import { MoveInputSchema, readMoveInput, writeMoveInput } from './index.js';

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
