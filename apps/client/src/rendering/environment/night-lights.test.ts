import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
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
      lights.update(23, 0, Vector3.Zero());
      const state = (lights as unknown as { state: { lampColors: Float32Array; cones: boolean } })
        .state;
      // Колонка w цвета — высота плафона для конуса; ближайший фонарь в первом слоте.
      expect(state.lampColors[3]).toBeCloseTo(6.1, 5);
      expect(state.lampColors[7]).toBe(0);
      expect(state.lampColors[4]).toBeGreaterThan(0);
      expect(state.cones).toBe(true);

      lights.setEconomy(true);
      expect(state.cones).toBe(false);
      lights.setEconomy(false);
      expect(state.cones).toBe(true);
    } finally {
      lights.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
