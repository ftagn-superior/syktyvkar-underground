import { describe, expect, it } from 'vitest';
import { DEFAULT_WEATHER } from '@su/contracts';
import { WorldWeatherControl } from './world-weather.js';

describe('room weather', () => {
  it('toggles clouds, reports and resets with a room-wide cooldown', () => {
    const state = { weatherClouds: DEFAULT_WEATHER.clouds };
    const weather = new WorldWeatherControl(state);
    const now = 1_000_000;
    expect(weather.command(undefined, now)).toMatchObject({ ok: true, retryAfterMs: 0 });
    expect(weather.command({ kind: 'clouds', enabled: false }, now)).toMatchObject({
      ok: true,
      message: 'Погода: облака выключены.',
    });
    expect(state.weatherClouds).toBe(false);
    expect(weather.command({ kind: 'clouds', enabled: true }, now + 500)).toMatchObject({
      ok: false,
      code: 'RATE_LIMITED',
    });
    expect(state.weatherClouds).toBe(false);
    // Read-only report is never rate limited.
    expect(weather.command(undefined, now + 500)).toMatchObject({ ok: true });
    expect(weather.command({ kind: 'reset' }, now + 1000)).toMatchObject({ ok: true });
    expect(state.weatherClouds).toBe(true);
  });
});
