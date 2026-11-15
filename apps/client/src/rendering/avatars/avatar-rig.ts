import { Color3 } from '@babylonjs/core/Maths/math.color';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { AvatarPose } from './locomotion';
import { splitLimb } from './limb-geometry';

export function paintMesh(mesh: Mesh, color: Color3): Mesh {
  const colors = new Float32Array(mesh.getTotalVertices() * 4);
  for (let offset = 0; offset < colors.length; offset += 4) {
    colors[offset] = color.r;
    colors[offset + 1] = color.g;
    colors[offset + 2] = color.b;
    colors[offset + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  return mesh;
}
export const clothingMesh = (mesh: Mesh, tone = 1) => paintMesh(mesh, new Color3(tone, tone, tone));

/** Shared humanoid joints and visual ownership. Skins supply rest positions and geometry. */
export class AvatarRig {
  readonly facing: TransformNode;
  readonly posture: TransformNode;
  readonly body: TransformNode;
  readonly garment: TransformNode;
  readonly head: TransformNode;
  readonly leftShoulder: TransformNode;
  readonly rightShoulder: TransformNode;
  readonly leftHip: TransformNode;
  readonly rightHip: TransformNode;
  readonly leftElbow: TransformNode;
  readonly rightElbow: TransformNode;
  readonly leftKnee: TransformNode;
  readonly rightKnee: TransformNode;
  readonly leftHand: TransformNode;
  readonly rightHand: TransformNode;
  readonly material: StandardMaterial;
  /** Сидячий скин (коляска): ноги не шагают, тело не подпрыгивает, шагов не слышно. */
  seated = false;
  /** Получает пройденный путь в метрах, например чтобы вращать колёса. */
  onTravel?: (distance: number) => void;
  private readonly meshes: Mesh[] = [];
  private readonly supportVertices = new Map<Mesh, ArrayLike<number>>();
  private readonly limbs: {
    mesh: Mesh;
    parent: TransformNode;
    hinge: TransformNode;
    data: VertexData;
    clothing: number;
  }[] = [];
  private articulated = false;
  private supportY = 0;
  private readonly suitParts: {
    mesh: Mesh;
    neutral: Float32Array;
    colors: Float32Array;
    vertices: number;
  }[] = [];

  constructor(
    root: TransformNode,
    readonly scene: Scene,
    private readonly shadow: ShadowGenerator,
  ) {
    const joint = (name: string, parent: TransformNode) => {
      const node = new TransformNode(`${name}-${root.name}`, scene);
      node.parent = parent;
      return node;
    };
    this.facing = joint('facing', root);
    this.posture = joint('posture', this.facing);
    this.body = joint('pose', this.posture);
    this.garment = joint('garment', this.body);
    this.head = joint('head', this.body);
    this.leftShoulder = joint('leftShoulder', this.body);
    this.rightShoulder = joint('rightShoulder', this.body);
    this.leftHip = joint('leftHip', this.body);
    this.rightHip = joint('rightHip', this.body);
    this.leftElbow = joint('leftElbow', this.leftShoulder);
    this.rightElbow = joint('rightElbow', this.rightShoulder);
    this.leftKnee = joint('leftKnee', this.leftHip);
    this.rightKnee = joint('rightKnee', this.rightHip);
    this.leftHand = joint('leftHand', this.leftElbow);
    this.rightHand = joint('rightHand', this.rightElbow);
    this.material = new StandardMaterial(`avatar-${root.name}`, scene);
    this.material.diffuseColor = Color3.White();
    this.material.specularColor.set(0.16, 0.17, 0.18);
    this.material.specularPower = 72;
  }

  part(name: string, parent: TransformNode, clothing: Mesh[], fixed: Mesh[] = []): void {
    // Clothing occupies the first vertex range; skin and face keep their fixed colors.
    const vertices = clothing.reduce((count, mesh) => count + mesh.getTotalVertices(), 0);
    const pieces = [...clothing, ...fixed];
    const mesh = pieces.length === 1 ? pieces[0] : Mesh.MergeMeshes(pieces, true)!;
    const hinges = new Map([
      [this.leftShoulder, this.leftElbow],
      [this.rightShoulder, this.rightElbow],
      [this.leftHip, this.leftKnee],
      [this.rightHip, this.rightKnee],
    ]);
    const hinge = hinges.get(parent);
    if (hinge) {
      const data = VertexData.ExtractFromMesh(mesh, true, true);
      data.transform(
        Matrix.Compose(
          mesh.scaling,
          mesh.rotationQuaternion ?? Quaternion.FromEulerVector(mesh.rotation),
          mesh.position,
        ),
      );
      this.limbs.push({ mesh, parent, hinge, data, clothing: vertices });
    }
    this.installPart(mesh, name, parent, vertices);
  }

  private installPart(mesh: Mesh, name: string, parent: TransformNode, vertices: number): void {
    mesh.name = `${name}-${this.facing.parent!.name}`;
    mesh.parent = parent;
    mesh.material = this.material;
    if (vertices) {
      const neutral = Float32Array.from(mesh.getVerticesData(VertexBuffer.ColorKind)!);
      const colors = new Float32Array(neutral);
      mesh.setVerticesData(VertexBuffer.ColorKind, colors, true);
      this.suitParts.push({ mesh, neutral, colors, vertices });
    }
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    this.shadow.addShadowCaster(mesh);
    this.meshes.push(mesh);
    // Chair and wheels keep their own support; only the body participates in ground placement.
    if (parent !== this.facing && parent.parent !== this.facing) {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const points: number[] = [],
        seen = new Set<string>();
      for (let i = 0; i < positions.length; i += 3) {
        const key = `${positions[i]},${positions[i + 1]},${positions[i + 2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(positions[i], positions[i + 1], positions[i + 2]);
      }
      this.supportVertices.set(mesh, Float32Array.from(points));
    }
  }

  private articulate(): void {
    if (this.articulated) return;
    this.articulated = true;
    for (const limb of this.limbs) {
      if (this.seated && (limb.parent === this.leftHip || limb.parent === this.rightHip)) continue;
      let bottom = 0;
      for (let i = 1; i < limb.data.positions!.length; i += 3)
        bottom = Math.min(bottom, limb.data.positions![i]);
      const split = bottom * 0.5;
      limb.hinge.position.y = split;
      const hand =
        limb.parent === this.leftShoulder
          ? this.leftHand
          : limb.parent === this.rightShoulder
            ? this.rightHand
            : undefined;
      hand?.position.set(0, bottom * 0.86 - split, 0);
      for (const [index, half] of splitLimb(limb.data, limb.clothing, split).entries()) {
        if (!half.data.indices?.length) continue;
        const mesh = new Mesh(`${limb.mesh.name}-${index}`, this.scene);
        half.data.applyToMesh(mesh);
        this.installPart(
          mesh,
          `${limb.mesh.name}-${index}`,
          index ? limb.hinge : limb.parent,
          half.clothingVertices,
        );
      }
      this.shadow.removeShadowCaster(limb.mesh);
      this.supportVertices.delete(limb.mesh);
      this.meshes.splice(this.meshes.indexOf(limb.mesh), 1);
      const suit = this.suitParts.findIndex((part) => part.mesh === limb.mesh);
      if (suit >= 0) this.suitParts.splice(suit, 1);
      limb.mesh.dispose();
    }
    this.limbs.length = 0;
  }

  setColor(color: string): void {
    this.color = color;
    const suit = Color3.FromHexString(color);
    for (const part of this.suitParts) {
      for (let offset = 0; offset < part.vertices * 4; offset += 4) {
        part.colors[offset] = part.neutral[offset] * suit.r;
        part.colors[offset + 1] = part.neutral[offset + 1] * suit.g;
        part.colors[offset + 2] = part.neutral[offset + 2] * suit.b;
      }
      part.mesh.updateVerticesData(VertexBuffer.ColorKind, part.colors);
    }
  }

  applyPose(
    pose: AvatarPose,
    height: number,
    travel = 0,
    supportWeight = 0,
    articulated = false,
  ): void {
    if (articulated && !this.articulated) {
      this.articulate();
      if (this.color) this.setColor(this.color);
    }
    const seated = this.seated ? 0 : 1;
    this.facing.rotation.y = pose.facingOffset;
    this.body.rotation.set(
      pose.lean * (this.seated ? 0.4 : 1),
      0,
      pose.roll * (this.seated ? 0.3 : 1),
    );
    this.body.position.y = pose.lift * height * seated;
    this.leftShoulder.rotation.set(pose.leftArm, pose.leftArmYaw, pose.leftArmRoll);
    this.rightShoulder.rotation.set(pose.rightArm, pose.rightArmYaw, pose.rightArmRoll);
    this.leftHip.rotation.x = pose.leftLeg * seated;
    this.rightHip.rotation.x = pose.rightLeg * seated;
    this.leftHip.rotation.z = pose.leftLegRoll * seated;
    this.rightHip.rotation.z = pose.rightLegRoll * seated;
    this.leftElbow.rotation.x = pose.leftElbow;
    this.rightElbow.rotation.x = pose.rightElbow;
    this.leftKnee.rotation.x = pose.leftKnee * seated;
    this.rightKnee.rotation.x = pose.rightKnee * seated;
    this.garment.setPivotPoint(
      new Vector3(0, (this.leftHip.position.y + this.rightHip.position.y) / 2, 0),
    );
    this.garment.rotation.x = articulated ? (pose.leftLeg + pose.rightLeg) * 0.5 * seated : 0;
    this.posture.rotation.set(
      pose.rootPitch * seated,
      pose.rootYaw * seated,
      pose.rootRoll * seated,
    );
    this.posture.position.set(
      pose.rootX * height * seated,
      pose.rootY * height * seated,
      pose.rootZ * height * seated,
    );
    this.supportY = 0;
    if (supportWeight > 0 && !this.seated) {
      this.posture.position.y = 0;
      let minimum = Infinity;
      for (const [mesh, vertices] of this.supportVertices) {
        const m = mesh.computeWorldMatrix(true).m;
        for (let i = 0; i < vertices.length; i += 3)
          minimum = Math.min(
            minimum,
            vertices[i] * m[1] + vertices[i + 1] * m[5] + vertices[i + 2] * m[9] + m[13],
          );
      }
      const floor = (this.facing.parent as TransformNode).getAbsolutePosition().y - height / 2;
      const correction = floor - minimum;
      this.supportY = correction * (correction > 0 ? 1 : supportWeight);
      this.posture.position.y = this.supportY + pose.rootY * height;
    }
    this.onTravel?.(travel);
  }

  private color = '';

  diagnostics() {
    const bounds = this.articulated ? this.bounds() : undefined;
    const point = (v: Vector3) => ({ x: v.x, y: v.y, z: v.z });
    return {
      articulated: this.articulated,
      supportY: this.supportY,
      bounds: bounds ? { min: point(bounds.min), max: point(bounds.max) } : undefined,
    };
  }

  /** Exact vertex bounds of the visual body, without chair, props or the physical capsule. */
  bounds(): { min: Vector3; max: Vector3 } {
    const min = new Vector3(Infinity, Infinity, Infinity),
      max = min.scale(-1);
    for (const [mesh, vertices] of this.supportVertices) {
      const m = mesh.computeWorldMatrix(true).m;
      for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i],
          y = vertices[i + 1],
          z = vertices[i + 2];
        const wx = x * m[0] + y * m[4] + z * m[8] + m[12];
        const wy = x * m[1] + y * m[5] + z * m[9] + m[13];
        const wz = x * m[2] + y * m[6] + z * m[10] + m[14];
        min.x = Math.min(min.x, wx);
        max.x = Math.max(max.x, wx);
        min.y = Math.min(min.y, wy);
        max.y = Math.max(max.y, wy);
        min.z = Math.min(min.z, wz);
        max.z = Math.max(max.z, wz);
      }
    }
    return { min, max };
  }

  dispose(): void {
    for (const mesh of this.meshes) this.shadow.removeShadowCaster(mesh);
    this.facing.dispose();
    this.material.dispose();
  }
}
