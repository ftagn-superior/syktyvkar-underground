import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Material } from '@babylonjs/core/Materials/material';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer, InstantiatedEntries } from '@babylonjs/core/assetContainer';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { Node } from '@babylonjs/core/node';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import type { Ray } from '@babylonjs/core/Culling/ray';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import '@babylonjs/loaders/glTF/2.0/Extensions/ExtrasAsMetadata';
import {
  validateBuildingParts,
  type BuildingInstance,
  type BuildingAssetManifest,
  type BuildingParts,
  type BuildingPart,
  type WorldDefinition,
  type WorldManifest,
} from '@su/contracts';
import { OcclusionFade, orthographicSightRay } from './occlusion';

type Asset = { descriptor: BuildingAssetManifest; container: AssetContainer; parts: BuildingParts };
type FadingMaterial = { material: Material; alpha: number; mode: number | null };
type Group = {
  id: string;
  meshes: Mesh[];
  materials: FadingMaterial[];
  fade: OcclusionFade;
  castsShadow: boolean;
};
type BuildingView = {
  definition: BuildingInstance;
  root: TransformNode;
  entries: InstantiatedEntries;
  meshes: Mesh[];
  materials: Set<Material>;
  groups: Group[];
  minimum: Vector3;
  maximum: Vector3;
};
const plain = ({ x, y, z }: Vector3) => ({ x, y, z });

function semanticPart(node: Node): BuildingPart | undefined {
  let current: Node | null = node;
  while (current) {
    const part = current.metadata?.gltf?.extras?.su;
    if (part && typeof part.partId === 'string') return part;
    current = current.parent;
  }
}

/** One parsed template per content version; model data never comes from network entity state. */
export class BuildingViews {
  private readonly cache = new Map<string, Promise<Asset>>();
  private readonly assets = new Map<string, Asset>();
  private readonly instances: BuildingView[] = [];
  private disposed = false;
  private prepared = false;

  constructor(
    private readonly scene: Scene,
    private readonly shadow: ShadowGenerator,
    private readonly definition: WorldDefinition,
  ) {}

  async prepare(
    manifest: WorldManifest,
    readBytes: (path: string) => Promise<Uint8Array>,
  ): Promise<void> {
    if (this.prepared || this.disposed) throw new Error('Building views cannot be prepared twice');
    this.prepared = true;
    try {
      const unique = [...new Set(this.definition.buildings.map((building) => building.assetId))];
      const loaded = new Map<string, Asset>();
      // Every model is read once even when many cells refer to it. A small concurrency limit
      // prevents hundreds of distinct assets from starting hundreds of decoders at once.
      for (let offset = 0; offset < unique.length; offset += 4) {
        const batch = unique.slice(offset, offset + 4);
        const results = await Promise.allSettled(
          batch.map(async (assetId) => {
            const descriptor = manifest.assets[assetId];
            if (!descriptor) throw new Error(`Missing building asset: ${assetId}`);
            let promise = this.cache.get(descriptor.version);
            if (!promise) {
              promise = this.loadAsset(descriptor, readBytes);
              this.cache.set(descriptor.version, promise);
            }
            loaded.set(assetId, await promise);
          }),
        );
        // glTF decoding can still be importing material code when another asset fails.
        // Keep the scene alive until every started loader has settled; a late loader
        // can create scene-owned resources (such as the shared BRDF lookup texture).
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
      for (const building of this.definition.buildings) {
        if (this.disposed) throw new Error('Building preparation was cancelled');
        this.instances.push(this.instantiate(building, loaded.get(building.assetId)!));
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private async loadAsset(
    descriptor: BuildingAssetManifest,
    readBytes: (path: string) => Promise<Uint8Array>,
  ): Promise<Asset> {
    const [model, partsBytes] = await Promise.all([
      readBytes(descriptor.modelFile),
      readBytes(descriptor.partsFile),
    ]);
    const parts = validateBuildingParts(JSON.parse(new TextDecoder().decode(partsBytes)));
    if (parts.assetId !== descriptor.assetId) throw new Error('Building part asset mismatch');
    if (this.disposed) throw new Error('Building preparation was cancelled');
    // A failed glTF parse does not return its partially populated AssetContainer.
    // Keep loader-owned resources until success so that errors can release them as well.
    const meshes = new Set<AbstractMesh>();
    const materials = new Set<Material>();
    const textures = new Set<BaseTexture>();
    let container: AssetContainer;
    try {
      container = await LoadAssetContainerAsync(model, this.scene, {
        pluginExtension: '.glb',
        name: `${descriptor.assetId}.glb`,
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
    if (this.disposed) {
      container.dispose();
      throw new Error('Building preparation was cancelled');
    }
    const asset = { descriptor, container, parts };
    this.assets.set(descriptor.version, asset);
    return asset;
  }

  private instantiate(definition: BuildingInstance, asset: Asset): BuildingView {
    const existingNodes = new Set([...this.scene.meshes, ...this.scene.transformNodes]);
    const root = new TransformNode(definition.entityId, this.scene);
    let entries: InstantiatedEntries | undefined;
    const ownedMaterials = new Set<Material>();
    try {
      entries = asset.container.instantiateModelsToScene(
        (name) => `${definition.entityId}:${name}`,
        false,
        { doNotInstantiate: true },
      );
      root.position.set(definition.position.x, definition.position.y, definition.position.z);
      root.rotationQuaternion = new Quaternion(
        definition.rotation.x,
        definition.rotation.y,
        definition.rotation.z,
        definition.rotation.w,
      );
      for (const node of entries.rootNodes) node.parent = root;
      root.computeWorldMatrix(true);
      const meshes = root
        .getChildMeshes()
        .filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0);
      const partMap = new Map(asset.parts.parts.map((part) => [part.partId, part]));
      const seenParts = new Set<string>();
      const groups = new Map<string, Group>();
      const groupMaterials = new Map<string, Map<number, Material>>();
      const copyMaterial = (source: Material, group: Group): Material => {
        let materials = groupMaterials.get(group.id);
        if (!materials) groupMaterials.set(group.id, (materials = new Map()));
        let copy = materials.get(source.uniqueId);
        if (copy) return copy;
        copy = source.clone(`${definition.entityId}:${group.id}:${source.name}`) ?? undefined;
        if (!copy) throw new Error(`Building material cannot be cloned: ${source.name}`);
        materials.set(source.uniqueId, copy);
        ownedMaterials.add(copy);
        if (copy instanceof MultiMaterial && source instanceof MultiMaterial) {
          copy.subMaterials = source.subMaterials.map((child) =>
            child ? copyMaterial(child, group) : null,
          );
        } else {
          group.materials.push({ material: copy, alpha: copy.alpha, mode: copy.transparencyMode });
        }
        return copy;
      };
      for (const mesh of meshes) {
        const semantic = semanticPart(mesh);
        const part = semantic && partMap.get(semantic.partId);
        if (
          !part ||
          part.role !== semantic!.role ||
          part.occlusionGroup !== semantic!.occlusionGroup
        )
          throw new Error(`Invalid building semantic part in ${definition.entityId}`);
        seenParts.add(part.partId);
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        mesh.computeWorldMatrix(true);
        mesh.freezeWorldMatrix();
        this.shadow.addShadowCaster(mesh);
        if (part.occlusionGroup !== null) {
          let group = groups.get(part.occlusionGroup);
          if (!group) {
            group = {
              id: part.occlusionGroup,
              meshes: [],
              materials: [],
              fade: new OcclusionFade(),
              castsShadow: true,
            };
            groups.set(group.id, group);
          }
          group.meshes.push(mesh);
          if (mesh.material) mesh.material = copyMaterial(mesh.material, group);
        }
      }
      if (seenParts.size !== partMap.size)
        throw new Error(`Building model has missing parts: ${definition.assetId}`);
      const bounds = root.getHierarchyBoundingVectors(true);
      return {
        definition,
        root,
        entries,
        meshes,
        materials: ownedMaterials,
        groups: [...groups.values()],
        minimum: bounds.min,
        maximum: bounds.max,
      };
    } catch (error) {
      for (const mesh of root.getChildMeshes()) this.shadow.removeShadowCaster(mesh);
      entries?.dispose();
      root.dispose();
      // Also cover a cloning failure before Babylon returned InstantiatedEntries.
      for (const node of [...this.scene.meshes, ...this.scene.transformNodes]) {
        if (!existingNodes.has(node)) node.dispose();
      }
      for (const material of ownedMaterials) material.dispose(false, false);
      throw error;
    }
  }

  update(
    ownPosition: Vector3 | undefined,
    cameraPosition: Vector3,
    direction: Vector3,
    cameraNear: number,
    now: number,
    seconds: number,
  ): void {
    const rays: Ray[] = [];
    if (ownPosition) {
      const { height, radius } = this.definition.simulation.character;
      const right = new Vector3(-direction.z, 0, direction.x).normalize();
      for (const [vertical, horizontal] of [
        [height / 2 - radius / 2, 0],
        [0, 0],
        [-height / 2 + radius / 2, 0],
        [0, radius * 0.8],
        [0, -radius * 0.8],
      ]) {
        const sample = ownPosition.add(right.scale(horizontal));
        sample.y += vertical;
        rays.push(orthographicSightRay(cameraPosition, direction, sample, cameraNear));
      }
    }
    for (const instance of this.instances) {
      const candidates = rays.filter(
        (ray) => ray.length > 0 && ray.intersectsBoxMinMax(instance.minimum, instance.maximum),
      );
      for (const group of instance.groups) {
        // Each group and each building is tested: the nearest hit must not hide a second blocker.
        const blocked = candidates.some((ray) =>
          group.meshes.some((mesh) => {
            const hit = ray.intersectsMesh(mesh, true);
            return hit.hit && hit.distance < ray.length;
          }),
        );
        const opacity = group.fade.update(blocked, now, seconds);
        for (const { material, alpha, mode } of group.materials) {
          material.alpha = alpha * opacity;
          material.transparencyMode = opacity < 1 ? Material.MATERIAL_ALPHABLEND : mode;
        }
        const castsShadow = opacity >= 0.98;
        if (castsShadow !== group.castsShadow) {
          group.castsShadow = castsShadow;
          for (const mesh of group.meshes) {
            if (castsShadow) this.shadow.addShadowCaster(mesh);
            else this.shadow.removeShadowCaster(mesh);
          }
        }
      }
    }
  }

  aggregateDiagnostics() {
    return {
      instances: this.instances.length,
      assets: this.assets.size,
      modelLoads: this.assets.size,
      fadedBuildings: this.instances.filter((instance) =>
        instance.groups.some((group) => group.fade.opacity < 0.99),
      ).length,
    };
  }
  diagnostics() {
    return {
      assets: [...this.assets.values()].map(({ descriptor }) => ({
        assetId: descriptor.assetId,
        version: descriptor.version,
        loads: 1,
        instances: this.instances.filter(
          (instance) => instance.definition.assetId === descriptor.assetId,
        ).length,
      })),
      buildings: this.instances.map((instance) => ({
        entityId: instance.definition.entityId,
        assetId: instance.definition.assetId,
        position: { ...instance.definition.position },
        rotation: { ...instance.definition.rotation },
        bounds: { min: plain(instance.minimum), max: plain(instance.maximum) },
        opacity: Math.min(1, ...instance.groups.map((group) => group.fade.opacity)),
        occluded: instance.groups.some((group) => group.fade.blocked),
        groups: instance.groups.map((group) => ({
          id: group.id,
          opacity: group.fade.opacity,
          occluded: group.fade.blocked,
        })),
      })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const instance of this.instances) {
      for (const mesh of instance.meshes) this.shadow.removeShadowCaster(mesh);
      instance.entries.dispose();
      instance.root.dispose();
      for (const material of instance.materials) material.dispose(false, false);
    }
    this.instances.length = 0;
    for (const { container } of this.assets.values()) container.dispose();
    this.assets.clear();
    this.cache.clear();
  }
}
