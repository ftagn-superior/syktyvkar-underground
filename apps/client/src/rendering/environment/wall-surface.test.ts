import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { SURFACE_KIND } from '@su/contracts';
import {
  adoptSurfaceAttribute,
  registerWallSurface,
  setWallSurfaceEconomy,
  SURFACE_ATTRIBUTE,
} from './wall-surface';

function wall(scene: Scene, uv2?: number[]) {
  const mesh = new Mesh('wall', scene);
  const data = new VertexData();
  data.positions = [0, 0, 0, 1, 0, 0, 1, 1, 0];
  data.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  data.indices = [0, 1, 2];
  data.applyToMesh(mesh);
  if (uv2) mesh.setVerticesData(VertexBuffer.UV2Kind, uv2, false, 2);
  return mesh;
}

describe('wall surface', () => {
  it('moves TEXCOORD_1 into its own attribute and only meshes with it get the pattern', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const state = registerWallSurface(scene);
      const brick = SURFACE_KIND.brick * 1000;
      const patterned = wall(scene, [brick + 1, 0, brick + 2, 0, brick + 2, 1]);
      const plain = wall(scene);
      expect(adoptSurfaceAttribute(patterned)).toBe(true);
      expect(adoptSurfaceAttribute(plain)).toBe(false);
      expect(patterned.isVerticesDataPresent(VertexBuffer.UV2Kind)).toBe(false);
      expect(patterned.getVerticesData(SURFACE_ATTRIBUTE)?.[0]).toBe(brick + 1);

      const material = new PBRMaterial('wall', scene);
      const plugin = material.pluginManager?.getPlugin('WorldWallSurface');
      expect(plugin).toBeTruthy();
      const defines = { SU_SURFACE: false } as never;
      plugin!.prepareDefines(defines, scene, patterned);
      expect((defines as { SU_SURFACE: boolean }).SU_SURFACE).toBe(true);
      plugin!.prepareDefines(defines, scene, plain);
      expect((defines as { SU_SURFACE: boolean }).SU_SURFACE).toBe(false);

      // Экономичный режим выключает рисунок и на стенах с материалом.
      setWallSurfaceEconomy(scene, true);
      expect(state.enabled).toBe(false);
      plugin!.prepareDefines(defines, scene, patterned);
      expect((defines as { SU_SURFACE: boolean }).SU_SURFACE).toBe(false);
      setWallSurfaceEconomy(scene, false);
      expect(state.enabled).toBe(true);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
