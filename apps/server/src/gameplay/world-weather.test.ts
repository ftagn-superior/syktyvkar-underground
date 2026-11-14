import { describe, expect, it } from 'vitest';
import { DEFAULT_WEATHER, precipitationCode } from '@su/contracts';
import { WorldWeatherControl } from './world-weather.js';

const initial = () => ({
  weatherClouds: DEFAULT_WEATHER.clouds,
  weatherPrecipitation: precipitationCode(DEFAULT_WEATHER.precipitation),
  weatherFog: DEFAULT_WEATHER.fog,
});

describe('room weather control', () => {
  it('changes the replicated fields, reports and resets with a room-wide cooldown', () => {
    const state = initial();
    const weather = new WorldWeatherControl(state);
    const now = 1_000_000;
    expect(weather.command(undefined, now)).toMatchObject({
      ok: true,
      retryAfterMs: 0,
      message: 'Погода: облачно.',
    });
    expect(weather.command({ kind: 'set', part: 'clouds', enabled: false }, now)).toMatchObject({
      ok: true,
      message: 'Погода: ясно.',
    });
    expect(state.weatherClouds).toBe(false);
    expect(weather.command({ kind: 'set', part: 'rain', enabled: true }, now + 500)).toMatchObject({
      ok: false,
      code: 'RATE_LIMITED',
    });
    expect(state.weatherPrecipitation).toBe(0);
    // A read-only report is never rate limited.
    expect(weather.command(undefined, now + 500)).toMatchObject({ ok: true });
    expect(weather.command({ kind: 'set', part: 'snow', enabled: true }, now + 1000)).toMatchObject(
      { ok: true, message: 'Погода: снег.' },
    );
    expect(state.weatherPrecipitation).toBe(2);
    weather.command({ kind: 'set', part: 'fog', enabled: true }, now + 2000);
    expect(weather.weather).toEqual({ clouds: false, precipitation: 'snow', fog: true });
    weather.command({ kind: 'reset' }, now + 3000);
    expect(state).toEqual(initial());
  });
});
