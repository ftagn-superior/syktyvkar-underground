import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { BuildingInstance } from '@su/contracts';
import { WorldNightLights } from './night-lights';

const at = (entityId: string, x: number): BuildingInstance => ({
  entityId,
  assetId: entityId,
  position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
});

describe('night lights', () => {
  it('keeps one source across overlapping near/far owners and releases the last owner', () => {
    const engine = new NullEngine(),
      scene = new Scene(engine),
      lights = new WorldNightLights(scene);
    try {
      const source = [{ position: { x: 0, y: 5, z: 0 }, radius: 12, color: '#ffd49a' }];
      lights.retainSources(at('lamp', 0), source);
      lights.retainSources(at('lamp', 0), source);
      expect(lights.sourceCount).toBe(1);
      lights.releaseSources('lamp');
      expect(lights.sourceCount).toBe(1);
      lights.releaseSources('lamp');
      expect(lights.sourceCount).toBe(0);
    } finally {
      lights.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
  it('gives street lamps a cone of their own height and neon signs none', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const lights = new WorldNightLights(scene);
    try {
      lights.addSources(at('lamp', 0), [
        { position: { x: 1.2, y: 6.1, z: 0 }, radius: 14, color: '#ffd49a' },
      ]);
      lights.addSources(at('sign', 4), [
        { position: { x: 0, y: 3, z: 0 }, radius: 6, color: '#ff2040', kind: 'neon' },
      ]);
      lights.update(12, 0, Vector3.Zero());
      expect(scene.getMeshByName('night-lamp-cones')).toBeNull();
      lights.update(23, 0, Vector3.Zero());
      const state = (lights as unknown as { state: { lampColors: Float32Array; cones: boolean } })
        .state;
      // Колонка w цвета — высота плафона для конуса; ближайший фонарь в первом слоте.
      expect(state.lampColors[3]).toBeCloseTo(6.1, 5);
      expect(state.lampColors[7]).toBe(0);
      expect(state.lampColors[4]).toBeGreaterThan(0);
      expect(state.cones).toBe(true);
      const coneMesh = scene.getMeshByName('night-lamp-cones') as Mesh | null;
      expect(coneMesh?.isEnabled()).toBe(true);
      expect(coneMesh?.thinInstanceCount).toBe(1);

      lights.setEconomy(true);
      expect(state.cones).toBe(false);
      expect(coneMesh?.isEnabled()).toBe(false);
      lights.setEconomy(false);
      expect(state.cones).toBe(true);
      lights.update(23, 0, Vector3.Zero());
      expect(coneMesh?.isEnabled()).toBe(true);
    } finally {
      lights.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
