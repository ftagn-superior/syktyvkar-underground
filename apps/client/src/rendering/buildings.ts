import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Material } from '@babylonjs/core/Materials/material';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { loadBuildingContainer } from './building-container';
import type { AssetContainer, InstantiatedEntries } from '@babylonjs/core/assetContainer';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { Node } from '@babylonjs/core/node';
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
import { TreeViews } from './trees';
import { GlbInstances } from './glb-instances';
import { applyRadialFog, type RadialState } from './radial-fog';
import {
  staticHitVisible,
  staticObjectSelection,
  staticRayBounds,
  type StaticObjectHit,
  type StaticObjectSelection,
} from './static-selection';
import { adoptGlowAttribute, type WorldNightLights } from './environment/night-lights';
import { adoptSurfaceAttribute } from './environment/wall-surface';

type Asset = {
  descriptor: BuildingAssetManifest;
  container?: AssetContainer;
  parts: BuildingParts;
};
type FadingMaterial = { material: Material; alpha: number; mode: number | null };
type Group = {
  id: string;
  meshes: Mesh[];
  /** Общие материалы шаблона, по одному на меш; ими группа рисуется, пока непрозрачна. */
  shared: (Material | null)[];
  /** Собственные копии, по одной на меш; создаются при первом затухании группы. */
  owned?: (Material | null)[];
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
  /** Наибольший габарит в метрах: мелкие объекты скрываются на дальнем масштабе. */
  size: number;
};
/** Геометрическая проверка заслонения дороже затухания и не нужна чаще 20 раз в секунду. */
const OCCLUSION_TEST_INTERVAL_MS = 50;
/** Объект меньше этого числа пикселей на экране не рисуется. */
const MIN_VISIBLE_PIXELS = 5;
const plain = ({ x, y, z }: Vector3) => ({ x, y, z });
// Bound parsing as well as I/O: cells share the global VerifiedResources queue.
const MODEL_PREPARATION_CONCURRENCY = 4;

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
  private readonly trees: TreeViews;
  private readonly glbs: GlbInstances;
  private lastOcclusionTest = -Infinity;
  private opaque = false;
  private minimumVisibleSize = 0;
  /** Число владельцев экземпляров со своими фонарями: источник света один на экземпляр. */
  private readonly lit = new Map<string, number>();
  private readonly lifecycle = { modelImports: 0, instancesCreated: 0, instancesRemoved: 0 };

  constructor(
    private readonly scene: Scene,
    private readonly shadow: ShadowGenerator,
    private readonly definition: WorldDefinition | WorldHeader,
    private readonly radial?: RadialState,
    private readonly nightLights?: WorldNightLights,
  ) {
    this.trees = new TreeViews(scene, shadow, radial);
    this.glbs = new GlbInstances(scene, shadow, radial);
  }

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
    const pendingIds = [...new Set(ids)];
    let next = 0;
    const worker = async () => {
      try {
        for (;;) {
          if (this.disposed || released || signal?.aborted)
            throw new DOMException('Preparation cancelled', 'AbortError');
          const id = pendingIds[next++];
          if (id === undefined) return;
          const descriptor = manifest.assets[id];
          if (!descriptor) throw new Error(`Unknown building model: ${id}`);
          let record = this.cache.get(descriptor.version);
          if (!record) {
            const controller = new AbortController();
            record = {
              users: 0,
              controller,
              promise: Promise.resolve().then(() => {
                if (controller.signal.aborted || this.disposed)
                  throw new DOMException('Preparation cancelled', 'AbortError');
                return this.loadAsset(descriptor, (path) => read(path, controller.signal));
              }),
            };
            this.cache.set(descriptor.version, record);
            const entry = record;
            record.promise = record.promise.then((asset) => {
              if (this.cache.get(descriptor.version) !== entry || this.disposed) {
                asset.container?.dispose();
                if (this.assets.get(descriptor.version) === asset)
                  this.assets.delete(descriptor.version);
                throw new DOMException('Preparation cancelled', 'AbortError');
              }
              try {
                if (asset.parts.renderMode === 'thin-instance')
                  this.glbs.prepare(descriptor, asset.parts, asset.container!);
              } catch (error) {
                asset.container?.dispose();
                throw error;
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
              this.glbs.release(descriptor.version);
              entry.value.container?.dispose();
              if (this.assets.get(descriptor.version) === entry.value)
                this.assets.delete(descriptor.version);
            }
          });
          await entry.promise;
        }
      } catch (error) {
        // Stop the other workers before any can reserve the next model. Shared
        // reservations owned by another cell stay alive through the reference count.
        release();
        throw error;
      }
    };
    signal?.addEventListener('abort', release, { once: true });
    const workers = Array.from(
      { length: Math.min(MODEL_PREPARATION_CONCURRENCY, pendingIds.length) },
      worker,
    );
    try {
      await Promise.all(workers);
      if (this.disposed || released) throw new DOMException('Preparation cancelled', 'AbortError');
      // Once prepared, the caller owns this pin until its last instance has been removed.
      signal?.removeEventListener('abort', release);
      return release;
    } catch (error) {
      release();
      // A loader may complete after abort. Drain the bounded in-flight set so its
      // generation guard has disposed all abandoned containers before reporting failure.
      await Promise.allSettled(workers);
      throw error;
    }
  }
  add(definition: BuildingInstance, version: string): TransformNode | undefined {
    if (this.disposed) throw new Error('Building views disposed');
    const root = this.addView(definition, version);
    const lights = this.assets.get(version)?.parts.lights;
    if (lights && this.nightLights) {
      const owners = this.lit.get(definition.entityId) ?? 0;
      if (!owners) this.nightLights.addSources(definition, lights);
      this.lit.set(definition.entityId, owners + 1);
    }
    return root;
  }
  private addView(definition: BuildingInstance, version: string): TransformNode | undefined {
    const signature = version + canonicalJson(definition);
    const previous = this.references.get(definition.entityId);
    if (previous) {
      if (signature !== previous.signature)
        throw new Error(`Conflicting building/version: ${definition.entityId}`);
      previous.count++;
      return previous.view.root;
    }
    const asset = this.assets.get(version);
    if (!asset || asset.descriptor.assetId !== definition.assetId)
      throw new Error('Model is not prepared');
    if (!asset.container && asset.parts.tree) {
      if (this.glbs.has(definition.entityId))
        throw new Error(`Conflicting building/version: ${definition.entityId}`);
      const existed = this.trees.has(definition.entityId);
      this.trees.add(definition, asset.descriptor, asset.parts.tree, signature);
      if (!existed) this.lifecycle.instancesCreated++;
      return;
    }
    if (this.trees.has(definition.entityId))
      throw new Error(`Conflicting building/version: ${definition.entityId}`);
    if (asset.parts.renderMode === 'thin-instance') {
      const existed = this.glbs.has(definition.entityId);
      this.glbs.add(definition, version, signature);
      if (!existed) this.lifecycle.instancesCreated++;
      return;
    }
    if (this.glbs.has(definition.entityId))
      throw new Error(`Conflicting building/version: ${definition.entityId}`);
    const view = this.instantiate(definition, asset);
    if (view.size < this.minimumVisibleSize) view.root.setEnabled(false);
    this.instances.push(view);
    this.references.set(definition.entityId, { count: 1, signature, view });
    this.lifecycle.instancesCreated++;
    this.index.add(definition.entityId, { min: plain(view.minimum), max: plain(view.maximum) });
    this.shadowed.add(definition.entityId);
    return view.root;
  }
  remove(id: string): void {
    const owners = this.lit.get(id);
    if (owners !== undefined) {
      if (owners > 1) this.lit.set(id, owners - 1);
      else {
        this.lit.delete(id);
        this.nightLights?.removeSources(id);
      }
    }
    if (this.glbs.has(id)) {
      this.glbs.remove(id);
      if (!this.glbs.has(id)) this.lifecycle.instancesRemoved++;
      return;
    }
    if (this.trees.has(id)) {
      this.trees.remove(id);
      if (!this.trees.has(id)) this.lifecycle.instancesRemoved++;
      return;
    }
    const entry = this.references.get(id);
    if (!entry || --entry.count > 0) return;
    this.references.delete(id);
    this.lifecycle.instancesRemoved++;
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

  selection(id: string): StaticObjectSelection | undefined {
    const view = this.references.get(id)?.view;
    if (view?.root.isEnabled())
      return staticObjectSelection(view.definition, view.minimum, view.maximum);
    return this.glbs.selection(id) ?? this.trees.selection(id);
  }

  /** Only called by the explicit removal tool; ordinary pointer movement never scans meshes. */
  pick(ray: Ray, protectedIds: ReadonlySet<string> = new Set()): StaticObjectHit | undefined {
    let nearest = this.glbs.pick(ray, protectedIds);
    const tree = this.trees.pick(ray, protectedIds);
    if (tree && (!nearest || tree.distance < nearest.distance)) nearest = tree;
    for (const id of this.index.query(staticRayBounds(ray))) {
      const view = this.references.get(id)?.view;
      if (
        protectedIds.has(id) ||
        !view?.root.isEnabled() ||
        !ray.intersectsBoxMinMax(view.minimum, view.maximum)
      )
        continue;
      for (const mesh of view.meshes) {
        if (!mesh.isVisible || mesh.visibility <= 0 || !mesh.isEnabled()) continue;
        const hit = ray.intersectsMesh(mesh, false);
        if (
          hit.hit &&
          hit.distance <= ray.length &&
          (!nearest || hit.distance < nearest.distance) &&
          staticHitVisible(this.radial, ray, hit.distance, mesh.metadata?.suStreamingBorn)
        )
          nearest = {
            ...staticObjectSelection(view.definition, view.minimum, view.maximum),
            distance: hit.distance,
          };
      }
    }
    return nearest;
  }
  /** Сообщает масштаб кадра; объекты мельче нескольких пикселей перестают рисоваться. */
  setDetailScale(metresPerPixel: number): void {
    const minimum = metresPerPixel * MIN_VISIBLE_PIXELS;
    if (minimum === this.minimumVisibleSize) return;
    this.minimumVisibleSize = minimum;
    this.glbs.setDetailScale(minimum);
    let changed = false;
    for (const view of this.instances) {
      const enabled = view.size >= minimum;
      if (view.root.isEnabled(false) === enabled) continue;
      view.root.setEnabled(enabled);
      changed = true;
    }
    // Hidden objects stop casting without leaving the caster list.
    if (changed) this.shadow.getShadowMap()?.resetRefreshCounter();
  }
  /**
   * Копии материалов нужны только для затухания. Пока здание непрозрачно, оно рисуется
   * общими материалами шаблона: без клонирования при появлении и без лишних привязок.
   */
  private ownMaterials(view: BuildingView, group: Group): void {
    if (group.owned) return;
    const copies = new Map<number, Material>();
    const copy = (source: Material): Material => {
      let result = copies.get(source.uniqueId);
      if (result) return result;
      result = source.clone(`${view.definition.entityId}:${group.id}:${source.name}`) ?? undefined;
      if (!result) throw new Error(`Building material cannot be cloned: ${source.name}`);
      copies.set(source.uniqueId, result);
      view.materials.add(result);
      if (result instanceof MultiMaterial && source instanceof MultiMaterial) {
        result.subMaterials = source.subMaterials.map((child) => (child ? copy(child) : null));
      } else {
        group.materials.push({
          material: result,
          alpha: result.alpha,
          mode: result.transparencyMode,
        });
      }
      return result;
    };
    group.owned = group.shared.map((material) => (material ? copy(material) : null));
  }
  private useMaterials(group: Group, owned: boolean): void {
    const materials = owned ? group.owned! : group.shared;
    for (let i = 0; i < group.meshes.length; i++) {
      const mesh = group.meshes[i];
      if (mesh.material === materials[i]) continue;
      mesh.material = materials[i];
      // Потоковый туман подключается к материалу; копии получают его при первом показе.
      if (owned && this.radial && mesh.metadata?.suStreamingBorn !== undefined)
        applyRadialFog(mesh, this.radial, mesh.metadata.suStreamingBorn);
    }
  }
  private async loadAsset(
    descriptor: BuildingAssetManifest,
    readBytes: (path: string) => Promise<Uint8Array>,
  ): Promise<Asset> {
    const partsBytes = await readBytes(descriptor.partsFile);
    const parts = validateBuildingParts(JSON.parse(new TextDecoder().decode(partsBytes)));
    if (parts.assetId !== descriptor.assetId) throw new Error('Building part asset mismatch');
    if (this.disposed) throw new Error('Building preparation was cancelled');
    if (parts.tree) {
      if (descriptor.modelFile !== undefined)
        throw new Error('Instanced tree must not include a GLB');
      if (!this.trees.supported)
        throw new Error('Для отображения деревьев требуется поддержка GPU instancing');
      return { descriptor, parts };
    }
    if (!descriptor.modelFile) throw new Error('GLB asset is missing its model');
    const model = await readBytes(descriptor.modelFile);
    this.lifecycle.modelImports++;
    const container = await loadBuildingContainer(model, this.scene, `${descriptor.assetId}.glb`);
    // Ночное свечение едет в TEXCOORD_0; переносим его в свой атрибут до клонирования.
    if (parts.glow)
      for (const mesh of container.meshes) if (mesh instanceof Mesh) adoptGlowAttribute(mesh);
    // Материал стен едет в TEXCOORD_1; так же переносим его до клонирования.
    for (const mesh of container.meshes) if (mesh instanceof Mesh) adoptSurfaceAttribute(mesh);
    if (this.disposed) {
      container.dispose();
      throw new Error('Building preparation was cancelled');
    }
    return { descriptor, container, parts };
  }

  private instantiate(definition: BuildingInstance, asset: Asset): BuildingView {
    // Babylon clones synchronously and appends new nodes to these arrays. Recording
    // their lengths avoids copying the entire growing city for every instance.
    const firstMesh = this.scene.meshes.length;
    const firstTransform = this.scene.transformNodes.length;
    const root = new TransformNode(definition.entityId, this.scene);
    let entries: InstantiatedEntries | undefined;
    const ownedMaterials = new Set<Material>();
    try {
      entries = asset.container!.instantiateModelsToScene(
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
      root.freezeWorldMatrix();
      const meshes = root
        .getChildMeshes()
        .filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0);
      const partMap = new Map(asset.parts.parts.map((part) => [part.partId, part]));
      const seenParts = new Set<string>();
      const groups = new Map<string, Group>();
      const minimum = new Vector3(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
      const maximum = minimum.negate();
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
        // freezeWorldMatrix computes the final transform and bounding box itself.
        mesh.freezeWorldMatrix();
        const bounds = mesh.getBoundingInfo().boundingBox;
        Vector3.CheckExtends(bounds.minimumWorld, minimum, maximum);
        Vector3.CheckExtends(bounds.maximumWorld, minimum, maximum);
        this.shadow.addShadowCaster(mesh);
        if (part.occlusionGroup !== null) {
          let group = groups.get(part.occlusionGroup);
          if (!group) {
            group = {
              id: part.occlusionGroup,
              meshes: [],
              shared: [],
              materials: [],
              fade: new OcclusionFade(),
              castsShadow: true,
            };
            groups.set(group.id, group);
          }
          group.meshes.push(mesh);
          group.shared.push(mesh.material);
        }
      }
      if (seenParts.size !== partMap.size)
        throw new Error(`Building model has missing parts: ${definition.assetId}`);
      return {
        definition,
        root,
        entries,
        meshes,
        materials: ownedMaterials,
        groups: [...groups.values()],
        minimum,
        maximum,
        size: Math.max(maximum.x - minimum.x, maximum.y - minimum.y, maximum.z - minimum.z),
      };
    } catch (error) {
      // Capture the appended nodes before any dispose can reorder the scene arrays.
      // This also catches unparented clones when Babylon throws before returning entries.
      const ownedNodes = [
        ...this.scene.meshes.slice(firstMesh),
        ...this.scene.transformNodes.slice(firstTransform),
      ];
      for (const mesh of root.getChildMeshes()) this.shadow.removeShadowCaster(mesh);
      entries?.dispose();
      root.dispose();
      for (const node of ownedNodes) if (!node.isDisposed()) node.dispose();
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
    shadowCenter = ownPosition,
    visibleRadius = Infinity,
    opaque = false,
  ): void {
    const rays: Ray[] = [];
    if (ownPosition && !opaque) {
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
    this.trees.update(rays, shadowCenter, visibleRadius, now, seconds, opaque);
    this.glbs.update(shadowCenter, visibleRadius);
    const selected = new Set(this.fading);
    for (const ray of rays) {
      const end = ray.origin.add(ray.direction.scale(ray.length));
      for (const id of this.index.query({
        min: Vector3.Minimize(ray.origin, end),
        max: Vector3.Maximize(ray.origin, end),
      }))
        selected.add(id);
    }
    const shadowCandidates =
      shadowCenter && visibleRadius > 0
        ? this.index.query({
            min: shadowCenter.subtract(
              new Vector3(Math.min(80, visibleRadius), 0, Math.min(80, visibleRadius)),
            ),
            max: shadowCenter.add(
              new Vector3(Math.min(80, visibleRadius), 0, Math.min(80, visibleRadius)),
            ),
          })
        : visibleRadius > 0
          ? new Set(this.references.keys())
          : new Set<string>();
    // Обычно множества совпадают: обходим только расхождения, без временных копий.
    for (const id of this.shadowed)
      if (!shadowCandidates.has(id) && this.references.has(id)) this.setShadowed(id, false);
    for (const id of shadowCandidates)
      if (!this.shadowed.has(id) && this.references.has(id)) this.setShadowed(id, true);
    const test =
      opaque !== this.opaque || now - this.lastOcclusionTest >= OCCLUSION_TEST_INTERVAL_MS;
    this.opaque = opaque;
    if (test) this.lastOcclusionTest = now;
    for (const id of selected) {
      const instance = this.references.get(id)?.view;
      if (!instance) continue;
      const candidates = test
        ? rays.filter(
            (ray) => ray.length > 0 && ray.intersectsBoxMinMax(instance.minimum, instance.maximum),
          )
        : rays;
      for (const group of instance.groups) {
        // Each group and each building is tested: the nearest hit must not hide a second blocker.
        // Между геометрическими проверками действует прежний результат; затухание идёт каждый кадр.
        const blocked = opaque
          ? false
          : test
            ? candidates.some((ray) =>
                group.meshes.some((mesh) => {
                  const hit = ray.intersectsMesh(mesh, true);
                  return hit.hit && hit.distance < ray.length;
                }),
              )
            : group.fade.blocked;
        if (opaque) group.fade.clear();
        const opacity = group.fade.update(blocked, now, seconds);
        if (opacity < 1) {
          this.ownMaterials(instance, group);
          this.useMaterials(group, true);
        } else if (group.owned) this.useMaterials(group, false);
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

  private setShadowed(id: string, enabled: boolean): void {
    const view = this.references.get(id)!.view;
    if (enabled) this.shadowed.add(id);
    else this.shadowed.delete(id);
    for (const mesh of view.meshes) this.shadow.removeShadowCaster(mesh);
    if (enabled) {
      for (const mesh of view.meshes) this.shadow.addShadowCaster(mesh);
      for (const group of view.groups)
        if (!group.castsShadow)
          for (const mesh of group.meshes) this.shadow.removeShadowCaster(mesh);
    }
  }

  aggregateDiagnostics() {
    const trees = this.trees.aggregateDiagnostics();
    const glbs = this.glbs.aggregateDiagnostics();
    return {
      instances: this.instances.length + trees.treeInstances + glbs.glbInstances,
      assets: this.assets.size,
      modelLoads: [...this.assets.values()].filter((asset) => asset.container).length,
      fadedBuildings:
        this.instances.filter((instance) =>
          instance.groups.some((group) => group.fade.opacity < 0.99),
        ).length + trees.fadedTrees,
      ...trees,
      ...glbs,
    };
  }
  diagnostics() {
    const trees = [...this.trees.diagnostics(), ...this.glbs.diagnostics()];
    const counts = new Map<string, number>();
    for (const definition of [...this.instances.map((view) => view.definition), ...trees])
      counts.set(definition.assetId, (counts.get(definition.assetId) ?? 0) + 1);
    return {
      lifecycle: { ...this.lifecycle },
      assets: [...this.assets.values()].map(({ descriptor, container }) => ({
        assetId: descriptor.assetId,
        version: descriptor.version,
        loads: container ? 1 : 0,
        instances: counts.get(descriptor.assetId) ?? 0,
      })),
      buildings: [
        ...this.instances.map((instance) => ({
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
        ...trees,
      ],
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.lit.keys()) this.nightLights?.removeSources(id);
    this.lit.clear();
    this.lifecycle.instancesRemoved +=
      this.trees.aggregateDiagnostics().treeInstances +
      this.glbs.aggregateDiagnostics().glbInstances;
    this.trees.dispose();
    this.glbs.dispose();
    for (const [id, entry] of this.references) {
      entry.count = 1;
      this.remove(id);
    }
    for (const entry of this.cache.values()) entry.controller.abort();
    for (const { container } of this.assets.values()) container?.dispose();
    this.assets.clear();
    this.cache.clear();
  }
}
