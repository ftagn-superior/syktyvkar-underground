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
});
