import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { AVATAR_SKINS, animationSkinSupport, type AnimationId } from '../../packages/contracts/src';
import { AvatarView } from '../../apps/client/src/rendering/avatars/avatar-view';
import type { DisplayPlayer } from '../../apps/client/src/presentation/display-state';
import { rigDefinitions, rigLibrary } from '../fixtures/animation-rig';

const engine = new Engine(document.querySelector('canvas')!, true);
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
scene.clearColor = new Color4(0.06, 0.095, 0.12, 1);
const camera = new ArcRotateCamera(
  'matrix',
  Math.PI / 2,
  Math.PI / 2 - 0.12,
  60,
  Vector3.Zero(),
  scene,
);
camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = -9;
camera.orthoRight = 9;
camera.orthoTop = 14;
camera.orthoBottom = -13;
camera.minZ = 0.01;
camera.maxZ = 200;
new HemisphericLight('fill', new Vector3(0, 1, 1), scene).intensity = 0.9;
const sun = new DirectionalLight('sun', new Vector3(-0.7, -1.5, -1), scene);
sun.intensity = 1.2;
const shadow = new ShadowGenerator(1024, sun);
shadow.bias = 0.01;
shadow.normalBias = 0.04;
const floorMaterial = new StandardMaterial('support', scene);
floorMaterial.diffuseColor = Color3.FromHexString('#364652');
floorMaterial.specularColor = Color3.Black();
const figures: { view: AvatarView; player: DisplayPlayer }[] = [];
AVATAR_SKINS.forEach((skin, row) => {
  rigDefinitions.forEach((definition, col) => {
    if (animationSkinSupport(definition, skin.id) === 'unavailable') return;
    const root = new TransformNode(`${skin.id}/${definition.id}`, scene);
    const y = (3.5 - row) * 3.25;
    root.position.set((col - 1.5) * 4.4, y + 0.9, 0);
    root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), col === 1 ? Math.PI / 2 : 0.35);
    const floor = MeshBuilder.CreateGround('support', { width: 3.6, height: 3.6 }, scene);
    floor.position.set(root.position.x, y, 0);
    floor.material = floorMaterial;
    floor.receiveShadows = true;
    const view = new AvatarView(
      root,
      scene,
      shadow,
      { height: 1.8, radius: 0.35, speed: 4, sprintSpeed: 14, mass: 70 },
      skin.id,
      rigLibrary,
    );
    const player: DisplayPlayer = {
      entityId: root.name,
      kind: 'player',
      skinId: skin.id,
      revision: 0,
      motionRevision: 0,
      motionEnabled: true,
      connected: true,
      grounded: true,
      position: { x: root.position.x, y: root.position.y, z: root.position.z },
      rotation: {
        x: root.rotationQuaternion.x,
        y: root.rotationQuaternion.y,
        z: root.rotationQuaternion.z,
        w: root.rotationQuaternion.w,
      },
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      color: '#65d6bc',
      animation: {
        animationId: definition.id as AnimationId,
        worldEpoch: 'matrix',
        sequence: 1,
        startedAtTick: 0,
        changedAtTick: 0,
        endsAtTick: 0,
        displayTick: 180,
        displayTimeMs: 3000,
      },
    };
    figures.push({ view, player });
  });
});
const api = window as unknown as {
  rigGalleryReady: boolean;
  rigGalleryPose(ms: number, reduced: boolean): void;
  rigGalleryDiagnostics(): unknown;
};
api.rigGalleryPose = (ms, reduced) => {
  document.querySelector('#motion')!.textContent = reduced
    ? 'Уменьшенное движение · колесо: подготовительная поза'
    : `Обычное движение · фаза ${ms} мс`;
  figures.forEach(({ view, player }) => {
    player.animation!.displayTick = ms * 0.06;
    player.animation!.displayTimeMs = ms;
    view.update(player, 1 / 60, false, reduced);
  });
};
api.rigGalleryPose(3000, false);
api.rigGalleryDiagnostics = () => figures.map(({ view }) => view.diagnostics());
engine.runRenderLoop(() => scene.render());
scene.executeWhenReady(() => (api.rigGalleryReady = true));
