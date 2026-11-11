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
  container: PhysicsShapeContainer;
  children: PhysicsShape[];
  volumes: MeshVolume[];
};
type BuildingBody = { node: TransformNode; body: PhysicsBody; asset: AssetShapes; inverse: Matrix };

/** Static physics resources belong to one world; instances share their asset's native shape. */
export class BuildingColliders {
  private readonly assets = new Map<string, AssetShapes>();
  private readonly bodies: BuildingBody[] = [];
  private readonly worldPoint = Vector3.Zero();
  private readonly bodyPoint = Vector3.Zero();
  private readonly shapePoint = Vector3.Zero();
  constructor(private readonly scene: Scene) {}

  add(instance: BuildingInstance, asset: BuildingPhysicsAsset): void {
    let shapes = this.assets.get(asset.assetId);
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
      this.bodies.push({
        node,
        body,
        asset: shapes,
        inverse: node.getWorldMatrix().clone().invert(),
      });
    } catch (error) {
      body?.dispose();
      node.dispose();
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
      return { container, children, volumes };
    } catch (error) {
      container.dispose();
      for (const child of children) child.dispose();
      throw error;
    }
  }

  /** Havok mesh queries test triangle surfaces; reject a placement fully inside a solid too. */
  contains(point: Vec3): boolean {
    this.worldPoint.set(point.x, point.y, point.z);
    for (const { asset, inverse } of this.bodies) {
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

  dispose(): void {
    // Bodies must release their references before the shared containers and children.
    for (const { body, node } of this.bodies) {
      body.dispose();
      node.dispose();
    }
    this.bodies.length = 0;
    for (const { container, children } of this.assets.values()) {
      container.dispose();
      for (const child of children) child.dispose();
    }
    this.assets.clear();
  }
}
