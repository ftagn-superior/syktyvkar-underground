import { Color3 } from '@babylonjs/core/Maths/math.color';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { AvatarPose } from './locomotion';

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
  readonly body: TransformNode;
  readonly head: TransformNode;
  readonly leftShoulder: TransformNode;
  readonly rightShoulder: TransformNode;
  readonly leftHip: TransformNode;
  readonly rightHip: TransformNode;
  readonly material: StandardMaterial;
  private readonly meshes: Mesh[] = [];
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
    this.body = joint('pose', this.facing);
    this.head = joint('head', this.body);
    this.leftShoulder = joint('leftShoulder', this.body);
    this.rightShoulder = joint('rightShoulder', this.body);
    this.leftHip = joint('leftHip', this.body);
    this.rightHip = joint('rightHip', this.body);
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
  }

  setColor(color: string): void {
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

  applyPose(pose: AvatarPose, height: number): void {
    this.facing.rotation.y = pose.facingOffset;
    this.body.rotation.set(pose.lean, 0, pose.roll);
    this.body.position.y = pose.lift * height;
    this.leftShoulder.rotation.set(pose.leftArm, 0, -pose.armSpread);
    this.rightShoulder.rotation.set(pose.rightArm, 0, pose.armSpread);
    this.leftHip.rotation.x = pose.leftLeg;
    this.rightHip.rotation.x = pose.rightLeg;
  }

  dispose(): void {
    for (const mesh of this.meshes) this.shadow.removeShadowCaster(mesh);
    this.facing.dispose();
    this.material.dispose();
  }
}
