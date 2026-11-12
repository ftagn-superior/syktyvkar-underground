import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { WorldLighting } from './lighting';

describe('static shadow cache', () => {
  const fixture = () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new ArcRotateCamera('camera', 0, 1, 120, Vector3.Zero(), scene);
    const lighting = new WorldLighting(scene, camera);
    lighting.setQuality('standard');
    const frames = (count: number) => {
      for (let frame = 0; frame < count; frame++) scene.render();
      return lighting.staticShadow.refreshes;
    };
    return { engine, scene, lighting, frames };
  };

  it('draws immovable casters once and again only after their set changes', () => {
    const { engine, scene, lighting, frames } = fixture();
    try {
      const house = MeshBuilder.CreateBox('house', {}, scene);
      lighting.staticShadow.addShadowCaster(house);
      expect(frames(5)).toBe(1);
      const avatar = MeshBuilder.CreateBox('avatar', {}, scene);
      lighting.shadow.addShadowCaster(avatar);
      expect(frames(5)).toBe(1);
      lighting.staticShadow.removeShadowCaster(house);
      expect(frames(5)).toBe(2);
      lighting.staticShadow.invalidate();
      lighting.staticShadow.invalidate();
      expect(frames(5)).toBe(3);
      expect(lighting.shadowDiagnostics()).toEqual({
        staticCasters: 0,
        dynamicCasters: 1,
        staticRefreshes: 3,
      });
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it('keeps the projection while the camera moves within one snap step', () => {
    const { engine, scene, lighting, frames } = fixture();
    try {
      lighting.staticShadow.addShadowCaster(MeshBuilder.CreateBox('house', {}, scene));
      const sun = lighting.shadow.getLight() as DirectionalLight;
      lighting.follow(new Vector3(100, 0, 100));
      const position = sun.position.clone();
      const drawn = frames(3);
      // Small camera motion: same projection, no redraw.
      for (const offset of [0.2, 0.6, 1]) {
        lighting.follow(new Vector3(100 + offset, 0, 100 - offset));
        expect(sun.position.equals(position)).toBe(true);
      }
      expect(frames(3)).toBe(drawn);
      // A long move crosses several steps: new projection, exactly one redraw.
      lighting.follow(new Vector3(140, 0, 60));
      expect(sun.position.equals(position)).toBe(false);
      expect(frames(3)).toBe(drawn + 1);
      // Steps are whole texels of the map, so cached edges do not shimmer between redraws.
      const texel = 90 / 2048;
      const moved = sun.position.subtract(position);
      const right = Vector3.Cross(Vector3.Up(), sun.direction).normalize();
      const texels = Vector3.Dot(moved, right) / texel;
      expect(Math.abs(texels - Math.round(texels))).toBeLessThan(1e-6);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it('ignores casters outside the footprint of the map', () => {
    const { engine, scene, lighting, frames } = fixture();
    try {
      const near = MeshBuilder.CreateBox('near', {}, scene);
      near.position.set(30, 0, -20);
      near.computeWorldMatrix(true);
      const far = MeshBuilder.CreateBox('far', {}, scene);
      far.position.set(400, 0, 0);
      far.computeWorldMatrix(true);
      lighting.staticShadow.addShadowCaster(near);
      expect(frames(3)).toBe(1);
      // Streaming registers and releases distant buildings all the time.
      lighting.staticShadow.addShadowCaster(far);
      expect(frames(3)).toBe(1);
      lighting.staticShadow.removeShadowCaster(far);
      expect(frames(3)).toBe(1);
      lighting.staticShadow.addShadowCaster(far);
      // Once the camera gets there, the move itself redraws the map with it included.
      lighting.follow(new Vector3(390, 0, 0));
      expect(frames(3)).toBe(2);
      lighting.staticShadow.removeShadowCaster(far);
      expect(frames(3)).toBe(3);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it('redraws after shadows were switched off and on', () => {
    const { engine, scene, lighting, frames } = fixture();
    try {
      lighting.staticShadow.addShadowCaster(MeshBuilder.CreateBox('house', {}, scene));
      expect(frames(3)).toBe(1);
      lighting.setQuality('economy');
      expect(frames(3)).toBe(1);
      lighting.setQuality('standard');
      expect(frames(3)).toBe(2);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});

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

      // The sun trails the target by at most half a snap step along each of its axes.
      const ideal = (target: Vector3) => target.subtract(direction.normalizeToNew().scale(150));
      for (const target of [new Vector3(15, 0, -22), new Vector3(-400, 5, 600)]) {
        lighting.follow(target);
        expect(sun.direction.equals(direction)).toBe(true);
        expect(Vector3.Distance(sun.position, ideal(target))).toBeLessThan(5);
      }

      lighting.dispose();
      expect(scene.lights).toHaveLength(0);
      expect(lighting.shadow.getShadowMap()).toBeNull();
      expect(lighting.staticShadow.getShadowMap()).toBeNull();
      expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(false);
      expect(caster.isDisposed()).toBe(false);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
