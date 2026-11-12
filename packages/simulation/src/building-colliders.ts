import { Scene } from '@babylonjs/core/scene.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody.js';
import { PhysicsMotionType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js';
import {
  PhysicsShapeBox,
  PhysicsShapeContainer,
  PhysicsShapeMesh,
  type PhysicsShape,
} from '@babylonjs/core/Physics/v2/physicsShape.js';
import {
  canonicalJson,
  pointInsideClosedMesh,
  type Bounds,
  type BuildingInstance,
  type BuildingPhysicsAsset,
  type StaticCollider,
  type Vec3,
} from '@su/contracts';

type MeshVolume = {
  collider: Extract<StaticCollider, { kind: 'mesh' }>;
  bounds: Bounds;
  inverse: Matrix;
};
type AssetShapes = {
  definition: BuildingPhysicsAsset;
  users: number;
  container: PhysicsShapeContainer;
  children: PhysicsShape[];
  volumes: MeshVolume[];
};
type BuildingBody = {
  node: TransformNode;
  body: PhysicsBody;
  asset: AssetShapes;
  inverse: Matrix;
  signature: string;
  references: number;
};

/** Static physics resources belong to one world; instances share their asset's native shape. */
export class BuildingColliders {
  private readonly assets = new Map<string, AssetShapes>();
  private readonly bodies = new Map<string, BuildingBody>();
  private readonly worldPoint = Vector3.Zero();
  private readonly bodyPoint = Vector3.Zero();
  private readonly shapePoint = Vector3.Zero();
  constructor(private readonly scene: Scene) {}

  add(instance: BuildingInstance, asset: BuildingPhysicsAsset): void {
    if (instance.assetId !== asset.assetId) throw new Error('Building asset ID mismatch');
    let shapes = this.assets.get(asset.assetId);
    if (
      shapes &&
      shapes.definition !== asset &&
      canonicalJson(shapes.definition) !== canonicalJson(asset)
    )
      throw new Error(`Conflicting building asset: ${asset.assetId}`);
    const signature = canonicalJson(instance);
    const existing = this.bodies.get(instance.entityId);
    if (existing) {
      if (existing.signature !== signature)
        throw new Error(`Conflicting building ID: ${instance.entityId}`);
      existing.references++;
      return;
    }
    if (!shapes) {
      shapes = this.createAsset(asset);
      this.assets.set(asset.assetId, shapes);
    }
    const node = new TransformNode(instance.entityId, this.scene);
    node.position.set(instance.position.x, instance.position.y, instance.position.z);
    const { x, y, z, w } = instance.rotation;
    node.rotationQuaternion = new Quaternion(x, y, z, w).normalize();
    node.computeWorldMatrix(true);
    let body: PhysicsBody | undefined;
    try {
      body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, this.scene);
      body.shape = shapes.container;
      this.bodies.set(instance.entityId, {
        node,
        body,
        asset: shapes,
        inverse: node.getWorldMatrix().clone().invert(),
        signature,
        references: 1,
      });
      shapes.users++;
    } catch (error) {
      body?.dispose();
      node.dispose();
      if (shapes.users === 0) this.releaseAsset(asset.assetId, shapes);
      throw error;
    }
  }

  private createAsset(asset: BuildingPhysicsAsset): AssetShapes {
    const container = new PhysicsShapeContainer(this.scene);
    const children: PhysicsShape[] = [];
    const volumes: MeshVolume[] = [];
    try {
      for (const collider of asset.colliders) {
        const child = this.createShape(asset.assetId, collider);
        children.push(child);
        child.material = { friction: collider.friction, restitution: collider.restitution };
        const { position, rotation } = collider;
        container.addChild(
          child,
          new Vector3(position.x, position.y, position.z),
          new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w).normalize(),
        );
        if (collider.kind === 'mesh') {
          const bounds: Bounds = {
            min: { x: Infinity, y: Infinity, z: Infinity },
            max: { x: -Infinity, y: -Infinity, z: -Infinity },
          };
          for (let i = 0; i < collider.vertices.length; i += 3)
            for (const [offset, axis] of ['x', 'y', 'z'].entries()) {
              const key = axis as keyof Vec3;
              bounds.min[key] = Math.min(bounds.min[key], collider.vertices[i + offset]);
              bounds.max[key] = Math.max(bounds.max[key], collider.vertices[i + offset]);
            }
          volumes.push({
            collider,
            bounds,
            inverse: Matrix.Compose(
              Vector3.One(),
              new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w).normalize(),
              new Vector3(position.x, position.y, position.z),
            ).invert(),
          });
        }
      }
      return { container, children, volumes, definition: asset, users: 0 };
    } catch (error) {
      container.dispose();
      for (const child of children) child.dispose();
      throw error;
    }
  }

  /** Havok mesh queries test triangle surfaces; reject a placement fully inside a solid too. */
  contains(point: Vec3): boolean {
    this.worldPoint.set(point.x, point.y, point.z);
    for (const { asset, inverse } of this.bodies.values()) {
      if (asset.volumes.length === 0) continue;
      Vector3.TransformCoordinatesToRef(this.worldPoint, inverse, this.bodyPoint);
      for (const { collider, bounds, inverse: shapeInverse } of asset.volumes) {
        Vector3.TransformCoordinatesToRef(this.bodyPoint, shapeInverse, this.shapePoint);
        const p = this.shapePoint;
        if (
          p.x < bounds.min.x ||
          p.x > bounds.max.x ||
          p.y < bounds.min.y ||
          p.y > bounds.max.y ||
          p.z < bounds.min.z ||
          p.z > bounds.max.z
        )
          continue;
        if (pointInsideClosedMesh(p, collider.vertices, collider.indices)) return true;
      }
    }
    return false;
  }

  private createShape(assetId: string, collider: StaticCollider): PhysicsShape {
    if (collider.kind === 'box') {
      const { x, y, z } = collider.size;
      return new PhysicsShapeBox(
        Vector3.Zero(),
        Quaternion.Identity(),
        new Vector3(x, y, z),
        this.scene,
      );
    }
    // Havok copies the vertices and indices during construction. This temporary mesh
    // carries topology only; it has no material and is never rendered or retained.
    const topology = new Mesh(`${assetId}:${collider.id}:collision-topology`, this.scene);
    try {
      const data = new VertexData();
      data.positions = collider.vertices;
      data.indices = collider.indices;
      data.applyToMesh(topology);
      return new PhysicsShapeMesh(topology, this.scene);
    } finally {
      topology.dispose();
    }
  }

  /** A cell and prediction history may independently retain the same physical instance. */
  remove(entityId: string): void {
    const item = this.bodies.get(entityId);
    if (!item || --item.references > 0) return;
    item.body.dispose();
    item.node.dispose();
    this.bodies.delete(entityId);
    if (--item.asset.users === 0) this.releaseAsset(item.asset.definition.assetId, item.asset);
  }

  private releaseAsset(assetId: string, asset: AssetShapes): void {
    asset.container.dispose();
    for (const child of asset.children) child.dispose();
    this.assets.delete(assetId);
  }

  diagnostics() {
    return {
      instances: this.bodies.size,
      assets: this.assets.size,
      shapes: [...this.assets.values()].reduce((sum, asset) => sum + 1 + asset.children.length, 0),
      references: [...this.bodies.values()].reduce((sum, item) => sum + item.references, 0),
    };
  }

  dispose(): void {
    for (const [id, item] of this.bodies) {
      item.references = 1;
      this.remove(id);
    }
  }
}
