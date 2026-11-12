import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import type { AvatarSkinId, SimulationConfig } from '@su/contracts';
import { AvatarView } from '../rendering/avatars/avatar-view';
import type { DisplayPlayer } from '../presentation/display-state';

/** A small private scene that shows the real avatar model, recoloured live and slowly turning. */
export class CharacterPreview {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly root: TransformNode;
  private readonly view: AvatarView;
  private readonly player: DisplayPlayer;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private yaw = Math.PI * 0.12;
  private dragging?: { pointer: number; x: number };
  private idleTime = 0;
  private disposed = false;

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
      this.idleTime += delta;
      if (!this.dragging && !this.reducedMotion.matches) this.yaw += delta * 0.45;
      const bob = this.reducedMotion.matches
        ? 0
        : Math.sin((this.idleTime / 3.2) * Math.PI * 2) * 0.03;
      this.root.position.y = config.height / 2 + bob;
      this.root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), this.yaw);
      this.view.update(this.player, delta, false, this.reducedMotion.matches);
      this.scene.render();
    });
    this.resize();
  }
  setSkin(skinId: AvatarSkinId): void {
    this.player.skinId = skinId;
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
