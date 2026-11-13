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

type Scenario = { shadows: boolean; perspective?: boolean; night?: boolean; fog?: boolean };
const canvas = document.querySelector('canvas')!;
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
let scene: Scene, views: BuildingViews, release: (() => void) | undefined, camera: ArcRotateCamera;
let manifest: WorldManifest;
let radial = { center: { x: 50, y: 0, z: 50 }, radius: 10000, time: 10000, appearMs: 300 };
let placements: BuildingInstance[] = [];
let lastPixels: Uint8Array | undefined;
let drawCalls = 0,
  shadowDrawCalls = 0,
  setupMs = 0;
let frameTimes: number[] = [];
const render = async (count = 80) => {
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    radial.time = performance.now() + 1000;
    camera.getViewMatrix(true);
    views.update(
      undefined,
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
    const start = performance.now();
    shadowDrawCalls = 0;
    scene.render();
    const elapsed = performance.now() - start;
    drawCalls = engine._drawCalls.current - before;
    engine.endFrame();
    if (i >= 20) times.push(elapsed);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (times.length) frameTimes = times;
};
async function setup(optimized: boolean, scenario: Scenario) {
  views?.dispose();
  release?.();
  scene?.dispose();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.0627451, 0.0941176, 0.1254902, 1);
  camera = new ArcRotateCamera(
    'camera',
    -Math.PI / 2.6,
    scenario.perspective ? 1.2 : 0.9,
    scenario.perspective ? 95 : 160,
    new Vector3(50, 2, 50),
    scene,
  );
  camera.mode = scenario.perspective
    ? ArcRotateCamera.PERSPECTIVE_CAMERA
    : ArcRotateCamera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -65;
  camera.orthoRight = 65;
  camera.orthoTop = 48.75;
  camera.orthoBottom = -48.75;
  camera.minZ = 0.1;
  new HemisphericLight('ambient', Vector3.Up(), scene).intensity = scenario.night ? 0.15 : 0.7;
  const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, -0.4), scene);
  sun.position = new Vector3(90, 80, 90);
  sun.intensity = scenario.night ? 0.15 : 1;
  const shadow = new ShadowGenerator(1024, sun);
  shadow.useBlurExponentialShadowMap = true;
  shadow.blurKernel = 16;
  scene.shadowsEnabled = scenario.shadows;
  let shadowBefore = 0;
  shadow.getShadowMap()!.onBeforeRenderObservable.add(() => {
    shadowBefore = engine._drawCalls.current;
  });
  shadow.getShadowMap()!.onAfterRenderObservable.add(() => {
    shadowDrawCalls += engine._drawCalls.current - shadowBefore;
  });
  const ground = MeshBuilder.CreateGround('ground', { width: 200, height: 200 }, scene);
  ground.position.set(50, -0.02, 50);
  ground.receiveShadows = true;
  const material = new PBRMaterial('ground', scene);
  material.albedoColor = new Color3(0.12, 0.14, 0.12);
  material.metallic = 0;
  material.roughness = 0.9;
  ground.material = material;
  manifest = await (await fetch(optimized ? '/manifest.json' : '/reference.json')).json();
  const header = { simulation: { character: { height: 1.8, radius: 0.35 } } } as WorldHeader;
  radial = {
    center: { x: 50, y: 0, z: 50 },
    radius: scenario.fog ? 110 : 10000,
    time: performance.now(),
    appearMs: 300,
  };
  views = new BuildingViews(scene, shadow, header, radial);
  const start = performance.now();
  release = await views.prepareAssets(
    manifest,
    Object.keys(manifest.assets),
    async (path) => new Uint8Array(await (await fetch('/' + path)).arrayBuffer()),
  );
  const assets = Object.values(manifest.assets);
  placements = Array.from({ length: assets.length * 16 }, (_, i) => {
    const rotation = Quaternion.FromEulerAngles(
      ((i % 3) - 1) * 0.025,
      i * 0.37,
      ((i % 5) - 2) * 0.015,
    );
    const definition: BuildingInstance = {
      entityId: `static-${i}`,
      assetId: assets[i % assets.length].assetId,
      position: { x: (i % 16) * 5.5 + 8, y: 0.08, z: Math.floor(i / 16) * 6 + 8 },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    };
    views.add(definition, manifest.assets[definition.assetId].version);
    return definition;
  });
  for (const mesh of scene.meshes) if (mesh !== ground) applyRadialFog(mesh, radial, 0);
  setupMs = performance.now() - start;
  await render();
  return stats();
}
function stats() {
  const times = [...frameTimes].sort((a, b) => a - b);
  const gl = (engine as any)._gl as WebGLRenderingContext;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ...views.aggregateDiagnostics(),
    meshes: scene.meshes.length,
    transformNodes: scene.transformNodes.length,
    geometries: scene.geometries.length,
    materials: scene.materials.length,
    setupMs,
    drawCalls,
    shadowDrawCalls,
    mainDrawCalls: drawCalls - shadowDrawCalls,
    frameCpuMedianMs: times[Math.floor(times.length / 2)],
    frameCpuP95Ms: times[Math.floor(times.length * 0.95)],
    frameSamples: times.length,
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    camera: {
      position: camera.position.asArray(),
      target: camera.target.asArray(),
      mode: camera.mode,
    },
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
(window as any).__STATIC_GLB_TEST__ = {
  setup,
  compare,
  async unload() {
    for (const placement of placements) views.remove(placement.entityId);
    release?.();
    release = undefined;
    await render(2);
    return stats();
  },
  async reload() {
    release = await views.prepareAssets(
      manifest,
      Object.keys(manifest.assets),
      async (path) => new Uint8Array(await (await fetch('/' + path)).arrayBuffer()),
    );
    for (const placement of placements)
      views.add(placement, manifest.assets[placement.assetId].version);
    await render(30);
    return stats();
  },
  dispose() {
    views.dispose();
    release?.();
    scene.dispose();
    engine.dispose();
  },
};
