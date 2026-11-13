import { describe, expect, it } from 'vitest';
import {
  CLOUD_FIELD,
  cloudCoverage,
  cloudDrift,
  cloudLayerOpacity,
  cloudShadowShift,
} from './cloud-field';

describe('cloud field', () => {
  it('builds the same partly cloudy sky for every client', () => {
    const size = 128;
    const first = cloudCoverage(size);
    expect(cloudCoverage(size)).toEqual(first);
    expect(cloudCoverage(size, 8)).not.toEqual(first);
    let covered = 0;
    let total = 0;
    for (const value of first) {
      if (value > 0) covered++;
      total += value;
    }
    // Clear sky dominates; clouds are present and have solid middles.
    expect(covered / first.length).toBeGreaterThan(0.15);
    expect(covered / first.length).toBeLessThan(0.5);
    expect(total / first.length / 255).toBeGreaterThan(0.05);
    expect(Math.max(...first)).toBe(255);
  });

  it('tiles without a seam', () => {
    const size = 128;
    const data = cloudCoverage(size);
    const at = (x: number, y: number) => data[y * size + x];
    let inner = 0;
    let seam = 0;
    for (let i = 0; i < size; i++) {
      inner = Math.max(inner, Math.abs(at(60, i) - at(61, i)), Math.abs(at(i, 60) - at(i, 61)));
      seam = Math.max(
        seam,
        Math.abs(at(size - 1, i) - at(0, i)),
        Math.abs(at(i, size - 1) - at(i, 0)),
      );
    }
    // The wrap-around step is no rougher than a step inside the texture.
    expect(seam).toBeLessThanOrEqual(inner * 2 + 8);
  });

  it('drifts with the wind, continuously across the wrap', () => {
    const now = 1_800_000_000_000;
    const a = cloudDrift(now);
    const b = cloudDrift(now + 1000);
    const step = (from: number, to: number) => {
      const d = to - from;
      return d > 0.5 ? d - 1 : d < -0.5 ? d + 1 : d;
    };
    expect(step(a.u, b.u) * CLOUD_FIELD.tileMetres).toBeCloseTo(-CLOUD_FIELD.wind.x, 3);
    expect(step(a.v, b.v) * CLOUD_FIELD.tileMetres).toBeCloseTo(-CLOUD_FIELD.wind.z, 3);
    for (const value of [a.u, a.v, b.u, b.v]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('places a shadow down-sun of its cloud and bounds it at sunset', () => {
    // Sun in the +X sky at 45 degrees: light travels towards -X and down.
    const noon = cloudShadowShift({ x: -1, y: -1, z: 0 });
    expect(noon.x).toBeCloseTo(1);
    expect(noon.z).toBeCloseTo(0);
    // Straight down: the shadow is directly below.
    const overhead = cloudShadowShift({ x: 0, y: -1, z: 0 });
    expect(Math.hypot(overhead.x, overhead.z)).toBe(0);
    // On the horizon the shift stays finite.
    const sunset = cloudShadowShift({ x: -1, y: -0.001, z: 0 });
    expect(sunset.x).toBeCloseTo(1 / CLOUD_FIELD.minSunHeight, 2);
  });

  it('shows the layer only from afar', () => {
    expect(cloudLayerOpacity(1)).toBe(0);
    expect(cloudLayerOpacity(2.5)).toBe(0);
    expect(cloudLayerOpacity(5)).toBeGreaterThan(0);
    expect(cloudLayerOpacity(5)).toBeLessThan(cloudLayerOpacity(7));
    expect(cloudLayerOpacity(9)).toBe(1);
    expect(cloudLayerOpacity(30)).toBe(1);
  });
});
