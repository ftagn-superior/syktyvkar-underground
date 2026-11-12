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
  canonicalJson,
  validateBuildingParts,
  type BuildingInstance,
  type BuildingAssetManifest,
  type BuildingParts,
  type BuildingPart,
  type WorldDefinition,
  type WorldHeader,
  type WorldManifest,
} from '@su/contracts';
import { SpatialIndex } from './spatial-index';
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
  private readonly cache = new Map<
    string,
    { users: number; controller: AbortController; promise: Promise<Asset>; value?: Asset }
  >();
  private readonly references = new Map<
    string,
    { count: number; signature: string; view: BuildingView }
  >();
  private readonly index = new SpatialIndex();
  private readonly fading = new Set<string>();
  private readonly shadowed = new Set<string>();
  private readonly assets = new Map<string, Asset>();
  private readonly instances: BuildingView[] = [];
  private disposed = false;
  private prepared = false;

  constructor(
    private readonly scene: Scene,
    private readonly shadow: ShadowGenerator,
    private readonly definition: WorldDefinition | WorldHeader,
  ) {}

  async prepare(
    manifest: WorldManifest,
    readBytes: (path: string) => Promise<Uint8Array>,
  ): Promise<void> {
    if (this.prepared || this.disposed) throw new Error('Building views cannot be prepared twice');
    this.prepared = true;
    try {
      if (!('buildings' in this.definition))
        throw new Error('Use cell preparation for a world header');
      await this.prepareAssets(
        manifest,
        [...new Set(this.definition.buildings.map((item) => item.assetId))],
        readBytes,
      );
      for (const building of this.definition.buildings)
        this.add(building, manifest.assets[building.assetId].version);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** A cell pins parsed models while prepared/active. Cancel its last reservation to abort I/O. */
  async prepareAssets(
    manifest: WorldManifest,
    ids: string[],
    read: (path: string, signal?: AbortSignal) => Promise<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (this.disposed || signal?.aborted)
      throw new DOMException('Preparation cancelled', 'AbortError');
    const releases: (() => void)[] = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', release);
      for (const dispose of releases) dispose();
    };
    try {
      const promises = [...new Set(ids)].map((id) => {
        const descriptor = manifest.assets[id];
        if (!descriptor) throw new Error(`Unknown building model: ${id}`);
        let record = this.cache.get(descriptor.version);
        if (!record) {
          const controller = new AbortController();
          record = {
            users: 0,
            controller,
            promise: this.loadAsset(descriptor, (path) => read(path, controller.signal)),
          };
          this.cache.set(descriptor.version, record);
          const entry = record;
          record.promise = record.promise.then((asset) => {
            if (this.cache.get(descriptor.version) !== entry || this.disposed) {
              asset.container.dispose();
              if (this.assets.get(descriptor.version) === asset)
                this.assets.delete(descriptor.version);
              throw new DOMException('Preparation cancelled', 'AbortError');
            }
            entry.value = asset;
            this.assets.set(descriptor.version, asset);
            return asset;
          });
        }
        const entry = record;
        entry.users++;
        releases.push(() => {
          if (--entry.users) return;
          entry.controller.abort();
          if (this.cache.get(descriptor.version) === entry) this.cache.delete(descriptor.version);
          if (entry.value) {
            entry.value.container.dispose();
            if (this.assets.get(descriptor.version) === entry.value)
              this.assets.delete(descriptor.version);
          }
        });
        return entry.promise;
      });
      signal?.addEventListener('abort', release, { once: true });
      const results = await Promise.allSettled(promises);
      if (this.disposed || released) throw new DOMException('Preparation cancelled', 'AbortError');
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      // Once prepared, the caller owns this pin until its last instance has been removed.
      signal?.removeEventListener('abort', release);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  add(definition: BuildingInstance, version: string): void {
    if (this.disposed) throw new Error('Building views disposed');
    const signature = version + canonicalJson(definition);
    const previous = this.references.get(definition.entityId);
    if (previous) {
      if (signature !== previous.signature)
        throw new Error(`Conflicting building/version: ${definition.entityId}`);
      previous.count++;
      return;
    }
    const asset = this.assets.get(version);
    if (!asset || asset.descriptor.assetId !== definition.assetId)
      throw new Error('Model is not prepared');
    const view = this.instantiate(definition, asset);
    this.instances.push(view);
    this.references.set(definition.entityId, { count: 1, signature, view });
    this.index.add(definition.entityId, { min: plain(view.minimum), max: plain(view.maximum) });
    this.shadowed.add(definition.entityId);
  }
  remove(id: string): void {
    const entry = this.references.get(id);
    if (!entry || --entry.count > 0) return;
    this.references.delete(id);
    this.index.remove(id);
    this.fading.delete(id);
    this.shadowed.delete(id);
    const instance = entry.view;
    this.instances.splice(this.instances.indexOf(instance), 1);
    for (const mesh of instance.meshes) this.shadow.removeShadowCaster(mesh);
    instance.entries.dispose();
    instance.root.dispose();
    for (const material of instance.materials) material.dispose(false, false);
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
    const selected = new Set(this.fading);
    for (const ray of rays) {
      const end = ray.origin.add(ray.direction.scale(ray.length));
      for (const id of this.index.query({
        min: Vector3.Minimize(ray.origin, end),
        max: Vector3.Maximize(ray.origin, end),
      }))
        selected.add(id);
    }
    const shadowCandidates = ownPosition
      ? this.index.query({
          min: ownPosition.subtract(new Vector3(80, 0, 80)),
          max: ownPosition.add(new Vector3(80, 0, 80)),
        })
      : new Set(this.references.keys());
    for (const id of new Set([...this.shadowed, ...shadowCandidates])) {
      const entry = this.references.get(id);
      if (!entry) continue;
      const enabled = shadowCandidates.has(id);
      if (enabled === this.shadowed.has(id)) continue;
      if (enabled) this.shadowed.add(id);
      else this.shadowed.delete(id);
      for (const mesh of entry.view.meshes) this.shadow.removeShadowCaster(mesh);
      if (enabled) {
        for (const mesh of entry.view.meshes) this.shadow.addShadowCaster(mesh);
        for (const group of entry.view.groups)
          if (!group.castsShadow)
            for (const mesh of group.meshes) this.shadow.removeShadowCaster(mesh);
      }
    }
    for (const id of selected) {
      const instance = this.references.get(id)?.view;
      if (!instance) continue;
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
            if (castsShadow && this.shadowed.has(id)) this.shadow.addShadowCaster(mesh);
            else this.shadow.removeShadowCaster(mesh);
          }
        }
      }
      if (instance.groups.some((group) => group.fade.opacity < 1 || group.fade.blocked))
        this.fading.add(id);
      else this.fading.delete(id);
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
    for (const [id, entry] of this.references) {
      entry.count = 1;
      this.remove(id);
    }
    for (const entry of this.cache.values()) entry.controller.abort();
    for (const { container } of this.assets.values()) container.dispose();
    this.assets.clear();
    this.cache.clear();
  }
}
