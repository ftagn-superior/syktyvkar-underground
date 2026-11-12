import { describe, expect, it } from 'vitest';
import { radialOpacity } from './radial-fog';
describe('world radial visibility for labels', () => {
  it('hides an unprepared circle, follows a continuous radial edge and keeps identical side/corner visibility', () => {
    const center = { x: -125, y: 0, z: -75 };
    expect(radialOpacity(center, center, 0)).toBe(0);
    expect(radialOpacity(center, { x: 375, y: 50, z: -75 }, 500)).toBe(0);
    expect(radialOpacity(center, { x: 300, y: 0, z: -75 }, 500)).toBe(1);
    const radius = 462.5;
    expect(radialOpacity(center, { x: center.x + radius, y: 0, z: center.z }, 500)).toBeCloseTo(
      0.5,
    );
    expect(
      radialOpacity(
        center,
        { x: center.x + radius * Math.SQRT1_2, y: 99, z: center.z + radius * Math.SQRT1_2 },
        500,
      ),
    ).toBeCloseTo(0.5);
    expect(radialOpacity(center, { x: center.x + 30, y: 0, z: center.z }, 30)).toBe(0);
    expect(radialOpacity(center, center, Infinity)).toBe(1);
  });
});

import { vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { applyRadialFog, RadialFog } from './radial-fog';

it('binds every instance and can clone both material families without serializing live view state', () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const state = { center: { x: 20, y: 0, z: -40 }, radius: 500, time: 100, appearMs: 300 };
    for (const Material of [StandardMaterial, PBRMaterial]) {
      const source = new Material('source', scene);
      const mesh = MeshBuilder.CreateBox('instance', {}, scene);
      mesh.material = source;
      applyRadialFog(mesh, state, 0);
      const plugin = source.pluginManager!.getPlugin('WorldRadialFog') as RadialFog;
      const bind = vi.spyOn(plugin, 'hardBindForSubMesh').mockImplementation(() => {});
      source._callbackPluginEventHardBindForSubMesh({ subMesh: mesh.subMeshes[0] });
      expect(bind).toHaveBeenCalledOnce();
      const clone = source.clone('copy')!;
      mesh.material = clone;
      applyRadialFog(mesh, state, 0);
      expect(clone.pluginManager!.getPlugin('WorldRadialFog')).toBeTruthy();
      expect(clone.pluginManager!.getPlugin('WorldRadialFog')).not.toBe(plugin);
      expect(clone.alpha).toBe(source.alpha);
      expect(clone.transparencyMode).toBe(source.transparencyMode);
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
