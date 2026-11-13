import { Color3, Vector3 } from '@babylonjs/core/Maths/math';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import {
  loadWorldHeader,
  type WorldManifest,
  type TerrainGrid,
} from '../../packages/contracts/src/index.js';
import { createPhysicsWorld } from '../../packages/simulation/src/physics-world.js';
import { WorldView } from '../../apps/client/src/rendering/world-view';
import { CellStreamer } from '../../apps/client/src/streaming/cells';
import { VerifiedResources } from '../../apps/client/src/streaming/resources';
import { terrainContours } from '../../tools/world-build/src/terrain.js';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const check = (value: unknown, label: string) => {
  if (!value) throw new Error(label);
};
export async function createTerrainProbe() {
  const manifest: WorldManifest = await (await fetch('/terrain-manifest')).json();
  const grid: TerrainGrid = await (await fetch('/terrain-grid')).json();
  const resources = new VerifiedResources(manifest, '/terrain-assets/');
  const header = await loadWorldHeader(manifest, (p) => resources.read(p));
  const wasm = await (await fetch('/terrain-wasm')).arrayBuffer();
  const world = await createPhysicsWorld(header, wasm, true);
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#222';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100vw;height:100vh;display:block';
  const labels = document.createElement('div');
  document.body.append(canvas, labels);
  const view = new WorldView(canvas, labels, header, 'standard');
  view.setTimeOfDay(12);
  let clockOffset = 0;
  const stream = new CellStreamer(
    manifest,
    resources,
    world,
    view,
    () => performance.now() + clockOffset,
  );
  view.onFrame(() => {
    stream.pump();
    view.setStreamingRadius(500);
  });
  const center = { x: 0, y: 0, z: 0 },
    distant = { x: 2000, y: 0, z: 2000 };
  const counts = () => ({
    meshes: view.scene.meshes.length,
    materials: view.scene.materials.length,
    geometries: view.scene.geometries.length,
    nodes: view.scene.transformNodes.length,
    physics: world.staticDiagnostics(),
    assets: view.buildingDiagnostics().assets.length,
  });
  async function connected() {
    stream.setVisualArea(center, 500);
    stream.setArea(center);
    const deadline = performance.now() + 30000;
    while (!stream.backgroundReady && performance.now() < deadline) {
      stream.pump();
      await frame();
    }
    check(stream.backgroundReady, 'Terrain resources did not connect');
    for (let i = 0; i < 3; i++) await frame();
  }
  async function disconnected() {
    // No player exists in this probe. Actual playing-client colliders remain pinned.
    stream.setPreview(distant, 125);
    stream.pump();
    clockOffset += 5001;
    const deadline = performance.now() + 15000;
    while (stream.diagnostics().cells.length && performance.now() < deadline) {
      stream.pump();
      await frame();
    }
    check(stream.diagnostics().cells.length === 0, 'Terrain resources did not release');
    for (let i = 0; i < 3; i++) await frame();
  }
  await connected();
  await disconnected();
  await connected();
  await disconnected();
  const empty = counts(),
    cycles = [];
  for (let i = 0; i < 20; i++) {
    await connected();
    const active = counts();
    await disconnected();
    const released = counts();
    check(
      JSON.stringify(released) === JSON.stringify(empty),
      'Terrain release accumulated resources',
    );
    if (cycles.length)
      check(
        JSON.stringify(active) === JSON.stringify(cycles[0].active),
        'Terrain reconnect accumulated resources',
      );
    cycles.push({ active, released });
  }
  await connected();
  const lines = [1.5, 3, 4.5].map((h, i) => {
    const mesh = MeshBuilder.CreateLineSystem(
      `contour-${h}`,
      {
        lines: terrainContours(grid, h).map((segment) =>
          segment.map(([x, z]) => new Vector3(x, h + 0.045, z)),
        ),
      },
      view.scene,
    );
    mesh.color = [new Color3(1, 0.8, 0.2), new Color3(1, 0.35, 0.1), new Color3(0.3, 0.9, 1)][i];
    mesh.setEnabled(false);
    return mesh;
  });
  const camera = view.scene.activeCamera as ArcRotateCamera;
  const capture = async (name: string) => {
    const config: Record<
      string,
      { x: number; y: number; z: number; beta: number; alpha: number; zoom: number }
    > = {
      general: { x: 0, y: 3, z: 0, beta: Math.PI / 3.15, alpha: -Math.PI / 4, zoom: 1.7 },
      top: { x: 0, y: 3, z: 0, beta: 0.01, alpha: -Math.PI / 2, zoom: 1.5 },
      side: { x: 0, y: 3, z: 0, beta: 1.47, alpha: Math.PI / 2, zoom: 1.5 },
      'foundation-high': { x: 1, y: 4.2, z: -7, beta: 1.15, alpha: -Math.PI / 4, zoom: 0.55 },
      'foundation-low': { x: 1, y: 4.2, z: -7, beta: 1.22, alpha: Math.PI * 0.75, zoom: 0.55 },
      'coverage-seam': { x: 0, y: 2, z: 1, beta: 0.8, alpha: -Math.PI / 4, zoom: 0.5 },
    };
    const c = config[name];
    check(c, `Unknown view ${name}`);
    lines.forEach((m) => m.setEnabled(name === 'top'));
    if (world.characters.has('camera')) world.removeCharacter('camera');
    world.createCharacter('camera', {
      x: c.x,
      y: c.y + header.simulation.character.height / 2,
      z: c.z,
    });
    view.follow('camera');
    view.update(
      [{ ...world.state('camera'), skinId: 'standard', motionRevision: 0, motionEnabled: false }],
      'camera',
      1 / 60,
    );
    view.update([], undefined, 1 / 60);
    view.rotateCameraBy(c.alpha - view.cameraAngle);
    camera.beta = c.beta;
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: Math.log(c.zoom / view.cameraZoom) / 0.001,
        cancelable: true,
      }),
    );
    const deadline = performance.now() + 10000;
    do {
      await frame();
    } while (
      performance.now() < deadline &&
      (Math.hypot(camera.target.x - c.x, camera.target.y - c.y, camera.target.z - c.z) > 0.005 ||
        view.renderingDiagnostics().camera.turning)
    );
  };
  return {
    cycles,
    empty,
    capture,
    diagnostics: () => ({
      streaming: stream.diagnostics(),
      rendering: view.renderingDiagnostics(),
    }),
    dispose() {
      lines.forEach((m) => m.dispose());
      stream.dispose();
      world.dispose();
      view.dispose();
    },
  };
}
