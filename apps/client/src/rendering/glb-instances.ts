import { Mesh } from '@babylonjs/core/Meshes/mesh';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import { Ray } from '@babylonjs/core/Culling/ray';
import { Material } from '@babylonjs/core/Materials/material';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { ShadowDepthWrapper } from '@babylonjs/core/Materials/shadowDepthWrapper';
import type { Scene } from '@babylonjs/core/scene';
import type { Node } from '@babylonjs/core/node';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type {
  BuildingAssetManifest,
  BuildingInstance,
  BuildingPart,
  BuildingParts,
} from '@su/contracts';
import { SpatialIndex } from './spatial-index';
import { applyRadialFog, type RadialState } from './radial-fog';
import { INSTANCE_STATE_ATTRIBUTE, InstanceStateMaterial } from './instance-state';
import {
  staticHitVisible,
  staticObjectSelection,
  staticRayBounds,
  type StaticObjectHit,
} from './static-selection';

type Template = { mesh: Mesh; local: Matrix; part: BuildingPart; key: string };
type Prepared = {
  descriptor: BuildingAssetManifest;
  templates: Template[];
  materials: Set<Material>;
  /** A modular fence keeps its silhouette when individual sections fall below five pixels. */
  continuous: boolean;
};
type Instance = {
  definition: BuildingInstance;
  signature: string;
  asset: Prepared;
  references: number;
  matrix: Matrix;
  born: number;
  minimum: Vector3;
  maximum: Vector3;
  size: number;
  batches: Batch[];
  shadow: boolean;
  visible: boolean;
};
type Batch = {
  key: string;
  variant: string;
  mesh: Mesh;
  template: Template;
  instances: Set<Instance>;
  capacity: number;
  matrices: Float32Array;
  states: Float32Array;
  geometryBytes: number;
};
const vector = (v: { x: number; y: number; z: number }) => new Vector3(v.x, v.y, v.z);
const plain = ({ x, y, z }: Vector3) => ({ x, y, z });
const MAX_IDLE_PER_VARIANT = 24;
const MAX_IDLE_BATCHES = 96;
const MAX_IDLE_BYTES = 8 * 1024 * 1024;
const bufferBytes = (batch: Batch) => batch.capacity * 20 * 4;
// Conservative CPU + GPU estimate, including geometry made unique for each batch.
const retainedBytes = (batch: Batch) => 2 * (batch.geometryBytes + bufferBytes(batch));

function semanticPart(node: Node): BuildingPart | undefined {
  for (let current: Node | null = node; current; current = current.parent) {
    const part = current.metadata?.gltf?.extras?.su;
    if (part && typeof part.partId === 'string') return part;
  }
}

/** Static GLBs share templates and materials; only chunk buffers grow with placements. */
export class GlbInstances {
  private readonly assets = new Map<string, Prepared>();
  private readonly instances = new Map<string, Instance>();
  private readonly batches = new Map<string, Batch>();
  private readonly idle = new Set<Batch>();
  private readonly dirty = new Set<Batch>();
  private readonly index = new SpatialIndex();
  private readonly shadowed = new Set<string>();
  private minimumVisibleSize = 0;

  constructor(
    private readonly scene: Scene,
    private readonly shadows: ShadowGenerator,
    private readonly radial?: RadialState,
  ) {}

  prepare(descriptor: BuildingAssetManifest, parts: BuildingParts, container: AssetContainer) {
    const fail = (reason: string): never => {
      throw new Error(`Invalid thin-instance GLB ${descriptor.assetId}: ${reason}`);
    };
    if (!this.scene.getEngine().getCaps().instancedArrays) fail('GPU instancing is required');
    if (container.animationGroups.length || container.skeletons.length) fail('animated geometry');
    const partMap = new Map(parts.parts.map((part) => [part.partId, part]));
    if (parts.parts.some((part) => part.occlusionGroup !== null)) fail('individual occlusion fade');
    const seen = new Set<string>();
    const materials = new Set<Material>();
    const templates: Template[] = [];
    const inspectMaterial = (material: Material | null) => {
      if (!material) fail('missing material');
      if (materials.has(material!)) return;
      if (material instanceof MultiMaterial) {
        for (const child of material.subMaterials) inspectMaterial(child);
        return;
      }
      if (!(material instanceof PBRMaterial) && !(material instanceof StandardMaterial))
        fail('unsupported material');
      if (material!.alpha !== 1 || material!.needAlphaBlending()) fail('alpha-blended material');
      materials.add(material!);
    };
    for (const source of container.meshes) {
      if (!(source instanceof Mesh) || !source.getTotalVertices()) continue;
      if (source.skeleton || source.morphTargetManager || source.animations.length)
        fail('animated mesh');
      const semantic = semanticPart(source),
        part = semantic && partMap.get(semantic.partId);
      if (!part || part.role !== semantic!.role || part.occlusionGroup !== semantic!.occlusionGroup)
        fail('semantic part mismatch');
      // Four world columns and one state attribute accompany the GLB's existing attributes.
      if (
        source.getVerticesDataKinds().length + 5 >
        this.scene.getEngine().getCaps().maxVertexAttribs
      )
        fail('not enough vertex attributes for instancing');
      const local = source.computeWorldMatrix(true).clone();
      if (
        !Array.from(local.m).every(Number.isFinite) ||
        local.determinant() <= 1e-12 ||
        Math.abs(local.m[3]) + Math.abs(local.m[7]) + Math.abs(local.m[11]) > 1e-8 ||
        Math.abs(local.m[15] - 1) > 1e-8
      )
        fail('invalid node transform');
      // Babylon's thin-instance normal path supports rotated nonuniform scale,
      // but not a sheared basis (including shear inherited through a hierarchy).
      const basis = [0, 4, 8].map((offset) => Vector3.FromArray(local.m, offset));
      for (const [a, b] of [
        [0, 1],
        [0, 2],
        [1, 2],
      ])
        if (
          Math.abs(Vector3.Dot(basis[a], basis[b])) >
          1e-6 * Math.sqrt(basis[a].lengthSquared() * basis[b].lengthSquared())
        )
          fail('sheared node transforms are unsupported');
      inspectMaterial(source.material);
      seen.add(part!.partId);
      templates.push({
        mesh: source,
        local,
        part: part!,
        key: `${templates.length}:${source.material!.uniqueId}`,
      });
    }
    if (!templates.length || seen.size !== partMap.size) fail('missing geometry');
    // Mutate materials only after the entire model passes validation.
    for (const material of materials) {
      new InstanceStateMaterial(material, this.radial);
      material.shadowDepthWrapper = new ShadowDepthWrapper(material, this.scene, {
        standalone: true,
      });
    }
    this.assets.set(descriptor.version, {
      descriptor,
      templates,
      materials,
      continuous: parts.parts.some((part) => part.partId === 'fence'),
    });
  }

  release(version: string) {
    const asset = this.assets.get(version);
    if (!asset) return;
    this.flush();
    if ([...this.instances.values()].some((instance) => instance.asset === asset))
      throw new Error(
        `Releasing an instanced GLB still owned by placements: ${asset.descriptor.assetId}`,
      );
    for (const batch of this.idle)
      if (asset.templates.includes(batch.template)) this.disposeBatch(batch);
    for (const material of asset.materials) material.shadowDepthWrapper?.dispose();
    this.assets.delete(version);
  }
  has(id: string) {
    return this.instances.has(id);
  }

  selection(id: string) {
    const instance = this.instances.get(id);
    if (!instance?.visible) return;
    return staticObjectSelection(instance.definition, instance.minimum, instance.maximum);
  }

  pick(ray: Ray, protectedIds: ReadonlySet<string>): StaticObjectHit | undefined {
    let nearest: StaticObjectHit | undefined;
    for (const id of this.index.query(staticRayBounds(ray))) {
      const instance = this.instances.get(id)!;
      if (
        protectedIds.has(id) ||
        !instance.visible ||
        !ray.intersectsBoxMinMax(instance.minimum, instance.maximum)
      )
        continue;
      for (const template of instance.asset.templates) {
        const world = template.local.multiply(instance.matrix);
        // A batch mesh has many placements. Test the shared source geometry in this
        // placement's local space so holes and individual instance IDs remain exact.
        const local = Ray.Transform(ray, Matrix.Invert(world));
        const hit = template.mesh.intersects(local, false, undefined, false, world);
        if (
          hit.hit &&
          hit.distance <= ray.length &&
          (!nearest || hit.distance < nearest.distance) &&
          staticHitVisible(this.radial, ray, hit.distance, instance.born)
        )
          nearest = {
            ...staticObjectSelection(instance.definition, instance.minimum, instance.maximum),
            distance: hit.distance,
          };
      }
    }
    return nearest;
  }

  add(definition: BuildingInstance, version: string, signature: string) {
    const previous = this.instances.get(definition.entityId);
    if (previous) {
      if (previous.signature !== signature)
        throw new Error(`Conflicting building/version: ${definition.entityId}`);
      previous.references++;
      return;
    }
    const asset = this.assets.get(version);
    if (!asset || asset.descriptor.assetId !== definition.assetId)
      throw new Error('Instanced model is not prepared');
    const matrix = Matrix.Compose(
      Vector3.One(),
      new Quaternion(
        definition.rotation.x,
        definition.rotation.y,
        definition.rotation.z,
        definition.rotation.w,
      ),
      vector(definition.position),
    );
    const minimum = new Vector3(Infinity, Infinity, Infinity),
      maximum = minimum.negate();
    for (const template of asset.templates) {
      const transform = template.local.multiply(matrix);
      for (const corner of template.mesh.getBoundingInfo().boundingBox.vectors)
        Vector3.CheckExtends(Vector3.TransformCoordinates(corner, transform), minimum, maximum);
    }
    const size = Math.max(maximum.x - minimum.x, maximum.y - minimum.y, maximum.z - minimum.z);
    const instance: Instance = {
      definition,
      signature,
      asset,
      matrix,
      born: this.radial ? performance.now() : 0,
      references: 1,
      minimum,
      maximum,
      size,
      batches: [],
      shadow: false,
      visible: asset.continuous || size >= this.minimumVisibleSize,
    };
    this.instances.set(definition.entityId, instance);
    this.index.add(definition.entityId, { min: plain(minimum), max: plain(maximum) });
    try {
      this.assign(instance);
    } catch (error) {
      this.remove(definition.entityId, true);
      this.flush();
      throw error;
    }
  }
  remove(id: string, force = false) {
    const instance = this.instances.get(id);
    if (!instance || (!force && --instance.references > 0)) return;
    for (const batch of instance.batches) {
      batch.instances.delete(instance);
      this.dirty.add(batch);
    }
    this.instances.delete(id);
    this.index.remove(id);
    this.shadowed.delete(id);
  }

  private assign(instance: Instance) {
    for (const batch of instance.batches) {
      batch.instances.delete(instance);
      this.dirty.add(batch);
    }
    instance.batches = [];
    if (!instance.visible) return;
    const { definition, asset } = instance;
    const chunk = `${Math.floor(definition.position.x / 125)},${Math.floor(definition.position.z / 125)}`;
    for (const template of asset.templates) {
      const variant = `${asset.descriptor.version}:${template.part.partId}:${template.key}:${instance.shadow}`;
      const key = `${chunk}:${variant}`;
      let batch = this.batches.get(key);
      if (!batch) {
        batch = [...this.idle].find((candidate) => candidate.variant === variant);
        if (batch) {
          this.idle.delete(batch);
          batch.key = key;
          batch.mesh.name = `glb-batch:${key}`;
          this.batches.set(key, batch);
        }
      }
      if (!batch) {
        const mesh = template.mesh.clone(`glb-batch:${key}`, null, true)!;
        try {
          mesh.parent = null;
          mesh.position.setAll(0);
          mesh.scaling.setAll(1);
          mesh.rotationQuaternion = Quaternion.Identity();
          mesh.rotation.setAll(0);
          mesh.setPivotMatrix(Matrix.Identity());
          // Babylon stores thin-instance buffers on Geometry, not Mesh.
          mesh.makeGeometryUnique();
          mesh.doNotSyncBoundingInfo = true;
          mesh.isPickable = false;
          mesh.receiveShadows = true;
          mesh.freezeWorldMatrix(Matrix.Identity());
          if (this.radial) applyRadialFog(mesh, this.radial, 0);
          if (instance.shadow) this.shadows.addShadowCaster(mesh);
          batch = {
            key,
            variant,
            mesh,
            template,
            instances: new Set(),
            capacity: 0,
            matrices: new Float32Array(0),
            states: new Float32Array(0),
            geometryBytes:
              template.mesh
                .getVerticesDataKinds()
                .reduce(
                  (bytes, kind) =>
                    bytes +
                    template.mesh.getTotalVertices() *
                      template.mesh.getVertexBuffer(kind)!.getSize() *
                      4,
                  0,
                ) +
              template.mesh.getTotalIndices() * 4,
          };
          this.batches.set(key, batch);
        } catch (error) {
          this.shadows.removeShadowCaster(mesh);
          mesh.dispose(false, false);
          throw error;
        }
      }
      batch.instances.add(instance);
      instance.batches.push(batch);
      this.dirty.add(batch);
    }
  }

  setDetailScale(minimumVisibleSize: number) {
    if (minimumVisibleSize === this.minimumVisibleSize) return;
    this.minimumVisibleSize = minimumVisibleSize;
    for (const instance of this.instances.values()) {
      const visible = instance.asset.continuous || instance.size >= minimumVisibleSize;
      if (visible === instance.visible) continue;
      instance.visible = visible;
      this.assign(instance);
    }
  }
  update(center: Vector3 | undefined, visibleRadius: number) {
    const radius = Math.min(80, visibleRadius);
    const candidates =
      visibleRadius <= 0
        ? new Set<string>()
        : center
          ? this.index.query({
              min: center.subtract(new Vector3(radius, 0, radius)),
              max: center.add(new Vector3(radius, 0, radius)),
            })
          : new Set(this.instances.keys());
    for (const id of new Set([...this.shadowed, ...candidates])) {
      const shadow = candidates.has(id);
      if (shadow === this.shadowed.has(id)) continue;
      const instance = this.instances.get(id);
      if (!instance) continue;
      if (shadow) this.shadowed.add(id);
      else this.shadowed.delete(id);
      instance.shadow = shadow;
      this.assign(instance);
    }
    this.flush();
  }
  private disposeBatch(batch: Batch): void {
    this.shadows.removeShadowCaster(batch.mesh);
    batch.mesh.dispose(false, false);
    this.idle.delete(batch);
  }
  private retire(batch: Batch): void {
    this.batches.delete(batch.key);
    batch.mesh.setEnabled(false);
    batch.mesh.thinInstanceCount = 0;
    if (!batch.capacity || retainedBytes(batch) > MAX_IDLE_BYTES) {
      this.disposeBatch(batch);
      return;
    }
    // Leave disabled shadow casters registered so their compiled depth effects survive reuse.
    this.idle.add(batch);
    let bytes = [...this.idle].reduce((sum, candidate) => sum + retainedBytes(candidate), 0);
    for (const candidate of this.idle) {
      const sameVariant = [...this.idle].filter((idle) => idle.variant === batch.variant).length;
      if (
        this.idle.size <= MAX_IDLE_BATCHES &&
        bytes <= MAX_IDLE_BYTES &&
        sameVariant <= MAX_IDLE_PER_VARIANT
      )
        break;
      if (
        this.idle.size <= MAX_IDLE_BATCHES &&
        bytes <= MAX_IDLE_BYTES &&
        candidate.variant !== batch.variant
      )
        continue;
      bytes -= retainedBytes(candidate);
      this.disposeBatch(candidate);
    }
  }
  flush() {
    for (const batch of this.dirty) {
      if (!batch.instances.size) {
        this.retire(batch);
        continue;
      }
      const grew = batch.instances.size > batch.capacity;
      if (grew) {
        batch.capacity = Math.max(8, 2 ** Math.ceil(Math.log2(batch.instances.size)));
        batch.matrices = new Float32Array(batch.capacity * 16);
        batch.states = new Float32Array(batch.capacity * 4);
      }
      const { matrices, states } = batch;
      const minimum = new Vector3(Infinity, Infinity, Infinity),
        maximum = minimum.negate();
      let slot = 0;
      for (const instance of batch.instances) {
        batch.template.local.multiply(instance.matrix).copyToArray(matrices, slot * 16);
        states.set([instance.born, 1, 0, 0], slot * 4);
        Vector3.CheckExtends(instance.minimum, minimum, maximum);
        Vector3.CheckExtends(instance.maximum, minimum, maximum);
        slot++;
      }
      if (grew) {
        batch.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
        batch.mesh.thinInstanceSetBuffer(INSTANCE_STATE_ATTRIBUTE, states, 4, false);
      }
      // The matrix uploader reads thinInstanceCount; publishing it afterwards misses added slots.
      batch.mesh.thinInstanceCount = batch.instances.size;
      if (!grew) {
        batch.mesh.thinInstanceBufferUpdated('matrix');
        batch.mesh.thinInstanceBufferUpdated(INSTANCE_STATE_ATTRIBUTE);
        batch.mesh._thinInstanceDataStorage.worldMatrices = null;
      }
      batch.mesh.setBoundingInfo(new BoundingInfo(minimum, maximum));
      batch.mesh.setEnabled(true);
    }
    if (this.dirty.size) this.shadows.getShadowMap()?.resetRefreshCounter();
    this.dirty.clear();
  }
  aggregateDiagnostics() {
    return {
      glbInstances: this.instances.size,
      glbBatches: this.batches.size,
      glbPooledBatches: this.idle.size,
      glbTemplates: [...this.assets.values()].reduce(
        (count, asset) => count + asset.templates.length,
        0,
      ),
      glbInstanceBufferBytes: [...this.batches.values(), ...this.idle].reduce(
        (bytes, batch) => bytes + bufferBytes(batch),
        0,
      ),
      glbPoolBytes: [...this.idle].reduce((bytes, batch) => bytes + retainedBytes(batch), 0),
    };
  }
  diagnostics() {
    return [...this.instances.values()].map((instance) => ({
      entityId: instance.definition.entityId,
      assetId: instance.definition.assetId,
      position: { ...instance.definition.position },
      rotation: { ...instance.definition.rotation },
      bounds: { min: plain(instance.minimum), max: plain(instance.maximum) },
      opacity: 1,
      occluded: false,
      groups: instance.asset.templates.map((template) => ({
        id: template.part.partId,
        opacity: 1,
        occluded: false,
      })),
    }));
  }
  dispose() {
    for (const id of this.instances.keys()) this.remove(id, true);
    this.flush();
    for (const version of this.assets.keys()) this.release(version);
  }
}
