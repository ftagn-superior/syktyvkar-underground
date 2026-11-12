import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { Scene } from '@babylonjs/core/scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Material } from '@babylonjs/core/Materials/material';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import '@babylonjs/loaders/glTF/2.0/Extensions/ExtrasAsMetadata';

/** A failed glTF parse does not return a container; release only this loader's resources. */
export async function loadBuildingContainer(model: Uint8Array, scene: Scene, name: string) {
  const meshes = new Set<AbstractMesh>();
  const materials = new Set<Material>();
  const textures = new Set<BaseTexture>();
  try {
    return await LoadAssetContainerAsync(model, scene, {
      pluginExtension: '.glb',
      name,
      pluginOptions: {
        gltf: {
          createInstances: false,
          animationStartMode: 0,
          onMeshLoaded: (mesh) => meshes.add(mesh),
          onMaterialLoaded: (material) => materials.add(material),
          onTextureLoaded: (texture) => textures.add(texture),
        },
      },
    });
  } catch (error) {
    for (const mesh of meshes) mesh.dispose(false, false);
    for (const material of materials) material.dispose(false, false);
    for (const texture of textures) texture.dispose();
    throw error;
  }
}
