import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { Material } from '@babylonjs/core/Materials/material';
import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { WorldClouds, type CloudFrame } from './clouds';
import { CLOUD_FIELD } from './cloud-field';

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0.6, Math.PI / 3.15, 120, Vector3.Zero(), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  const zoomTo = (zoom: number) => {
    camera.orthoTop = 15 * zoom;
    camera.orthoBottom = -15 * zoom;
    camera.orthoRight = 26 * zoom;
    camera.orthoLeft = -26 * zoom;
    camera.radius = 120 * Math.max(1, zoom);
    camera.getViewMatrix(true);
  };
  const frame = (zoom: number): CloudFrame => ({
    epochMs: 1_800_000_000_000,
    lightDirection: new Vector3(-0.9, -1, -0.65),
    lightStrength: 1,
    tint: Color3.White(),
    zoom,
    visible: { center: { x: 0, y: 0, z: 0 }, radius: Infinity, time: 0, appearMs: 300 },
  });
  return { engine, scene, camera, zoomTo, frame };
}
const plugin = (material: Material) => material.pluginManager?.getPlugin('WorldCloudShadow');
const shaded = (material: Material) => {
  const defines = new MaterialDefines() as MaterialDefines & { SU_CLOUD_SHADOW?: boolean };
  plugin(material)!.prepareDefines(defines, material.getScene(), null!);
  return defines.SU_CLOUD_SHADOW;
};

describe('world clouds', () => {
  it('shades every lit world material without the world registering any', () => {
    const { engine, scene, camera } = fixture();
    const other = new Scene(engine);
    const clouds = new WorldClouds(scene, camera);
    try {
      // The lobby may be the most recently created scene on the page.
      expect(scene.getMeshByName('cloud-layer')).not.toBeNull();
      expect(other.getMeshByName('cloud-layer')).toBeNull();
      const facade = new PBRMaterial('facade', scene);
      const item = new StandardMaterial('item', scene);
      const label = new StandardMaterial('label', scene);
      label.disableLighting = true;
      expect(shaded(facade)).toBe(true);
      expect(shaded(item)).toBe(true);
      expect(shaded(label)).toBe(false);
      // A copy made while a building fades is shaded like its original.
      expect(shaded(facade.clone('facade-fading'))).toBe(true);
      // Another scene of the same page (the character preview) is left alone.
      expect(plugin(new StandardMaterial('preview', other))).toBeFalsy();

      clouds.setEnabled(false);
      expect(shaded(facade)).toBe(false);
      clouds.setEnabled(true);
      expect(shaded(facade)).toBe(true);
    } finally {
      clouds.dispose();
      other.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it('shows the layer above the roofs only when zoomed out, covering the frame', () => {
    const { engine, scene, camera, zoomTo, frame } = fixture();
    const clouds = new WorldClouds(scene, camera);
    try {
      const layer = scene.getMeshByName('cloud-layer')!;
      zoomTo(1);
      clouds.update(frame(1));
      expect(layer.isEnabled()).toBe(false);

      zoomTo(12);
      clouds.update(frame(12));
      expect(layer.isEnabled()).toBe(true);
      expect(layer.position.y).toBeCloseTo(CLOUD_FIELD.altitude);
      // The view axis passes through the middle of the layer.
      const forward = camera.target.subtract(camera.globalPosition).normalize();
      const along = layer.position.subtract(camera.globalPosition);
      expect(Vector3.Cross(along, forward).length()).toBeLessThan(1e-3);
      // Every corner of the frame, projected onto the layer, lies within it.
      const half = layer.scaling.x / 2;
      const right = Vector3.Cross(forward, Vector3.Up()).normalize();
      const up = Vector3.Cross(right, forward);
      for (const [sx, sy] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ]) {
        const origin = camera.globalPosition
          .add(right.scale(sx * camera.orthoRight!))
          .add(up.scale(sy * camera.orthoTop!));
        const hit = origin.add(forward.scale((CLOUD_FIELD.altitude - origin.y) / forward.y));
        expect(Math.abs(hit.x - layer.position.x)).toBeLessThanOrEqual(half);
        expect(Math.abs(hit.z - layer.position.z)).toBeLessThanOrEqual(half);
      }

      clouds.setEnabled(false);
      expect(layer.isEnabled()).toBe(false);
      clouds.update(frame(12));
      expect(layer.isEnabled()).toBe(false);
    } finally {
      clouds.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it('releases its texture, layer and material', () => {
    const { engine, scene, camera } = fixture();
    const before = [scene.meshes.length, scene.materials.length, scene.textures.length];
    const clouds = new WorldClouds(scene, camera);
    clouds.dispose();
    expect([scene.meshes.length, scene.materials.length, scene.textures.length]).toEqual(before);
    expect(plugin(new StandardMaterial('later', scene))).toBeFalsy();
    scene.dispose();
    engine.dispose();
  });
});
