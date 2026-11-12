import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { AvatarView } from '../../apps/client/src/rendering/avatars/avatar-view';
import type { DisplayPlayer } from '../../apps/client/src/presentation/display-state';

const preview = window as unknown as {
  galleryReady: boolean;
  galleryPose(ms: number): void;
  galleryDiagnostics(): { active: number };
};
const engine = new Engine(document.querySelector('canvas')!, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.06, 0.095, 0.12, 1);
const camera = new ArcRotateCamera(
  'camera',
  Math.PI / 2,
  Math.PI / 2 - 0.15,
  16,
  Vector3.Zero(),
  scene,
);
camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = -4.5;
camera.orthoRight = 4.5;
camera.orthoTop = 3;
camera.orthoBottom = -3;
scene.activeCamera = camera;
new HemisphericLight('fill', new Vector3(0, 1, 1), scene);
const shadow = new ShadowGenerator(
  256,
  new DirectionalLight('sun', new Vector3(-1, -2, -1), scene),
);
const avatars: { avatar: AvatarView; player: DisplayPlayer }[] = [];
(['minifigure', 'standard'] as const).forEach((skinId, row) => {
  (['wave', 'clap', 'dance'] as const).forEach((animationId, col) => {
    const root = new TransformNode(skinId + animationId, scene);
    root.position.set((1 - col) * 3, (0.5 - row) * 2.7, 0);
    const avatar = new AvatarView(
      root,
      scene,
      shadow,
      { height: 1.8, radius: 0.35, speed: 4, sprintSpeed: 14, mass: 70 },
      skinId,
    );
    const player: DisplayPlayer = {
      entityId: root.name,
      kind: 'player',
      skinId,
      revision: 0,
      motionRevision: 0,
      motionEnabled: true,
      grounded: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      color: row ? '#e5b867' : '#65d6bc',
      animation: {
        worldEpoch: 'gallery',
        animationId,
        sequence: 1,
        startedAtTick: 0,
        endsAtTick: animationId === 'dance' ? 300 : 180,
        changedAtTick: 0,
        displayTick: 60,
      },
    };
    avatars.push({ avatar, player });
  });
});
preview.galleryPose = (ms) =>
  avatars.forEach(({ avatar, player }) => {
    player.animation!.displayTick = ms * 0.06;
    avatar.update(player, 1 / 60, false, false);
  });
preview.galleryPose(825);
engine.runRenderLoop(() => scene.render());
scene.executeWhenReady(() => {
  preview.galleryReady = true;
});
preview.galleryDiagnostics = () => ({ active: scene.getActiveMeshes().length });
