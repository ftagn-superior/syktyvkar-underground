import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Material } from '@babylonjs/core/Materials/material';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion } from '@babylonjs/core/Maths/math.vector';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import { validateBuildingParts, type BuildingAssetManifest, type ItemPose } from '@su/contracts';
import { loadBuildingContainer } from './building-container';
import { treeTemplate } from './tree-geometry';
import { TreeMaterial, TREE_ATTRIBUTES } from './tree-material';

export type ModelResourceReader = (path: string, signal?: AbortSignal) => Promise<Uint8Array>;
export type ModelVisual = Awaited<ReturnType<typeof createModelVisual>>;

/** One owned visual, outside world batches and physics. Both views use the released recipe. */
export async function createModelVisual(
  scene: Scene,
  descriptor: BuildingAssetManifest,
  read: ModelResourceReader,
  purpose: 'catalog-preview' | 'placement-ghost',
  signal?: AbortSignal,
) {
  const assertActive = () => {
    signal?.throwIfAborted();
    if (scene.isDisposed) throw new Error('Model scene disposed');
  };
  assertActive();
  const parts = validateBuildingParts(
    JSON.parse(new TextDecoder().decode(await read(descriptor.partsFile, signal))),
  );
  assertActive();
  if (parts.assetId !== descriptor.assetId) throw new Error('Model asset mismatch');
  const ghost = purpose === 'placement-ghost';
  const root = new TransformNode(`model-visual:${descriptor.assetId}`, scene);
  const disposers: Array<() => void> = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.dispose(false, false);
    for (const release of disposers.reverse()) release();
  };
  try {
    if (parts.tree) {
      if (descriptor.modelFile) throw new Error('Tree must not include a GLB');
      const recipe = parts.tree;
      const data = treeTemplate(recipe.crownColor, recipe.trunkColor, recipe.foliage);
      const mesh = new Mesh(`model-tree:${descriptor.assetId}`, scene);
      mesh.parent = root;
      mesh.sideOrientation = Material.CounterClockWiseSideOrientation;
      const vertices = new VertexData();
      Object.assign(vertices, data);
      vertices.applyToMesh(mesh);
      mesh.setVerticesData('suTreePart', data.parts, false, 1);
      // The same shader as world trees, with one recipe supplied at each vertex.
      // This is a regular mesh: it owns no thin-instance batch or world references.
      const attributes = [
        recipe.crowns[0],
        recipe.crowns[1],
        recipe.trunk,
        [0, 1, recipe.trunkBase, 0],
      ];
      for (let i = 0; i < TREE_ATTRIBUTES.length; i++) {
        const values = new Float32Array((data.positions.length / 3) * 4);
        for (let offset = 0; offset < values.length; offset += 4) values.set(attributes[i], offset);
        mesh.setVerticesData(TREE_ATTRIBUTES[i], values, false, 4);
      }
      mesh.setBoundingInfo(
        new BoundingInfo(
          new Vector3(descriptor.bounds.min.x, descriptor.bounds.min.y, descriptor.bounds.min.z),
          new Vector3(descriptor.bounds.max.x, descriptor.bounds.max.y, descriptor.bounds.max.z),
        ),
      );
      const material = new PBRMaterial(`model-tree-material:${descriptor.assetId}`, scene);
      material.metallic = 0;
      material.roughness = 0.9;
      new TreeMaterial(material, undefined, recipe.foliage);
      if (ghost) {
        mesh.useVertexColors = false;
        material.albedoColor = Color3.FromHexString('#b8c5d6');
        material.emissiveColor = material.albedoColor.scale(0.2);
        material.alpha = 0.5;
        material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      }
      mesh.material = material;
      mesh.isPickable = false;
      disposers.push(() => material.dispose());
    } else {
      if (!descriptor.modelFile) throw new Error('GLB asset is missing its model');
      const bytes = await read(descriptor.modelFile, signal);
      assertActive();
      const container = await loadBuildingContainer(bytes, scene, `${descriptor.assetId}.glb`);
      disposers.push(() => container.dispose());
      assertActive();
      const entries = container.instantiateModelsToScene((name) => `model-visual:${name}`, false, {
        doNotInstantiate: true,
      });
      disposers.push(() => entries.dispose());
      for (const node of entries.rootNodes) node.parent = root;
      let material: StandardMaterial | undefined;
      if (ghost) {
        material = new StandardMaterial('model-ghost', scene);
        material.diffuseColor = Color3.FromHexString('#b8c5d6');
        material.emissiveColor = material.diffuseColor.scale(0.25);
        material.alpha = 0.5;
        disposers.push(() => material!.dispose());
      }
      for (const mesh of root.getChildMeshes()) {
        mesh.isPickable = false;
        if (material) {
          mesh.material = material;
          mesh.useVertexColors = false;
        }
      }
    }
    assertActive();
    root.setEnabled(!ghost);
    return {
      root,
      bounds: descriptor.bounds,
      show: (pose?: ItemPose) => {
        root.setEnabled(!!pose);
        if (!pose) return;
        root.position.set(pose.position.x, pose.position.y, pose.position.z);
        root.rotationQuaternion = new Quaternion(
          pose.rotation.x,
          pose.rotation.y,
          pose.rotation.z,
          pose.rotation.w,
        );
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
