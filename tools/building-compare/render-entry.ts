/**
 * Страница сравнения для tools/building-compare.ts: Babylon-сцена из сгенерированных GLB зданий
 * и камера в точке панорамы Street View. Собирается esbuild'ом в бандл, Node вызывает
 * `window.compare.*` через Playwright.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import {
  adoptSurfaceAttribute,
  registerWallSurface,
} from '../../apps/client/src/rendering/environment/wall-surface';

interface CameraSpec {
  x: number;
  z: number;
  height: number;
  heading: number;
  pitch: number;
  fov: number;
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const engine = new Engine(canvas, true, {
  antialias: true,
  preserveDrawingBuffer: true,
  stencil: false,
});
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
scene.clearColor = new Color4(0.78, 0.84, 0.9, 1);
// Как в игре: материал стен подключается до загрузки моделей.
registerWallSurface(scene);

const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
sky.intensity = 0.95;
sky.diffuse = Color3.FromHexString('#e6eef2');
sky.groundColor = Color3.FromHexString('#5b6066');
const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, 0.35), scene);
sun.intensity = 1.25;

const ground = MeshBuilder.CreateGround('ground', { width: 4000, height: 4000 }, scene);
const groundMaterial = new StandardMaterial('ground', scene);
// Земля без освещения: иначе солнце и небо выжигают её до белого.
groundMaterial.disableLighting = true;
groundMaterial.emissiveColor = Color3.FromHexString('#7d7f7a');
ground.material = groundMaterial;
ground.position.y = -0.02;

const camera = new FreeCamera('camera', new Vector3(0, 2.5, 0), scene);
camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
camera.minZ = 0.3;
camera.maxZ = 3000;

const loaded = new Map<string, AssetContainer>();

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function addModel(id: string, base64: string, x: number, y: number, z: number) {
  loaded.get(id)?.dispose();
  const container = await LoadAssetContainerAsync(decode(base64), scene, {
    pluginExtension: '.glb',
    name: id,
  });
  for (const mesh of container.meshes) if (mesh instanceof Mesh) adoptSurfaceAttribute(mesh);
  for (const material of container.materials) {
    // Без карты окружения PBR темнеет; матовый диэлектрик ближе к виду в игре.
    if (material instanceof PBRMaterial) {
      material.metallic = 0;
      material.roughness = 1;
      material.environmentIntensity = 0;
    }
  }
  const root = container.meshes.find((mesh) => !mesh.parent);
  if (root) root.position.set(x, y, z);
  container.addAllToScene();
  loaded.set(id, container);
}

function aim(spec: CameraSpec) {
  const h = (spec.heading * Math.PI) / 180;
  const p = (spec.pitch * Math.PI) / 180;
  camera.position.set(spec.x, spec.height, spec.z);
  // Север — −Z, восток — +X, heading по часовой от севера.
  camera.setTarget(
    camera.position.add(
      new Vector3(Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)),
    ),
  );
  camera.fov = (spec.fov * Math.PI) / 180;
}

async function render(spec: CameraSpec): Promise<string> {
  aim(spec);
  await scene.whenReadyAsync();
  scene.render();
  scene.render();
  return canvas.toDataURL('image/jpeg', 0.9);
}

/** Кадр без кодирования картинки; чтение пикселя дожидается GPU — для замеров. */
const pixel = new Uint8Array(4);
function renderOnly(spec: CameraSpec): void {
  aim(spec);
  scene.render();
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
}

(window as unknown as { compare: unknown }).compare = { addModel, render, renderOnly, ready: true };
