import { describe, expect, it } from 'vitest';
import { DEFAULT_WEATHER } from '@su/contracts';
import { WeatherMix, parseWeatherOverride, settledAmounts } from './weather-mix';
import { skyAt } from './day-cycle';
import { weatherSky } from './weather-sky';

describe('weather mix', () => {
  it('snaps on join and then eases rain in quickly and wetness slowly', () => {
    const mix = new WeatherMix();
    mix.set(DEFAULT_WEATHER, true);
    expect(mix.current).toEqual(settledAmounts(DEFAULT_WEATHER));
    mix.set({ ...DEFAULT_WEATHER, precipitation: 'rain' });
    expect(mix.step(3)).toBe(true);
    // A second at most per step: a stalled tab does not jump straight to the end.
    expect(mix.current.rain).toBeCloseTo(1 / 6, 5);
    for (let i = 0; i < 10; i++) mix.step(1);
    expect(mix.current.rain).toBe(1);
    expect(mix.current.overcast).toBe(1);
    expect(mix.current.wetness).toBeGreaterThan(0.2);
    expect(mix.current.wetness).toBeLessThan(0.35);
    for (let i = 0; i < 60; i++) mix.step(1);
    expect(mix.current.wetness).toBe(1);
    expect(mix.step(1)).toBe(false);

    // Rain stops: the sky clears within seconds, streets stay wet for minutes.
    mix.set(DEFAULT_WEATHER);
    for (let i = 0; i < 20; i++) mix.step(1);
    expect(mix.current.rain).toBe(0);
    expect(mix.current.overcast).toBe(0);
    expect(mix.current.wetness).toBeGreaterThan(0.8);
  });

  it('melts snow faster under rain', () => {
    const melt = (precipitation: 'none' | 'rain') => {
      const mix = new WeatherMix();
      mix.set({ ...DEFAULT_WEATHER, precipitation: 'snow' }, true);
      mix.set({ ...DEFAULT_WEATHER, precipitation }, true);
      // `snap` jumped to the target; restore the snow cover and let it melt.
      mix.current.snowCover = 1;
      for (let i = 0; i < 30; i++) mix.step(1);
      return mix.current.snowCover;
    };
    expect(melt('rain')).toBeLessThan(melt('none'));
  });

  it('settles fog as half overcast and parses local overrides', () => {
    expect(settledAmounts({ clouds: false, precipitation: 'none', fog: true }).overcast).toBe(0.6);
    expect(parseWeatherOverride('rain,fog')).toEqual({
      clouds: false,
      precipitation: 'rain',
      fog: true,
    });
    expect(parseWeatherOverride('clear')).toEqual({
      clouds: false,
      precipitation: 'none',
      fog: false,
    });
    expect(parseWeatherOverride('clouds, snow')?.precipitation).toBe('snow');
    expect(parseWeatherOverride('hail')).toBeUndefined();
    expect(parseWeatherOverride(null)).toBeUndefined();
  });
});

describe('weather sky', () => {
  it('leaves a clear sky untouched', () => {
    const sky = skyAt(13);
    expect(weatherSky(sky, settledAmounts(DEFAULT_WEATHER))).toBe(sky);
  });

  it('dims direct light, flattens colour and paints the void in fog colour', () => {
    const sky = skyAt(13);
    const rainy = weatherSky(sky, settledAmounts({ ...DEFAULT_WEATHER, precipitation: 'rain' }));
    expect(rainy.lightIntensity).toBeLessThan(sky.lightIntensity * 0.3);
    expect(rainy.directLight).toBeLessThan(sky.directLight * 0.2);
    expect(rainy.skyIntensity).toBeGreaterThan(sky.skyIntensity);
    expect(rainy.grade.saturation).toBeLessThan(sky.grade.saturation);
    const spread = (c: readonly number[]) => Math.max(...c) - Math.min(...c);
    expect(spread(rainy.skyColor)).toBeLessThan(spread(sky.skyColor));

    const foggy = weatherSky(sky, settledAmounts({ ...DEFAULT_WEATHER, fog: true }));
    expect(foggy.backdrop).toEqual(foggy.fog);
    // Night fog stays dark: it must not light up the night city.
    const night = weatherSky(skyAt(1), settledAmounts({ ...DEFAULT_WEATHER, fog: true }));
    expect(Math.max(...night.fog)).toBeLessThan(0.25);
  });
});
