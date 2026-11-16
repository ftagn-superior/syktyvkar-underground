import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  PrecipitationLayer,
  PRECIPITATION_DROPS,
  type PrecipitationFrame,
} from './precipitation';

describe('shader-deformed precipitation bounds', () => {
  it.each(['rain', 'snow'] as const)('keeps %s bounds around the eye across quality changes', (kind) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const layer = new PrecipitationLayer(scene, kind);
    const mesh = scene.getMeshByName(`precipitation-${kind}`) as Mesh;
    const frame: PrecipitationFrame = {
      amount: 1,
      seconds: 12,
      overhead: false,
      eye: new Vector3(1024, 12, -2048),
      forward: new Vector3(0, 0, -1),
      target: new Vector3(1024, 0, -2048),
      halfWidth: 20,
      halfHeight: 15,
      zoom: 1,
      color: [1, 1, 1],
      fog: 0,
    };
    try {
      expect(mesh.geometry).toBeNull();
      layer.setEconomy(true);
      layer.update(frame);
      expect(mesh.subMeshes[0].indexCount).toBe(Math.round(PRECIPITATION_DROPS * 0.45) * 6);
      const bounds = mesh.getBoundingInfo();
      expect(mesh.subMeshes[0].getBoundingInfo()).toBe(bounds);
      expect(bounds.boundingBox.minimumWorld.x).toBeLessThan(frame.eye.x - 18);
      expect(bounds.boundingBox.maximumWorld.x).toBeGreaterThan(frame.eye.x + 18);
      expect(bounds.boundingBox.minimumWorld.y).toBeLessThan(frame.eye.y - 8);
      expect(bounds.boundingBox.maximumWorld.y).toBeGreaterThan(frame.eye.y + 16);
      layer.setEconomy(false);
      layer.update({ ...frame, eye: new Vector3(-512, 12, 256) });
      expect(mesh.subMeshes[0].indexCount).toBe(PRECIPITATION_DROPS * 6);
      expect(bounds.boundingBox.maximumWorld.x).toBeLessThan(0);
      expect(bounds.boundingBox.minimumWorld.z).toBeGreaterThan(0);
      layer.setEconomy(true);
      expect(mesh.subMeshes[0].getBoundingInfo()).toBe(bounds);
      layer.update({
        ...frame,
        overhead: true,
        forward: new Vector3(0, -1, 0),
        target: new Vector3(700, 10, -900),
        zoom: 3,
      });
      expect(bounds.boundingBox.minimumWorld.x).toBeLessThan(680);
      expect(bounds.boundingBox.maximumWorld.x).toBeGreaterThan(720);
      expect(bounds.boundingBox.minimumWorld.y).toBeLessThan(9);
      expect(bounds.boundingBox.maximumWorld.y).toBeGreaterThan(63);
      layer.update({ amount: 0 } as PrecipitationFrame);
      expect(mesh.isEnabled()).toBe(false);
    } finally {
      layer.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
