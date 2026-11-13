import { describe, expect, it } from 'vitest';
import { DAY_LENGTH_MS, REFERENCE_HOUR, hourAt, skyAt, sunPosition } from './day-cycle';

const length = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe('day cycle', () => {
  it('passes exactly through the art-directed reference light', () => {
    const sky = skyAt(REFERENCE_HOUR);
    const reference = Math.hypot(0.9, 1, 0.65);
    expect(sky.lightDirection.x).toBeCloseTo(-0.9 / reference, 10);
    expect(sky.lightDirection.y).toBeCloseTo(-1 / reference, 10);
    expect(sky.lightDirection.z).toBeCloseTo(-0.65 / reference, 10);
    expect(sky.lightIntensity).toBe(3);
    expect(sky.skyIntensity).toBe(0.45);
    const hex = (color: readonly number[]) =>
      '#' +
      color
        .map((c) =>
          Math.round(c * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
    expect(hex(sky.lightColor)).toBe('#ffe6bd');
    expect(hex(sky.skyColor)).toBe('#d6e7f4');
    expect(hex(sky.groundColor)).toBe('#888563');
    expect(sky.directLight).toBe(1);
    // Mid-morning: the sun is in the south-east.
    expect(REFERENCE_HOUR).toBeGreaterThan(10);
    expect(REFERENCE_HOUR).toBeLessThan(11);
  });

  it('moves the sun along the compass of the map: east, south, west', () => {
    // East is +X, north is -Z.
    const sunrise = sunPosition(7);
    expect(sunrise.x).toBeCloseTo(1);
    expect(sunrise.y).toBeCloseTo(0);
    const noon = sunPosition(13);
    expect(noon.x).toBeCloseTo(0);
    expect(noon.z).toBeGreaterThan(0);
    expect(noon.y).toBeGreaterThan(0.8);
    const sunset = sunPosition(19);
    expect(sunset.x).toBeCloseTo(-1);
    expect(sunset.y).toBeCloseTo(0);
    expect(sunPosition(1).y).toBeLessThan(-0.8);
    for (let hour = 0; hour < 24; hour += 0.5) expect(length(sunPosition(hour))).toBeCloseTo(1);
  });

  it('always lights the world from above with a unit direction', () => {
    for (let hour = 0; hour <= 24; hour += 0.05) {
      const sky = skyAt(hour);
      expect(length(sky.lightDirection)).toBeCloseTo(1, 10);
      // Never grazing: shadows stay finite at sunrise, sunset and moonrise.
      expect(sky.lightDirection.y).toBeLessThanOrEqual(-0.2 + 1e-12);
      expect(sky.lightIntensity).toBeGreaterThanOrEqual(0);
      expect(sky.directLight).toBeGreaterThanOrEqual(0);
      expect(sky.directLight).toBeLessThanOrEqual(1);
      // The sky fill never goes out, so the city stays readable at any hour;
      // at night it is lower so that windows and lamps stand out.
      expect(sky.skyIntensity).toBeGreaterThan(0.2);
    }
  });

  it('swaps sun and moon in the dark and changes smoothly otherwise', () => {
    // On the horizon the direct light is off, so its direction may jump to the moon.
    for (const hour of [7, 19]) expect(skyAt(hour).lightIntensity).toBeCloseTo(0, 6);
    const step = 1 / 600;
    for (let hour = 0; hour < 24; hour += step) {
      const a = skyAt(hour);
      const b = skyAt(hour + step);
      expect(Math.abs(a.lightIntensity - b.lightIntensity)).toBeLessThan(0.02);
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(a.skyColor[i] - b.skyColor[i])).toBeLessThan(0.01);
        expect(
          Math.abs(a.lightColor[i] - b.lightColor[i]) *
            Math.min(a.lightIntensity, b.lightIntensity),
        ).toBeLessThan(0.02);
      }
      // While the light is on, its direction turns by a fraction of a degree per step.
      if (Math.min(a.lightIntensity, b.lightIntensity) > 0.01) {
        const dot =
          a.lightDirection.x * b.lightDirection.x +
          a.lightDirection.y * b.lightDirection.y +
          a.lightDirection.z * b.lightDirection.z;
        expect(dot).toBeGreaterThan(Math.cos((0.2 * Math.PI) / 180));
      }
    }
  });

  it('is dimmer and cooler at night than by day, with moonlight', () => {
    const day = skyAt(13);
    const night = skyAt(1);
    expect(night.lightIntensity).toBeGreaterThan(0.3);
    expect(night.lightIntensity).toBeLessThan(day.lightIntensity / 2);
    expect(night.lightColor[2]).toBeGreaterThan(night.lightColor[0]);
    expect(day.lightColor[0]).toBeGreaterThan(day.lightColor[2]);
    expect(night.directLight).toBeLessThan(day.directLight);
  });

  it('keeps the reference look neutral and grades dusk and night', () => {
    const luminance = ([r, g, b]: readonly number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const day = skyAt(REFERENCE_HOUR);
    expect(day.grade).toEqual({ shadows: 0, highlights: 0, saturation: 8, vignette: 0 });
    const night = skyAt(1);
    const dusk = skyAt(19);
    // Ночью пустота темнее, тени холоднее, края кадра темнеют.
    expect(luminance(night.backdrop)).toBeLessThan(luminance(day.backdrop));
    expect(night.grade.shadows).toBeGreaterThan(day.grade.shadows);
    expect(night.grade.vignette).toBeGreaterThan(0);
    // В сумерки света тёплые, а пустота лиловая: красного больше, чем днём.
    expect(dusk.grade.highlights).toBeGreaterThan(0);
    expect(dusk.backdrop[0]).toBeGreaterThan(day.backdrop[0]);
    // Без скачков: за минуту игрового времени ничего не меняется заметно.
    for (let hour = 0; hour < 24; hour += 0.25) {
      const a = skyAt(hour);
      const b = skyAt(hour + 1 / 60);
      for (let i = 0; i < 3; i++)
        expect(Math.abs(a.backdrop[i] - b.backdrop[i])).toBeLessThan(0.01);
      expect(Math.abs(a.grade.vignette - b.grade.vignette)).toBeLessThan(0.05);
      expect(Math.abs(a.grade.highlights - b.grade.highlights)).toBeLessThan(1);
    }
  });

  it('derives the same hour on every client and wraps once per game day', () => {
    const now = 1_800_000_000_000;
    expect(hourAt(now)).toBeGreaterThanOrEqual(0);
    expect(hourAt(now)).toBeLessThan(24);
    expect(hourAt(now + DAY_LENGTH_MS)).toBeCloseTo(hourAt(now), 6);
    const later = hourAt(now + DAY_LENGTH_MS / 24);
    expect((later - hourAt(now) + 24) % 24).toBeCloseTo(1, 6);
  });
});
