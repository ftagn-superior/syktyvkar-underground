import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type {
  WorldManifest,
  WorldHeader,
  BuildingInstance,
} from '../../packages/contracts/src/index';
import { BuildingViews } from '../../apps/client/src/rendering/buildings';
import { applyRadialFog } from '../../apps/client/src/rendering/radial-fog';

const canvas = document.querySelector('canvas')!;
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
let scene: Scene, views: BuildingViews, release: (() => void) | undefined;
let radial = { center: { x: 0, y: 0, z: 0 }, radius: 10000, time: 10000, appearMs: 300 };
let camera: ArcRotateCamera;
let placements: BuildingInstance[] = [];
let own: Vector3 | undefined;
let lastPixels: Uint8Array | undefined;
let drawCalls = 0;
const render = async (count = 30) => {
  for (let i = 0; i < count; i++) {
    radial.time = performance.now() + 1000;
    camera.getViewMatrix(true);
    views.update(
      own,
      camera.globalPosition,
      camera.target.subtract(camera.globalPosition).normalize(),
      camera.minZ,
      radial.time,
      0.1,
      undefined,
      Infinity,
    );
    engine.beginFrame();
    const before = engine._drawCalls.current;
    scene.render();
    drawCalls = engine._drawCalls.current - before;
    engine.endFrame();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
};
async function setup(optimized: boolean, shadows: boolean, faded = false) {
  views?.dispose();
  release?.();
  scene?.dispose();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.0627451, 0.0941176, 0.1254902, 1);
  camera = new ArcRotateCamera('camera', -Math.PI / 2.6, 0.9, 160, new Vector3(0, 2, 0), scene);
  camera.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -65;
  camera.orthoRight = 65;
  camera.orthoTop = 48.75;
  camera.orthoBottom = -48.75;
  camera.minZ = 0.1;
  new HemisphericLight('ambient', Vector3.Up(), scene).intensity = 0.7;
  const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, -0.4), scene);
  sun.position = new Vector3(40, 80, 40);
  sun.intensity = 1;
  const shadow = new ShadowGenerator(1024, sun);
  shadow.useBlurExponentialShadowMap = true;
  shadow.blurKernel = 16;
  scene.shadowsEnabled = shadows;
  const ground = MeshBuilder.CreateGround('ground', { width: 200, height: 200 }, scene);
  ground.receiveShadows = true;
  const material = new PBRMaterial('ground', scene);
  material.albedoColor = new Color3(0.12, 0.14, 0.12);
  material.metallic = 0;
  material.roughness = 0.9;
  ground.material = material;
  const manifest: WorldManifest = await (await fetch('/manifest.json')).json();
  const header = { simulation: { character: { height: 1.8, radius: 0.35 } } } as WorldHeader;
  radial = { center: { x: 0, y: 0, z: 0 }, radius: 10000, time: performance.now(), appearMs: 300 };
  views = new BuildingViews(scene, shadow, header, radial);
  release = await views.prepareAssets(manifest, Object.keys(manifest.assets), async (path) => {
    const bytes = new Uint8Array(await (await fetch('/' + path)).arrayBuffer());
    if (!optimized && path.endsWith('parts.json')) {
      const parts = JSON.parse(new TextDecoder().decode(bytes));
      delete parts.tree;
      return new TextEncoder().encode(JSON.stringify(parts));
    }
    return bytes;
  });
  const assets = Object.values(manifest.assets);
  placements = Array.from({ length: 144 }, (_, i) => {
    const rotation = Quaternion.RotationAxis(Vector3.Up(), i * 0.37);
    const definition = {
      entityId: `tree-${i}`,
      assetId: assets[i % assets.length].assetId,
      position: { x: (i % 12) * 8 - 44, y: 0, z: Math.floor(i / 12) * 8 - 44 },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    };
    views.add(definition, manifest.assets[definition.assetId].version);
    return definition;
  });
  for (const mesh of scene.meshes) if (mesh !== ground) applyRadialFog(mesh, radial, 0);
  own = faded ? new Vector3(-4, 1, -4) : undefined;
  await render();
  return stats();
}
function stats() {
  return {
    ...views.aggregateDiagnostics(),
    meshes: scene.meshes.length,
    materials: scene.materials.length,
    drawCalls,
    trees: views.diagnostics().buildings,
    ready: scene
      .getActiveMeshes()
      .data.slice(0, scene.getActiveMeshes().length)
      .every(
        (mesh) =>
          mesh.subMeshes?.every((sub) =>
            mesh.material?.isReadyForSubMesh(mesh, sub, mesh.hasThinInstances),
          ) ?? true,
      ),
  };
}
async function compare() {
  const read = (await engine.readPixels(0, 0, canvas.width, canvas.height))!;
  const pixels = new Uint8Array(read.buffer, read.byteOffset, read.byteLength).slice();
  const previous = lastPixels;
  lastPixels = pixels;
  if (!previous) return { changed: 0, meanError: 0, maxError: 0 };
  let changed = 0,
    error = 0,
    maxError = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    let difference = 0;
    for (let c = 0; c < 3; c++)
      difference = Math.max(difference, Math.abs(pixels[i + c] - previous[i + c]));
    if (difference > 8) changed++;
    error += difference;
    maxError = Math.max(maxError, difference);
  }
  return {
    changed: changed / (pixels.length / 4),
    meanError: error / (pixels.length / 4),
    maxError,
  };
}
(window as any).__TREE_TEST__ = {
  setup,
  compare,
  async unload() {
    for (const tree of placements) views.remove(tree.entityId);
    await render(2);
    return stats();
  },
  async reload() {
    const manifest: WorldManifest = await (await fetch('/manifest.json')).json();
    for (const tree of placements) views.add(tree, manifest.assets[tree.assetId].version);
    await render();
    return stats();
  },
  dispose() {
    views.dispose();
    release?.();
    scene.dispose();
    engine.dispose();
  },
};
