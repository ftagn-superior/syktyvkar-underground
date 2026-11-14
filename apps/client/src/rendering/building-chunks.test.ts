import { describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { BuildingChunks } from './building-chunks';
import { GLOW_ATTRIBUTE, GLOW_ORIGIN_ATTRIBUTE } from './environment/night-lights';
import { SURFACE_ATTRIBUTE } from './environment/wall-surface';

function fixture(options: ConstructorParameters<typeof BuildingChunks>[3] = { settleFrames: 2 }) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 5, -5), scene);
  const light = new DirectionalLight('sun', new Vector3(0, -1, 0), scene);
  const shadows = new ShadowGenerator(128, light);
  const chunks = new BuildingChunks(scene, shadows, undefined, options);
  const add = (id: string, x = 510, shadow = true) => {
    const mesh = new Mesh(id, scene);
    const material = new PBRMaterial(id, scene);
    material.metallic = 0;
    material.roughness = 0.9;
    material.albedoColor.set(0.4, 0.6, 0.8);
    mesh.material = material;
    const data = new VertexData();
    data.positions = [0, 0, 0, 0, 0, 2, 2, 0, 0];
    data.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0];
    data.colors = [0.5, 0.75, 1, 1, 0.5, 0.75, 1, 1, 0.5, 0.75, 1, 1];
    data.indices = [0, 1, 2];
    data.applyToMesh(mesh);
    mesh.setVerticesData(GLOW_ATTRIBUTE, [1, 2, 1, 2, 1, 2], false, 2);
    mesh.setVerticesData(SURFACE_ATTRIBUTE, [1002, 3, 1002, 4, 1003, 3], false, 2);
    mesh.position.set(x, 2, 7);
    mesh.computeWorldMatrix(true);
    if (shadow) shadows.addShadowCaster(mesh);
    chunks.add({ id, position: { x, z: 7 }, meshes: [mesh], eligible: () => true });
    return mesh;
  };
  const settle = async (center = Vector3.Zero()) => {
    for (let frame = 0; frame < 8; frame++) {
      chunks.update(center);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  const merged = () =>
    scene.meshes.filter((mesh) => mesh.name.startsWith('building-chunk:')) as Mesh[];
  return {
    scene,
    shadows,
    chunks,
    add,
    settle,
    merged,
    dispose() {
      chunks.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

describe('runtime building chunks', () => {
  it('shows originals until new shaders are ready and cancels pending geometry on an edit', () => {
    const f = fixture({ settleFrames: 1 });
    const ready = vi.spyOn(Mesh.prototype, 'isReady').mockReturnValue(false);
    try {
      const first = f.add('a'),
        second = f.add('b', 530);
      f.chunks.update(Vector3.Zero());
      expect(f.merged()).toHaveLength(1);
      expect(f.merged()[0].isEnabled()).toBe(false);
      expect(first.isEnabled() && second.isEnabled()).toBe(true);
      expect(f.chunks.diagnostics().buildingChunks).toBe(0);
      expect(f.chunks.diagnostics().buildingChunkGeometryBytes).toBeGreaterThan(0);
      f.chunks.touch('a');
      expect(f.merged()).toHaveLength(0);
      expect(f.chunks.diagnostics().buildingChunkGeometryBytes).toBe(0);
      f.chunks.update(Vector3.Zero());
      ready.mockReturnValue(true);
      f.chunks.update(Vector3.Zero());
      expect(first.isEnabled() || second.isEnabled()).toBe(false);
      expect(f.merged()[0].isEnabled()).toBe(true);
    } finally {
      ready.mockRestore();
      f.dispose();
    }
  });

  it('reserves the total budget across cells and reuses released capacity', async () => {
    const f = fixture({ settleFrames: 1, maxBytes: 500 });
    try {
      f.add('a', 510);
      f.add('b', 520);
      const secondCell = f.add('c', 760);
      f.add('d', 770);
      await f.settle();
      expect(f.chunks.diagnostics().buildingChunks).toBe(1);
      expect(secondCell.isEnabled()).toBe(true);
      expect(f.chunks.diagnostics().buildingChunkGeometryBytes).toBeLessThanOrEqual(500);
      await f.settle(new Vector3(375, 0, 0));
      expect(f.chunks.diagnostics().buildingChunks).toBe(1);
      expect(secondCell.isEnabled()).toBe(false);
      expect(f.chunks.diagnostics().buildingChunkGeometryBytes).toBeLessThanOrEqual(500);
    } finally {
      f.dispose();
    }
  });

  it('preserves world geometry, linear colors, wall surface and each original night origin', async () => {
    const f = fixture();
    try {
      const first = f.add('a');
      const second = f.add('b', 530);
      second.scaling.set(-2, 3, 1);
      second.computeWorldMatrix(true);
      const indicesBefore = [...second.getIndices()!];
      await f.settle();
      expect(f.chunks.diagnostics().buildingChunks).toBe(1);
      const [merged] = f.merged();
      expect(f.merged()).toHaveLength(1);
      expect(merged.getTotalVertices()).toBe(6);
      expect(merged.getVerticesData(VertexBuffer.PositionKind)).toEqual(
        new Float32Array([510, 2, 7, 510, 2, 9, 512, 2, 7, 530, 2, 7, 530, 2, 9, 526, 2, 7]),
      );
      expect(Array.from(merged.getIndices()!)).toEqual([0, 1, 2, 3, 5, 4]);
      expect(second.getIndices()).toEqual(indicesBefore);
      expect(merged.getVerticesData(VertexBuffer.NormalKind)![1]).toBe(1);
      const colors = merged.getVerticesData(VertexBuffer.ColorKind)!;
      expect(colors[0]).toBeCloseTo(0.2);
      expect(colors[1]).toBeCloseTo(0.45);
      expect(colors[2]).toBeCloseTo(0.8);
      expect((merged.material as PBRMaterial).albedoColor.asArray()).toEqual([1, 1, 1]);
      expect(Array.from(merged.getVerticesData(SURFACE_ATTRIBUTE)!)).toEqual([
        1002, 3, 1002, 4, 1003, 3, 1002, 3, 1002, 4, 1003, 3,
      ]);
      expect(Array.from(merged.getVerticesData(GLOW_ATTRIBUTE)!)).toEqual([
        1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2,
      ]);
      expect(Array.from(merged.getVerticesData(GLOW_ORIGIN_ATTRIBUTE)!)).toEqual([
        510, 7, 510, 7, 510, 7, 530, 7, 530, 7, 530, 7,
      ]);
      expect(first.isEnabled()).toBe(false);
      expect(f.chunks.isMeshMerged(first)).toBe(true);
      expect(f.shadows.getShadowMap()!.renderList!.map((mesh) => mesh.name)).toEqual([merged.name]);
      expect(merged.isPickable).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it('waits 45 updates and restores a near cell before rendering the next frame', async () => {
    const f = fixture({});
    try {
      const first = f.add('a'),
        second = f.add('b', 530);
      for (let i = 0; i < 44; i++) f.chunks.update(Vector3.Zero());
      expect(f.merged()).toHaveLength(0);
      await f.settle();
      expect(f.chunks.isMerged('a')).toBe(true);
      f.chunks.update(new Vector3(375, 0, 0));
      expect(f.merged()).toHaveLength(0);
      expect(first.isEnabled()).toBe(true);
      expect(second.isEnabled()).toBe(true);
      expect(f.shadows.getShadowMap()!.renderList!.map((mesh) => mesh.name)).toEqual([
        first.name,
        second.name,
      ]);
      expect(f.chunks.diagnostics().buildingChunkGeometryBytes).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('invalidates the whole cell on edits, culling and a distant occlusion ray', async () => {
    const f = fixture();
    try {
      const first = f.add('a'),
        second = f.add('b', 530);
      await f.settle();
      f.chunks.touch('a');
      expect(first.isEnabled()).toBe(true);
      expect(second.isEnabled()).toBe(true);
      first.position.y = 10;
      first.computeWorldMatrix(true);
      await f.settle();
      expect(f.merged()[0].getVerticesData(VertexBuffer.PositionKind)![1]).toBe(10);
      f.chunks.update(Vector3.Zero(), new Set(['b']));
      expect(f.merged()).toHaveLength(0);
      await f.settle();
      f.chunks.remove('a');
      expect(first.isEnabled()).toBe(true);
      expect(second.isEnabled()).toBe(true);
      expect(f.chunks.diagnostics().buildingChunkGeometryBytes).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('keeps material differences and shadow eligibility in separate draws', async () => {
    const f = fixture();
    try {
      for (const [id, x, shadow, roughness] of [
        ['a', 501, true, 0.9],
        ['b', 505, true, 0.9],
        ['c', 510, false, 0.9],
        ['d', 515, false, 0.9],
        ['e', 520, false, 0.4],
        ['f', 525, false, 0.4],
      ] as const)
        (f.add(id, x, shadow).material as PBRMaterial).roughness = roughness;
      await f.settle();
      expect(f.merged()).toHaveLength(3);
      expect(f.shadows.getShadowMap()!.renderList).toHaveLength(1);
      expect(
        f
          .merged()
          .map((mesh) => (mesh.material as PBRMaterial).roughness)
          .sort(),
      ).toEqual([0.4, 0.9, 0.9]);
    } finally {
      f.dispose();
    }
  });

  it('leaves unknown material plugins and custom attributes on their original meshes', async () => {
    const f = fixture();
    try {
      const first = f.add('a'),
        second = f.add('b', 530);
      const unsupported = f.add('custom', 540);
      new MaterialPluginBase(unsupported.material!, 'UnknownGeometryPlugin', 200);
      const customAttribute = f.add('attribute', 550);
      customAttribute.setVerticesData('customPosition', [1, 1, 1], false, 1);
      await f.settle();
      expect(first.isEnabled()).toBe(false);
      expect(second.isEnabled()).toBe(false);
      expect(unsupported.isEnabled()).toBe(true);
      expect(customAttribute.isEnabled()).toBe(true);
      expect(f.merged()[0].getTotalVertices()).toBe(6);
    } finally {
      f.dispose();
    }
  });

  it('caps duplicate geometry and releases all chunk resources', async () => {
    const f = fixture({ settleFrames: 1, maxBytes: 1, maxCellBytes: 1 });
    try {
      const first = f.add('a'),
        second = f.add('b', 530);
      const materials = f.scene.materials.length;
      const geometries = f.scene.geometries.length;
      await f.settle();
      expect(f.merged()).toHaveLength(0);
      expect(first.isEnabled() && second.isEnabled()).toBe(true);
      f.chunks.dispose();
      expect(f.scene.materials).toHaveLength(materials);
      expect(f.scene.geometries).toHaveLength(geometries);
      expect(f.chunks.diagnostics().buildingChunkGeometryBytes).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('prepares at most one distant cell per update', async () => {
    const f = fixture({ settleFrames: 1 });
    try {
      f.add('a', 510);
      f.add('b', 520);
      f.add('c', 760);
      f.add('d', 770);
      f.chunks.update(Vector3.Zero());
      expect(f.merged()).toHaveLength(1);
      f.chunks.update(Vector3.Zero());
      expect(f.merged()).toHaveLength(2);
      await f.settle();
      expect(f.chunks.diagnostics().buildingChunks).toBe(2);
      f.chunks.dispose();
      expect(f.merged()).toHaveLength(0);
      expect(f.chunks.diagnostics().buildingChunkGeometryBytes).toBe(0);
    } finally {
      f.dispose();
    }
  });
});
