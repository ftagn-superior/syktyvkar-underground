import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { WorldLighting } from './lighting';

describe('world lighting ownership', () => {
  it('keeps the palette, lights and shadow casters across quality switches and camera movement', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new ArcRotateCamera('camera', 0, 1, 120, Vector3.Zero(), scene);
    const lighting = new WorldLighting(scene, camera);
    try {
      const caster = MeshBuilder.CreateBox('caster', {}, scene);
      lighting.shadow.addShadowCaster(caster);
      const shadowMap = lighting.shadow.getShadowMap();
      const sun = lighting.shadow.getLight();
      const direction = sun.direction.clone();
      const lights = [...scene.lights];
      const palette = () => {
        const imageProcessing = scene.imageProcessingConfiguration;
        return {
          toneMappingEnabled: imageProcessing.toneMappingEnabled,
          toneMappingType: imageProcessing.toneMappingType,
          exposure: imageProcessing.exposure,
          contrast: imageProcessing.contrast,
          colorCurvesEnabled: imageProcessing.colorCurvesEnabled,
          saturation: imageProcessing.colorCurves?.globalSaturation,
          vignetteEnabled: imageProcessing.vignetteEnabled,
        };
      };
      const initialPalette = palette();
      for (const quality of ['standard', 'standard', 'economy', 'economy', 'standard'] as const) {
        lighting.setQuality(quality);
        expect(palette()).toEqual(initialPalette);
        expect(scene.shadowsEnabled).toBe(quality === 'standard');
        expect(scene.lights).toEqual(lights);
        expect(lighting.shadow.getShadowMap()).toBe(shadowMap);
        expect(shadowMap?.renderList).toHaveLength(1);
        expect(shadowMap?.renderList?.[0]).toBe(caster);
      }

      const firstTarget = new Vector3(15, 0, -22);
      const secondTarget = new Vector3(-400, 5, 600);
      lighting.follow(firstTarget);
      const offset = sun.position.subtract(firstTarget);
      lighting.follow(secondTarget);
      expect(sun.direction.equals(direction)).toBe(true);
      expect(sun.position.subtract(secondTarget).equalsWithEpsilon(offset, 1e-10)).toBe(true);
      expect(offset.length()).toBeCloseTo(150);

      lighting.dispose();
      expect(scene.lights).toHaveLength(0);
      expect(lighting.shadow.getShadowMap()).toBeNull();
      expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(false);
      expect(caster.isDisposed()).toBe(false);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
