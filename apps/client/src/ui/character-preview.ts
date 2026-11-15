import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import {
  TICK_RATE,
  findAnimation,
  isGroundAnimation,
  type AnimationId,
  type AvatarSkinId,
  type SimulationConfig,
} from '@su/contracts';
import { AvatarView } from '../rendering/avatars/avatar-view';
import type { DisplayPlayer } from '../presentation/display-state';

/** A small private scene that shows the real avatar model, recoloured live and slowly turning. */
export class CharacterPreview {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly root: TransformNode;
  private readonly ground: Mesh;
  private readonly view: AvatarView;
  private readonly player: DisplayPlayer;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private yaw = Math.PI * 0.12;
  private dragging?: { pointer: number; x: number };
  private idleTime = 0;
  private disposed = false;
  private animationId?: AnimationId;
  private animationTimeMs = 0;
  private animationSequence = 0;
  private reducedOverride?: boolean;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    config: SimulationConfig['character'],
    skinId: AvatarSkinId,
    color: string,
  ) {
    this.engine = new Engine(canvas, true, { antialias: true, alpha: true, stencil: false });
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.ground = MeshBuilder.CreateGround(
      'preview-support',
      { width: config.height * 2.6, height: config.height * 2.6 },
      this.scene,
    );
    const groundMaterial = new StandardMaterial('preview-support', this.scene);
    groundMaterial.diffuseColor = Color3.FromHexString('#52616a');
    groundMaterial.specularColor = Color3.Black();
    groundMaterial.alpha = 0.65;
    this.ground.material = groundMaterial;
    this.ground.setEnabled(false);
    const camera = new ArcRotateCamera(
      'preview',
      Math.PI / 2,
      Math.PI / 2.15,
      config.height * 2.6,
      new Vector3(0, config.height * 0.5, 0),
      this.scene,
    );
    camera.fov = 0.5;
    camera.minZ = 0.1;
    camera.inputs.clear();
    const sky = new HemisphericLight('preview-sky', new Vector3(0, 1, 0), this.scene);
    sky.intensity = 0.9;
    sky.diffuse = Color3.FromHexString('#d5e7ee');
    sky.groundColor = Color3.FromHexString('#2b3640');
    const sun = new DirectionalLight('preview-sun', new Vector3(-0.5, -1, -0.8), this.scene);
    sun.intensity = 1.1;
    const shadow = new ShadowGenerator(256, sun);
    this.root = new TransformNode('preview-root', this.scene);
    this.root.position.y = config.height / 2;
    this.view = new AvatarView(this.root, this.scene, shadow, config, skinId);
    this.player = {
      kind: 'player',
      entityId: 'preview',
      position: { x: 0, y: config.height / 2, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      revision: 0,
      grounded: true,
      motionRevision: 0,
      motionEnabled: true,
      skinId,
      color,
      connected: true,
    } as unknown as DisplayPlayer;
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerUp);
    this.engine.runRenderLoop(() => {
      if (document.hidden || canvas.hidden) return;
      const delta = Math.min(0.1, this.engine.getDeltaTime() / 1000);
      const reduced = this.reducedOverride ?? this.reducedMotion.matches;
      this.idleTime += delta;
      this.animationTimeMs += delta * 1000;
      this.player.animation = this.animationId
        ? {
            animationId: this.animationId,
            worldEpoch: 'local-preview',
            sequence: this.animationSequence,
            startedAtTick: 0,
            endsAtTick: 0,
            changedAtTick: 0,
            displayTick: (this.animationTimeMs * TICK_RATE) / 1000,
            displayTimeMs: this.animationTimeMs,
          }
        : undefined;
      if (!this.dragging && !reduced) this.yaw += delta * 0.45;
      const bob =
        reduced || this.animationId ? 0 : Math.sin((this.idleTime / 3.2) * Math.PI * 2) * 0.03;
      this.root.position.y = config.height / 2 + bob;
      this.root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), this.yaw);
      this.view.update(this.player, delta, false, reduced);
      this.scene.render();
    });
    this.resize();
  }
  setSkin(skinId: AvatarSkinId): void {
    this.player.skinId = skinId;
  }
  /** Local preview only. No GameSession or server request is involved. */
  setAnimation(id?: AnimationId): void {
    if (id === this.animationId) return;
    this.animationId = id;
    this.ground.setEnabled(isGroundAnimation(findAnimation(id)));
    this.animationTimeMs = 0;
    this.animationSequence++;
  }
  setReducedMotion(reduced?: boolean): void {
    this.reducedOverride = reduced;
  }
  setColor(color: string): void {
    this.player.color = color;
  }
  resize(): void {
    this.engine.resize();
  }
  private readonly pointerDown = (event: PointerEvent) => {
    this.dragging = { pointer: event.pointerId, x: event.clientX };
    this.canvas.setPointerCapture(event.pointerId);
  };
  private readonly pointerMove = (event: PointerEvent) => {
    if (this.dragging?.pointer !== event.pointerId) return;
    this.yaw += (event.clientX - this.dragging.x) * 0.012;
    this.dragging.x = event.clientX;
  };
  private readonly pointerUp = (event: PointerEvent) => {
    if (this.dragging?.pointer === event.pointerId) this.dragging = undefined;
  };
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointercancel', this.pointerUp);
    this.engine.stopRenderLoop();
    this.view.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}
