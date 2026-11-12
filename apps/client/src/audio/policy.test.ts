import { describe, expect, it } from 'vitest';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { chooseVariant, distanceGain, listenerYaw, samplesFor, sanitizeSettings } from './policy';

describe('audio policies', () => {
  it('keeps nearby sound at full level and reaches exact silence at and beyond the radius', () => {
    const listener = { x: 100, y: 1, z: -50 };
    for (const [distance, gain] of [
      [0, 1],
      [2, 1],
      [10, 0.5],
      [18, 0],
      [80, 0],
    ])
      expect(distanceGain(listener, { ...listener, x: listener.x + distance }, 2, 18)).toBe(gain);
    expect(distanceGain(listener, { ...listener, y: 19 }, 2, 18)).toBe(0);
    expect(distanceGain(listener, { x: NaN, y: 0, z: 0 }, 2, 18)).toBe(0);
  });

  it('keeps stereo forward aligned with the screen when the right-handed camera rotates', () => {
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const rotation = Matrix.FromQuaternionToRef(
        Quaternion.FromEulerAngles(0, listenerYaw(angle), 0),
        Matrix.Identity(),
      );
      const forward = Vector3.TransformNormal(new Vector3(0, 0, -1), rotation);
      expect(forward.x).toBeCloseTo(-Math.cos(angle));
      expect(forward.z).toBeCloseTo(-Math.sin(angle));
    }
  });

  it('does not repeat adjacent variants and works with a partially available bank', () => {
    const variants = samplesFor('step');
    let previous: string | undefined;
    for (let index = 0; index < 12; index++) {
      const next = chooseVariant(variants, previous, 0.5);
      expect(next).not.toBe(previous);
      previous = next;
    }
    expect(chooseVariant(['only'], 'only', 1)).toBe('only');
    expect(chooseVariant([], undefined)).toBeUndefined();
    expect(chooseVariant(['a', 'b'], undefined, 1)).toBe('b');
  });

  it('contains invalid stored preferences and preserves omitted settings', () => {
    expect(sanitizeSettings({ volume: 4, worldVolume: -1, uiVolume: NaN, muted: 'false' })).toEqual(
      {
        volume: 1,
        worldVolume: 0,
        uiVolume: 0.8,
        muted: false,
      },
    );
    const previous = { volume: 0.4, worldVolume: 0.3, uiVolume: 0.2, muted: true };
    expect(sanitizeSettings({ muted: false }, previous)).toEqual({ ...previous, muted: false });
    expect(sanitizeSettings(null, previous)).toEqual(previous);
  });
});
