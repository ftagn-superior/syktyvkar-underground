import { describe, expect, it } from 'vitest';
import { Decoder, Encoder } from '@colyseus/schema';
import {
  DEFAULT_DAY_CLOCK,
  PROTOCOL_VERSION,
  applyDayClockAction,
  dayClockHour,
} from '@su/contracts';
import { WorldState } from './index.js';

describe('shared day clock wire', () => {
  it('replicates time changes, freeze at midnight and reset over consecutive deltas', () => {
    const source = new WorldState();
    const target = new WorldState();
    const encoder = new Encoder(source);
    const decoder = new Decoder(target);
    const now = 1_800_000_123_456;
    expect(source.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(PROTOCOL_VERSION).toBe(17);
    for (const clock of [
      applyDayClockAction(DEFAULT_DAY_CLOCK, { kind: 'set', hour: 18.5 }, now),
      { offsetMs: 1234, frozenHour: 0 },
      { offsetMs: 1234, frozenHour: 7 + 5 / 60 },
      DEFAULT_DAY_CLOCK,
    ]) {
      source.dayOffsetMs = clock.offsetMs;
      source.dayFrozenHour = clock.frozenHour;
      decoder.decode(encoder.encode());
      encoder.discardChanges();
      expect(target.dayOffsetMs).toBe(clock.offsetMs);
      expect(target.dayFrozenHour).toBeCloseTo(clock.frozenHour, 5);
      expect(
        dayClockHour({ offsetMs: target.dayOffsetMs, frozenHour: target.dayFrozenHour }, now),
      ).toBeCloseTo(dayClockHour(clock, now), 5);
    }
  });

  it('replicates the room weather', () => {
    const source = new WorldState();
    const target = new WorldState();
    const encoder = new Encoder(source);
    const decoder = new Decoder(target);
    expect(target.weatherClouds).toBe(true);
    for (const clouds of [false, true]) {
      source.weatherClouds = clouds;
      decoder.decode(encoder.encode());
      encoder.discardChanges();
      expect(target.weatherClouds).toBe(clouds);
    }
  });
});
