import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import { Ray } from '@babylonjs/core/Culling/ray';
import { Material } from '@babylonjs/core/Materials/material';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShadowDepthWrapper } from '@babylonjs/core/Materials/shadowDepthWrapper';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import {
  buildingBounds,
  type BuildingInstance,
  type BuildingAssetManifest,
  type TreeRenderRecipe,
} from '@su/contracts';
import { applyRadialFog, type RadialState } from './radial-fog';
import { OcclusionFade } from './occlusion';
import { SpatialIndex } from './spatial-index';
import { treeIntersectsRay, treeRayDistance, treeTemplate } from './tree-geometry';
import { TreeMaterial, TREE_ATTRIBUTES } from './tree-material';
import {
  staticHitVisible,
  staticObjectSelection,
  staticRayBounds,
  type StaticObjectHit,
} from './static-selection';

type Tree = {
  definition: BuildingInstance;
  recipe: TreeRenderRecipe;
  signature: string;
  references: number;
  matrix: Matrix;
  inverse: Matrix;
  minimum: Vector3;
  maximum: Vector3;
  born: number;
  fade: OcclusionFade;
  batch: Batch;
};
type Batch = {
  key: string;
  mesh: Mesh;
  trees: Set<Tree>;
};
const vector = (v: { x: number; y: number; z: number }) => new Vector3(v.x, v.y, v.z);

/** Dense GPU batches by 125 m chunk, palette and render pass; no per-tree Babylon nodes. */
export class TreeViews {
  readonly supported: boolean;
  private readonly trees = new Map<string, Tree>();
  private readonly batches = new Map<string, Batch>();
  private readonly templates = new Map<string, Mesh>();
  private readonly materials = new Map<string, PBRMaterial>();
  private readonly dirty = new Set<Batch>();
  private readonly fading = new Set<string>();
  private readonly shadowed = new Set<string>();
  private readonly index = new SpatialIndex();

  constructor(
    private readonly scene: Scene,
    private readonly shadows: ShadowGenerator,
    private readonly radial?: RadialState,
  ) {
    const caps = scene.getEngine().getCaps();
    // Position/normal/color/part, four matrix columns and four recipe/state attributes.
    this.supported = !!caps.instancedArrays && caps.maxVertexAttribs >= 12;
  }
  has(id: string) {
    return this.trees.has(id);
  }
  selection(id: string) {
    const tree = this.trees.get(id);
    if (!tree) return;
    return staticObjectSelection(tree.definition, tree.minimum, tree.maximum);
  }
  pick(ray: Ray, protectedIds: ReadonlySet<string>): StaticObjectHit | undefined {
    let nearest: StaticObjectHit | undefined;
    for (const id of this.index.query(staticRayBounds(ray))) {
      const tree = this.trees.get(id)!;
      if (protectedIds.has(id) || !ray.intersectsBoxMinMax(tree.minimum, tree.maximum)) continue;
      const distance = treeRayDistance(tree.recipe, Ray.Transform(ray, tree.inverse));
      if (
        distance !== undefined &&
        (!nearest || distance < nearest.distance) &&
        staticHitVisible(this.radial, ray, distance, tree.born)
      )
        nearest = {
          ...staticObjectSelection(tree.definition, tree.minimum, tree.maximum),
          distance,
        };
    }
    return nearest;
  }
  add(
    definition: BuildingInstance,
    descriptor: BuildingAssetManifest,
    recipe: TreeRenderRecipe,
    signature: string,
  ) {
    const previous = this.trees.get(definition.entityId);
    if (previous) {
      if (previous.signature !== signature)
        throw new Error(`Conflicting building/version: ${definition.entityId}`);
      previous.references++;
      return;
    }
    const bounds = buildingBounds(definition, descriptor.bounds);
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
    const tree: Tree = {
      definition,
      recipe,
      signature,
      references: 1,
      matrix,
      inverse: Matrix.Invert(matrix),
      minimum: vector(bounds.min),
      maximum: vector(bounds.max),
      born: this.radial ? performance.now() : 0,
      fade: new OcclusionFade(),
      batch: this.batch(definition, recipe, false, false),
    };
    tree.batch.trees.add(tree);
    this.dirty.add(tree.batch);
    this.trees.set(definition.entityId, tree);
    this.index.add(definition.entityId, bounds);
  }
  remove(id: string, force = false) {
    const tree = this.trees.get(id);
    if (!tree || (!force && --tree.references > 0)) return;
    this.trees.delete(id);
    this.index.remove(id);
    this.fading.delete(id);
    this.shadowed.delete(id);
    tree.batch.trees.delete(tree);
    this.dirty.add(tree.batch);
  }
  private batch(
    definition: BuildingInstance,
    recipe: TreeRenderRecipe,
    shadow: boolean,
    transparent: boolean,
  ): Batch {
    const palette = `${recipe.crownColor}:${recipe.trunkColor}:${recipe.foliage}`;
    // Give the few translucent occluders individual sorting bounds, preserving alpha blending.
    const key = `${Math.floor(definition.position.x / 125)},${Math.floor(definition.position.z / 125)}:${palette}:${shadow}:${transparent ? definition.entityId : ''}`;
    let batch = this.batches.get(key);
    if (batch) return batch;
    let template = this.templates.get(palette);
    if (!template) {
      template = new Mesh(`tree-template:${palette}`, this.scene);
      template.sideOrientation = Material.CounterClockWiseSideOrientation;
      const data = treeTemplate(recipe.crownColor, recipe.trunkColor, recipe.foliage);
      const vertices = new VertexData();
      Object.assign(vertices, {
        positions: data.positions,
        normals: data.normals,
        indices: data.indices,
        colors: data.colors,
      });
      vertices.applyToMesh(template);
      template.setVerticesData('suTreePart', data.parts, false, 1);
      template.setEnabled(false);
      this.templates.set(palette, template);
    }
    const materialKey = `${palette}:${transparent}`;
    let material = this.materials.get(materialKey);
    if (!material) {
      material = new PBRMaterial(`tree-material:${materialKey}`, this.scene);
      material.metallic = 0;
      material.roughness = 0.9;
      material.transparencyMode = transparent
        ? Material.MATERIAL_ALPHABLEND
        : Material.MATERIAL_OPAQUE;
      new TreeMaterial(material, this.radial, recipe.foliage);
      // Standalone: the depth shader must not wait for the batch to be drawn on screen first.
      // A chunk beside the view still casts into it, and may never enter the main pass.
      material.shadowDepthWrapper = new ShadowDepthWrapper(material, this.scene, {
        standalone: true,
      });
      this.materials.set(materialKey, material);
    }
    const mesh = template.clone(`tree-batch:${key}`, null, true)!;
    // Babylon attaches thin-instance buffers to Geometry; chunks must not overwrite each other.
    mesh.makeGeometryUnique();
    mesh.doNotSyncBoundingInfo = true;
    mesh.material = material;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.freezeWorldMatrix();
    if (this.radial) applyRadialFog(mesh, this.radial, 0);
    if (shadow) this.shadows.addShadowCaster(mesh);
    batch = { key, mesh, trees: new Set() };
    this.batches.set(key, batch);
    return batch;
  }
  update(
    rays: Ray[],
    center: Vector3 | undefined,
    visibleRadius: number,
    now: number,
    seconds: number,
    opaque = false,
  ) {
    const selected = new Set(this.fading);
    for (const ray of rays) {
      const end = ray.origin.add(ray.direction.scale(ray.length));
      for (const id of this.index.query({
        min: Vector3.Minimize(ray.origin, end),
        max: Vector3.Maximize(ray.origin, end),
      }))
        selected.add(id);
    }
    const radius = Math.min(80, visibleRadius);
    const candidates =
      visibleRadius <= 0
        ? new Set<string>()
        : center
          ? this.index.query({
              min: center.subtract(new Vector3(radius, 0, radius)),
              max: center.add(new Vector3(radius, 0, radius)),
            })
          : new Set(this.trees.keys());
    for (const id of new Set([...this.shadowed, ...candidates])) {
      if (candidates.has(id) === this.shadowed.has(id)) continue;
      if (candidates.has(id)) this.shadowed.add(id);
      else this.shadowed.delete(id);
      selected.add(id);
    }
    for (const id of selected) {
      const tree = this.trees.get(id);
      if (!tree) continue;
      const blocked = rays.some(
        (ray) =>
          ray.length > 0 &&
          ray.intersectsBoxMinMax(tree.minimum, tree.maximum) &&
          treeIntersectsRay(tree.recipe, Ray.Transform(ray, tree.inverse)),
      );
      const previousOpacity = tree.fade.opacity;
      if (opaque) tree.fade.clear();
      const opacity = tree.fade.update(blocked, now, seconds);
      const shadow = this.shadowed.has(id) && opacity >= 0.98;
      const transparent = opacity < 1;
      const batch = this.batch(tree.definition, tree.recipe, shadow, transparent);
      if (batch !== tree.batch) {
        tree.batch.trees.delete(tree);
        this.dirty.add(tree.batch);
        tree.batch = batch;
        batch.trees.add(tree);
        this.dirty.add(batch);
      } else if (opacity !== previousOpacity) this.dirty.add(batch);
      if (transparent || tree.fade.blocked) this.fading.add(id);
      else this.fading.delete(id);
    }
    this.flush();
  }
  /** Rebuild only changed small chunks, once per frame. Empty chunks release their GPU buffers. */
  flush() {
    for (const batch of this.dirty) {
      const { mesh, trees } = batch;
      if (!trees.size) {
        this.shadows.removeShadowCaster(mesh);
        mesh.dispose(false, false);
        this.batches.delete(batch.key);
        continue;
      }
      const matrices = new Float32Array(trees.size * 16);
      const attributes = TREE_ATTRIBUTES.map(() => new Float32Array(trees.size * 4));
      const minimum = new Vector3(Infinity, Infinity, Infinity),
        maximum = minimum.negate();
      let slot = 0;
      for (const tree of trees) {
        tree.matrix.copyToArray(matrices, slot * 16);
        attributes[0].set(tree.recipe.crowns[0], slot * 4);
        attributes[1].set(tree.recipe.crowns[1], slot * 4);
        attributes[2].set(tree.recipe.trunk, slot * 4);
        attributes[3].set([tree.born, tree.fade.opacity, tree.recipe.trunkBase, 0], slot * 4);
        Vector3.CheckExtends(tree.minimum, minimum, maximum);
        Vector3.CheckExtends(tree.maximum, minimum, maximum);
        slot++;
      }
      mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
      for (let i = 0; i < TREE_ATTRIBUTES.length; i++)
        mesh.thinInstanceSetBuffer(TREE_ATTRIBUTES[i], attributes[i], 4, true);
      // Babylon cannot infer shader-deformed bounds from the unit template.
      mesh.setBoundingInfo(new BoundingInfo(minimum, maximum));
      mesh.setEnabled(true);
    }
    // A batch keeps its place in the caster list while its instances change.
    if (this.dirty.size) this.shadows.getShadowMap()?.resetRefreshCounter();
    this.dirty.clear();
  }
  aggregateDiagnostics() {
    let fadedTrees = 0;
    for (const id of this.fading) if (this.trees.get(id)!.fade.opacity < 0.99) fadedTrees++;
    return {
      treeInstances: this.trees.size,
      treeBatches: this.batches.size,
      treeTemplates: this.templates.size,
      fadedTrees,
    };
  }
  diagnostics() {
    return [...this.trees.values()].map((tree) => ({
      entityId: tree.definition.entityId,
      assetId: tree.definition.assetId,
      position: { ...tree.definition.position },
      rotation: { ...tree.definition.rotation },
      bounds: {
        min: { x: tree.minimum.x, y: tree.minimum.y, z: tree.minimum.z },
        max: { x: tree.maximum.x, y: tree.maximum.y, z: tree.maximum.z },
      },
      opacity: tree.fade.opacity,
      occluded: tree.fade.blocked,
      groups: [{ id: 'shell', opacity: tree.fade.opacity, occluded: tree.fade.blocked }],
    }));
  }
  dispose() {
    for (const id of this.trees.keys()) this.remove(id, true);
    this.flush();
    for (const mesh of this.templates.values()) mesh.dispose(false, false);
    for (const material of this.materials.values()) {
      material.shadowDepthWrapper?.dispose();
      material.dispose(false, false);
    }
    this.templates.clear();
    this.materials.clear();
  }
}
