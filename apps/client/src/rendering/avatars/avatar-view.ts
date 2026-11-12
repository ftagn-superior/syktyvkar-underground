import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import {
  DEFAULT_AVATAR_SKIN,
  resolveAvatarSkinId,
  type AvatarSkinId,
  type SimulationConfig,
} from '@su/contracts';
import type { DisplayPlayer } from '../../presentation/display-state';
import { CharacterAnimator, type FootstepMarkers } from './character-animator';
import { AvatarRig } from './avatar-rig';
import { SKIN_BUILDERS } from './skins';

const MARKER_ALPHA = 0.55;

/** One animator and stable entity root; a skin supplies only the visual rig's appearance. */
export class AvatarView {
  private rig: AvatarRig;
  private skinId: AvatarSkinId;
  private readonly animator: CharacterAnimator;
  private marker?: Mesh;
  private markerMaterial?: StandardMaterial;
  private color = '';
  private alpha = 1;

  constructor(
    private readonly root: TransformNode,
    private readonly scene: Scene,
    private readonly shadow: ShadowGenerator,
    private readonly config: SimulationConfig['character'],
    skinId: AvatarSkinId = DEFAULT_AVATAR_SKIN,
  ) {
    this.animator = new CharacterAnimator(config.speed, config.sprintSpeed);
    this.skinId = resolveAvatarSkinId(skinId);
    this.rig = this.buildRig();
  }

  private buildRig(): AvatarRig {
    const rig = new AvatarRig(this.root, this.scene, this.shadow);
    SKIN_BUILDERS[this.skinId](rig, this.config);
    return rig;
  }

  resetMotion(): void {
    this.animator.resetMotion();
  }

  update(
    player: DisplayPlayer,
    delta: number,
    own: boolean,
    reducedMotion: boolean,
  ): Readonly<FootstepMarkers> {
    const skinId = resolveAvatarSkinId(player.skinId);
    const changed = skinId !== this.skinId;
    if (changed) {
      this.rig.dispose();
      this.skinId = skinId;
      this.rig = this.buildRig();
    }
    const color = player.color ?? '#d6a15a';
    if (changed || color !== this.color) {
      this.color = color;
      this.rig.setColor(color);
      if (this.markerMaterial) {
        this.markerMaterial.diffuseColor = Color3.FromHexString(color);
        this.markerMaterial.emissiveColor = this.markerMaterial.diffuseColor.scale(0.35);
      }
    }
    if (own && !this.marker) {
      // A flat hexagon on the ground (low-poly replacement for the former ring).
      this.marker = MeshBuilder.CreateDisc(
        `marker-${this.root.name}`,
        { radius: this.config.radius * 1.55, tessellation: 6 },
        this.scene,
      );
      this.marker.parent = this.root;
      this.marker.rotation.x = Math.PI / 2;
      this.marker.position.y = -this.config.height / 2 + 0.04;
      this.marker.isPickable = false;
      this.markerMaterial = new StandardMaterial(`marker-${this.root.name}`, this.scene);
      this.markerMaterial.diffuseColor = Color3.FromHexString(color);
      this.markerMaterial.specularColor.set(0.16, 0.17, 0.18);
      this.markerMaterial.specularPower = 72;
      this.markerMaterial.emissiveColor = this.markerMaterial.diffuseColor.scale(0.35);
      this.markerMaterial.backFaceCulling = false;
      this.marker.material = this.markerMaterial;
    }
    this.marker?.setEnabled(own);
    const alpha = player.connected === false ? 0.45 : 1;
    if (changed || alpha !== this.alpha || this.markerMaterial?.alpha !== alpha * MARKER_ALPHA) {
      this.alpha = alpha;
      this.rig.material.alpha = alpha;
      if (this.markerMaterial) this.markerMaterial.alpha = alpha * MARKER_ALPHA;
    }
    this.rig.applyPose(this.animator.update(player, delta, own, reducedMotion), this.config.height);
    return this.animator.footsteps;
  }

  diagnostics() {
    return { entityId: this.root.name, skinId: this.skinId, ...this.animator.diagnostics() };
  }

  dispose(): void {
    this.rig.dispose();
    this.marker?.dispose();
    this.markerMaterial?.dispose();
  }
}
