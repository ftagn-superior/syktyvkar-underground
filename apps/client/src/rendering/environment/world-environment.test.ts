import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DEFAULT_DAY_CLOCK, dayClockHour } from '@su/contracts';
import { WorldEnvironment } from './world-environment';

describe('world environment', () => {
  it('keeps room time through quality changes and resumes it after a local override', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new ArcRotateCamera('camera', 0, 1, 120, Vector3.Zero(), scene);
    const environment = new WorldEnvironment(scene, camera);
    const frame = {
      target: Vector3.Zero(),
      zoom: 1,
      visible: { center: { x: 0, y: 0, z: 0 }, radius: 100, time: 0, appearMs: 300 },
    };
    const epochMs = 1_800_000_100_000;
    try {
      environment.setDayClock({ offsetMs: 0, frozenHour: 23 });
      environment.update(frame, epochMs);
      expect(environment.hour).toBe(23);
      environment.setQuality('economy');
      environment.update(frame, epochMs + 10_000);
      expect(environment.hour).toBe(23);
      environment.setTimeOfDay(13);
      expect(environment.hour).toBe(13);
      environment.update(frame, epochMs);
      environment.setDayClock({ offsetMs: 0, frozenHour: 6 });
      environment.update(frame, epochMs);
      expect(environment.hour).toBe(13);
      environment.setTimeOfDay(undefined);
      expect(environment.hour).toBe(6);
      environment.setDayClock(DEFAULT_DAY_CLOCK);
      environment.update(frame, epochMs);
      expect(environment.hour).toBe(dayClockHour(DEFAULT_DAY_CLOCK, epochMs));
    } finally {
      environment.dispose();
      expect(scene.lights).toHaveLength(0);
      expect(scene.getMeshByName('cloud-layer')).toBeNull();
      scene.dispose();
      engine.dispose();
    }
  });

  it('shows the first weather at once, eases later changes and draws precipitation', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new ArcRotateCamera('camera', 0, 1, 120, Vector3.Zero(), scene);
    camera.orthoRight = 20;
    camera.orthoTop = 15;
    const environment = new WorldEnvironment(scene, camera);
    const frame = {
      target: Vector3.Zero(),
      zoom: 1,
      visible: { center: { x: 0, y: 0, z: 0 }, radius: 100, time: 0, appearMs: 300 },
      camera,
    };
    const epochMs = 1_800_000_100_000;
    const rain = () => scene.getMeshByName('precipitation-rain')!;
    try {
      environment.setWeather({ clouds: true, precipitation: 'rain', fog: false });
      environment.update(frame, epochMs);
      expect(environment.weatherAmounts.rain).toBe(1);
      expect(rain().isEnabled()).toBe(true);
      expect(scene.getMeshByName('precipitation-snow')!.isEnabled()).toBe(false);
      // Far out the cloud layer replaces the rain.
      environment.update({ ...frame, zoom: 8 }, epochMs + 16);
      expect(rain().isEnabled()).toBe(false);

      environment.setWeather({ clouds: false, precipitation: 'snow', fog: true });
      environment.update(frame, epochMs + 1000);
      expect(environment.weatherAmounts.rain).toBeGreaterThan(0.8);
      expect(environment.weatherAmounts.snow).toBeGreaterThan(0);
      expect(environment.weatherAmounts.snow).toBeLessThan(0.2);
      expect(environment.weatherAmounts.fog).toBeGreaterThan(0);

      // A local override wins and shows at once; clearing it returns to the room.
      environment.setWeatherOverride({ clouds: false, precipitation: 'none', fog: false });
      environment.update(frame, epochMs + 1016);
      expect(environment.weatherAmounts.rain).toBe(0);
      expect(environment.weatherAmounts.fog).toBe(0);
      expect(rain().isEnabled()).toBe(false);
      environment.setWeatherOverride(undefined);
      environment.update(frame, epochMs + 1032);
      expect(environment.weatherAmounts.snow).toBe(1);
    } finally {
      environment.dispose();
      expect(scene.getMeshByName('precipitation-rain')).toBeNull();
      scene.dispose();
      engine.dispose();
    }
  });
});
