import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Material } from '@babylonjs/core/Materials/material';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { BuildingChunks } from '../../apps/client/src/rendering/building-chunks';
import {
  WorldNightLights,
  GLOW_ATTRIBUTE,
} from '../../apps/client/src/rendering/environment/night-lights';
import {
  registerWallSurface,
  SURFACE_ATTRIBUTE,
} from '../../apps/client/src/rendering/environment/wall-surface';
import { SURFACE_KIND } from '../../packages/contracts/src/index';
import type { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { WorldLighting } from '../../apps/client/src/rendering/environment/lighting';

const canvas = document.querySelector('canvas')!;
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
const camera = new ArcRotateCamera('overview', -Math.PI / 2.5, 0.7, 90, Vector3.Zero(), scene);
camera.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = -22;
camera.orthoRight = 22;
camera.orthoTop = 16.5;
camera.orthoBottom = -16.5;
camera.minZ = 0.1;
camera.maxZ = 2000;
const eye = new FreeCamera('eyes', new Vector3(0, 2, -18), scene);
eye.setTarget(new Vector3(0, 2, 0));
eye.minZ = 0.1;
const lighting = new WorldLighting(scene, camera, [eye]);
const sun = lighting.shadow.getLight() as DirectionalLight;
lighting.setTimeOfDay(12);
lighting.follow(Vector3.Zero());
const ground = MeshBuilder.CreateGround('ground', { width: 1800, height: 1800 }, scene);
ground.receiveShadows = true;
const groundMaterial = new PBRMaterial('ground', scene);
groundMaterial.albedoColor = new Color3(0.6, 0.6, 0.6);
groundMaterial.metallic = 0;
groundMaterial.roughness = 1;
ground.material = groundMaterial;
const caster = MeshBuilder.CreateBox('house', { width: 5, depth: 5, height: 8 }, scene);
caster.position.set(-2, 4, 0);
const material = new PBRMaterial('house', scene);
material.albedoColor = new Color3(0.5, 0.25, 0.15);
material.metallic = 0;
material.roughness = 1;
caster.material = material;
caster.freezeWorldMatrix();
// Receivers enable Babylon's SHADOW define from the composed generator's caster
// list. Include a moving caster, as the game does for avatars.
const avatar = MeshBuilder.CreateSphere('avatar', { diameter: 1 }, scene);
avatar.position.set(8, 0.5, 8);
avatar.material = groundMaterial;
lighting.shadow.addShadowCaster(avatar);
let reject = false;
const ready = ShadowGenerator.prototype.isReady;
// Inject a genuine false result below StaticShadowGenerator.isReady, so its
// incomplete-pass bookkeeping is exercised together with real WebGL rendering.
ShadowGenerator.prototype.isReady = function (...args) {
  return !(this === lighting.staticShadow && reject) && ready.apply(this, args);
};
lighting.staticShadow.addShadowCaster(caster);
const snapshots = new Map<string, Uint8Array>();
let shadowMask: number[] = [];
let drawCalls = 0;
let shadowPasses = 0;
lighting.shadow.getShadowMap()!.onAfterRenderObservable.add(() => shadowPasses++);
const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;
const gpuErrors: number[] = [];
async function frames(count = 1) {
  for (let i = 0; i < count; i++) {
    engine.beginFrame();
    const calls = engine._drawCalls.current;
    scene.render();
    drawCalls = engine._drawCalls.current - calls;
    engine.endFrame();
    const error = gl.getError();
    if (error !== gl.NO_ERROR && !gpuErrors.includes(error)) gpuErrors.push(error);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return stats();
}
function stats() {
  return {
    ...lighting.shadowDiagnostics(),
    lightPosition: sun.position.asArray(),
    lightDirection: sun.direction.asArray(),
    projection: lighting.shadow.getTransformMatrix().asArray(),
    shadowPasses,
    drawCalls,
    gpuErrors: [...gpuErrors],
    webglVersion: engine.webGLVersion,
  };
}
async function pixels() {
  const read = (await engine.readPixels(0, 0, canvas.width, canvas.height))!;
  return new Uint8Array(read.buffer, read.byteOffset, read.byteLength).slice();
}
async function snapshot(name: string) {
  snapshots.set(name, await pixels());
  return stats();
}
async function compare(name: string, masked = false) {
  const reference = snapshots.get(name)!;
  const actual = await pixels();
  const indices = masked ? shadowMask : Array.from({ length: actual.length / 4 }, (_, i) => i);
  let changed = 0,
    sum = 0,
    maximum = 0;
  for (const i of indices) {
    let difference = 0;
    for (let c = 0; c < 3; c++)
      difference = Math.max(difference, Math.abs(actual[i * 4 + c] - reference[i * 4 + c]));
    changed += Number(difference > 8);
    sum += difference;
    maximum = Math.max(maximum, difference);
  }
  return {
    samples: indices.length,
    changed: changed / indices.length,
    mean: sum / indices.length,
    maximum,
  };
}
async function markShadowMask() {
  const baseline = snapshots.get('opaque')!;
  const unshadowed = snapshots.get('unshadowed')!;
  const viewport = camera.viewport.toGlobal(canvas.width, canvas.height);
  const corners = caster
    .getBoundingInfo()
    .boundingBox.vectorsWorld.map((point) =>
      Vector3.Project(point, Matrix.IdentityReadOnly, scene.getTransformMatrix(), viewport),
    );
  const minX = Math.min(...corners.map((p) => p.x)) - 2;
  const maxX = Math.max(...corners.map((p) => p.x)) + 2;
  // readPixels is bottom-up; Project is top-down.
  const minY = canvas.height - Math.max(...corners.map((p) => p.y)) - 2;
  const maxY = canvas.height - Math.min(...corners.map((p) => p.y)) + 2;
  shadowMask = [];
  for (let i = 0; i < baseline.length / 4; i++) {
    const x = i % canvas.width,
      y = Math.floor(i / canvas.width);
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
    const difference = unshadowed[i * 4] - baseline[i * 4];
    if (difference > 15) shadowMask.push(i);
  }
  return shadowMask.length;
}

async function buildingChunks() {
  const chunkScene = new Scene(engine);
  const focus = new Vector3(280, 0, 0);
  const chunkCamera = new ArcRotateCamera('chunks', -Math.PI / 2.5, 0.9, 100, focus, chunkScene);
  chunkCamera.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA;
  chunkCamera.orthoLeft = -45;
  chunkCamera.orthoRight = 45;
  chunkCamera.orthoTop = 33.75;
  chunkCamera.orthoBottom = -33.75;
  chunkCamera.minZ = 0.1;
  const chunkLighting = new WorldLighting(chunkScene, chunkCamera);
  const night = new WorldNightLights(chunkScene);
  registerWallSurface(chunkScene);
  chunkLighting.follow(focus);
  const chunks = new BuildingChunks(chunkScene, chunkLighting.staticShadow);
  const floor = MeshBuilder.CreateGround('chunks-ground', { width: 300, height: 300 }, chunkScene);
  floor.position.x = focus.x;
  floor.receiveShadows = true;
  const floorMaterial = new PBRMaterial('chunks-ground', chunkScene);
  floorMaterial.albedoColor.set(0.2, 0.25, 0.2);
  floorMaterial.metallic = 0;
  floorMaterial.roughness = 0.9;
  floor.material = floorMaterial;
  const chunkAvatar = MeshBuilder.CreateSphere('chunks-avatar', { diameter: 1 }, chunkScene);
  chunkAvatar.position.set(focus.x + 35, 0.5, 12);
  chunkAvatar.material = floorMaterial;
  chunkLighting.shadow.addShadowCaster(chunkAvatar);
  const originals = [];
  for (let house = 0; house < 3; house++) {
    const x = 254 + house * 24;
    const meshes = [];
    for (let part = 0; part < 5; part++) {
      const window = part > 0;
      const mesh = MeshBuilder.CreateBox(
        `house-${house}-${part}`,
        window ? { width: 2.1, height: 2.4, depth: 0.12 } : { width: 16, height: 10, depth: 10 },
        chunkScene,
      );
      mesh.position.set(
        x + (window ? (part % 2 ? -4 : 4) : 0),
        window ? (part < 3 ? 3 : 7) : 5,
        window ? -5.08 : 0,
      );
      mesh.receiveShadows = true;
      const paint = new PBRMaterial(`house-paint-${house}-${part}`, chunkScene);
      paint.albedoColor = window
        ? new Color3(0.12, 0.16, 0.2)
        : new Color3(0.35 + house * 0.12, 0.22 + house * 0.08, 0.16);
      paint.metallic = 0;
      paint.roughness = 0.9;
      paint.transparencyMode = Material.MATERIAL_OPAQUE;
      mesh.material = paint;
      mesh.removeVerticesData(VertexBuffer.UVKind);
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const colors = [],
        surface = [],
        glow = [];
      for (let v = 0; v < mesh.getTotalVertices(); v++) {
        const shade = 0.8 + (v % 4) * 0.04;
        colors.push(shade, shade, shade, 1);
        surface.push(
          (window ? 0 : SURFACE_KIND.brick * 1000) + positions[v * 3] + 8.5,
          positions[v * 3 + 1] + 5,
        );
        glow.push(window ? 1 : 0, part * 7 + house);
      }
      mesh.setVerticesData(VertexBuffer.ColorKind, colors, false, 4);
      mesh.setVerticesData(SURFACE_ATTRIBUTE, surface, false, 2);
      mesh.setVerticesData(GLOW_ATTRIBUTE, glow, false, 2);
      mesh.freezeWorldMatrix();
      chunkLighting.staticShadow.addShadowCaster(mesh);
      meshes.push(mesh);
      originals.push(mesh);
    }
    chunks.add({ id: `house-${house}`, position: { x, z: 0 }, meshes, eligible: () => true });
  }
  let calls = 0;
  let chunkCenter = focus;
  const renderChunks = async (count = 20) => {
    for (let i = 0; i < count; i++) {
      chunks.update(chunkCenter);
      engine.beginFrame();
      const before = engine._drawCalls.current;
      chunkScene.render();
      calls = engine._drawCalls.current - before;
      engine.endFrame();
      const error = gl.getError();
      if (error !== gl.NO_ERROR && !gpuErrors.includes(error)) gpuErrors.push(error);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  };
  const comparison = (before: Uint8Array, after: Uint8Array) => {
    let changed = 0,
      sum = 0;
    for (let i = 0; i < before.length; i += 4) {
      let difference = 0;
      for (let c = 0; c < 3; c++)
        difference = Math.max(difference, Math.abs(before[i + c] - after[i + c]));
      changed += Number(difference > 8);
      sum += difference;
    }
    return { changed: changed / (before.length / 4), mean: sum / (before.length / 4) };
  };
  const result = [];
  try {
    for (const hour of [12, 21, 1]) {
      chunkCenter = focus;
      chunks.update(focus);
      chunkLighting.setTimeOfDay(hour);
      night.update(hour, 17, focus);
      await renderChunks();
      const reference = await pixels();
      const originalCalls = calls;
      chunkCenter = Vector3.Zero();
      for (let i = 0; i < 50; i++) chunks.update(Vector3.Zero());
      await renderChunks();
      result.push({
        hour,
        originalCalls,
        mergedCalls: calls,
        ...comparison(reference, await pixels()),
        diagnostics: chunks.diagnostics(),
        originalsEnabled: originals.filter((m) => m.isEnabled()).length,
      });
    }
    chunkCenter = focus;
    chunks.update(focus);
    await renderChunks();
    return {
      comparisons: result,
      restored: originals.every((m) => m.isEnabled()),
      gpuErrors: [...gpuErrors],
    };
  } finally {
    chunks.dispose();
    chunkLighting.dispose();
    chunkScene.dispose();
  }
}

(window as any).__RENDER_OPTIMIZATIONS__ = {
  frames,
  stats,
  snapshot,
  compare,
  markShadowMask,
  buildingChunks,
  async warmup() {
    // Establish a complete reference after material compilation.
    await frames(30);
    lighting.staticShadow.invalidate();
    return frames(15);
  },
  reject(value: boolean) {
    reject = value;
    lighting.staticShadow.invalidate();
  },
  follow(x: number, z: number, width = 0) {
    lighting.follow(new Vector3(x, 0, z), width);
  },
  hour(hour: number) {
    lighting.setTimeOfDay(hour);
  },
  shadows(enabled: boolean) {
    scene.shadowsEnabled = enabled;
    lighting.staticShadow.invalidate();
  },
  alpha(alpha: number) {
    material.alpha = alpha;
    material.transparencyMode = alpha < 1 ? Material.MATERIAL_ALPHABLEND : Material.MATERIAL_OPAQUE;
    lighting.staticShadow.invalidate();
  },
  firstPerson(enabled: boolean) {
    scene.activeCamera = enabled ? eye : camera;
    lighting.follow(Vector3.Zero(), enabled ? 0 : 600);
  },
  dispose() {
    ShadowGenerator.prototype.isReady = ready;
    lighting.dispose();
    scene.dispose();
    engine.dispose();
  },
};
