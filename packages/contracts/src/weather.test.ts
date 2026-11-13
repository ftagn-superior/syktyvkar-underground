import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEATHER,
  PRECIPITATIONS,
  applyWeatherAction,
  describeWeather,
  precipitationCode,
  precipitationFromCode,
} from './weather.js';

describe('room weather', () => {
  it('switches parts independently and keeps rain and snow exclusive', () => {
    const rain = applyWeatherAction(DEFAULT_WEATHER, { kind: 'set', part: 'rain', enabled: true });
    expect(rain).toEqual({ clouds: true, precipitation: 'rain', fog: false });
    const snow = applyWeatherAction(rain, { kind: 'set', part: 'snow', enabled: true });
    expect(snow.precipitation).toBe('snow');
    // Stopping rain while it snows leaves the snow alone.
    expect(applyWeatherAction(snow, { kind: 'set', part: 'rain', enabled: false })).toEqual(snow);
    expect(
      applyWeatherAction(snow, { kind: 'set', part: 'snow', enabled: false }).precipitation,
    ).toBe('none');
    const foggy = applyWeatherAction(snow, { kind: 'set', part: 'fog', enabled: true });
    expect(foggy).toEqual({ clouds: true, precipitation: 'snow', fog: true });
    expect(applyWeatherAction(foggy, { kind: 'set', part: 'clouds', enabled: false }).clouds).toBe(
      false,
    );
  });

  it('clears, resets and describes', () => {
    const stormy = { clouds: true, precipitation: 'rain', fog: true } as const;
    expect(applyWeatherAction(stormy, { kind: 'clear' })).toEqual({
      clouds: false,
      precipitation: 'none',
      fog: false,
    });
    expect(applyWeatherAction(stormy, { kind: 'reset' })).toEqual(DEFAULT_WEATHER);
    expect(describeWeather(stormy)).toBe('дождь, туман, облачно');
    expect(describeWeather(DEFAULT_WEATHER)).toBe('облачно');
    expect(describeWeather(applyWeatherAction(stormy, { kind: 'clear' }))).toBe('ясно');
  });

  it('round-trips precipitation codes and tolerates unknown ones', () => {
    for (const precipitation of PRECIPITATIONS)
      expect(precipitationFromCode(precipitationCode(precipitation))).toBe(precipitation);
    expect(precipitationFromCode(99)).toBe('none');
  });
});
