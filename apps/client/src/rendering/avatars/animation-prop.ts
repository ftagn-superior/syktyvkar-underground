import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { AvatarSkinId } from '@su/contracts';
import { paintMesh, type AvatarRig } from './avatar-rig';
import type { AnimationProp } from './clips/types';

/** One merged cosmetic mesh per active clip. The clip owns all geometry in its fingerprint. */
export class AvatarAnimationProp {
  private definition?: AnimationProp;
  private mesh?: Mesh;
  private material?: StandardMaterial;

  constructor(
    private readonly rig: AvatarRig,
    private readonly skin: AvatarSkinId,
    private readonly height: number,
    private readonly shadow: ShadowGenerator,
  ) {}

  update(definition: AnimationProp | undefined, opacity: number): void {
    if (opacity <= 0.001) definition = undefined;
    if (definition !== this.definition) {
      this.dispose();
      this.definition = definition;
      if (definition) this.create(definition);
    }
    if (this.material) this.material.alpha = opacity;
    if (this.mesh && definition?.anchor === 'right-hand') {
      // Keep the authored grip on the new wrist, including after lazy limb splitting.
      // The offsets preserve the three v1 clips' existing hand/paw centres.
      const bear = this.skin === 'bear' || this.skin === 'bear-wheelchair';
      const minifigure = this.skin === 'minifigure';
      this.mesh.position.set(
        0,
        -this.height * (minifigure ? 0.31 : bear ? 0.235 : 0.25) -
          this.rig.rightElbow.position.y -
          this.rig.rightHand.position.y,
        minifigure ? this.height * 0.045 : 0,
      );
    }
  }

  private create(definition: AnimationProp): void {
    const { scene } = this.rig;
    const pieces = definition.parts.map((part) => {
      const [width, height, depth] = part.size.map((value) => value * this.height);
      const mesh =
        part.shape === 'box'
          ? MeshBuilder.CreateBox('animation-prop-part', { width, height, depth }, scene)
          : MeshBuilder.CreateCylinder(
              'animation-prop-part',
              { height, diameter: width, tessellation: 12 },
              scene,
            );
      mesh.position.set(
        ...(part.position.map((value) => value * this.height) as [number, number, number]),
      );
      if (part.rotation) mesh.rotation.set(...part.rotation);
      return paintMesh(mesh, Color3.FromHexString(part.color));
    });
    const mesh = Mesh.MergeMeshes(pieces, true)!;
    mesh.name = `animation-prop-${this.rig.facing.parent!.name}`;
    mesh.parent = definition.anchor === 'body' ? this.rig.body : this.rig.rightHand;
    if (definition.rotation) mesh.rotation.set(...definition.rotation);
    this.material = new StandardMaterial(mesh.name, scene);
    this.material.diffuseColor = Color3.White();
    this.material.specularColor.set(0.15, 0.15, 0.15);
    mesh.material = this.material;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    this.shadow.addShadowCaster(mesh);
    this.mesh = mesh;
  }

  dispose(): void {
    if (this.mesh) this.shadow.removeShadowCaster(this.mesh);
    this.mesh?.dispose();
    this.material?.dispose();
    this.mesh = undefined;
    this.material = undefined;
    this.definition = undefined;
  }

  diagnostics() {
    return this.mesh
      ? { anchor: this.definition!.anchor, opacity: this.material!.alpha }
      : undefined;
  }
}
