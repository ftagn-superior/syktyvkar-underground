import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import {
  loadWorldHeader,
  type Vec3,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import { createPhysicsWorld } from '../../packages/simulation/src/physics-world.js';
import { WorldView } from '../../apps/client/src/rendering/world-view.js';
import { CellStreamer } from '../../apps/client/src/streaming/cells.js';
import { VerifiedResources } from '../../apps/client/src/streaming/resources.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function distribution(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

export async function createExtractionProbe(
  options: { cancelLate?: 'glb' | 'pack' | 'collision' } = {},
) {
  const manifest: WorldManifest = await (await fetch('/extraction-manifest')).json();
  // Keep the legacy individual-model cancellation path explicit alongside packs.
  if (options.cancelLate === 'glb')
    manifest.cells = manifest.cells.map(({ graphicsPacks: _packs, ...cell }) => cell);
  if (options.cancelLate === 'pack')
    check(
      manifest.cells.some((cell) => cell.graphicsPacks?.length),
      'Fixture has no graphics packs',
    );
  let signalLateStart!: () => void;
  let signalLateFinish!: () => void;
  const lateStarted = new Promise<void>((resolve) => {
    signalLateStart = resolve;
  });
  const lateFinished = new Promise<void>((resolve) => {
    signalLateFinish = resolve;
  });
  let delayedOnce = false;
  const resources = new VerifiedResources(manifest, '/extraction-assets/', {
    fetch: async (url, init) => {
      const suffix =
        options.cancelLate === 'pack'
          ? '.pack'
          : options.cancelLate === 'glb'
            ? '/model.glb'
            : '/colliders.json';
      if (options.cancelLate && !delayedOnce && String(url).endsWith(suffix)) {
        delayedOnce = true;
        signalLateStart();
        // Deliberately ignore abort: the consumer must reject this late successful response.
        const response = await fetch(url, { ...init, signal: undefined });
        await delay(1000);
        signalLateFinish();
        return response;
      }
      return fetch(url, init);
    },
  });
  const header = await loadWorldHeader(manifest, (path) => resources.read(path));
  const wasm = await (await fetch('/extraction-wasm')).arrayBuffer();
  const world = await createPhysicsWorld(header, wasm, true);
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#101820';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100vw;height:100vh';
  document.body.append(canvas);
  const labels = document.createElement('div');
  document.body.append(labels);
  const view = new WorldView(canvas, labels, header, 'economy');
  const stream = new CellStreamer(manifest, resources, world, view);
  const camera = view.scene.activeCamera as ArcRotateCamera;
  // Test-only camera control keeps screenshots free of artificial player/avatar meshes.
  const target = (view as unknown as { target: Vector3 }).target;
  let center: Vec3 = { ...header.spawnPoints[0], y: 0 };
  let playing = false;
  const frames: number[] = [];
  const drawCalls: number[] = [];
  let collecting = false;
  view.onFrame((_now, delta) => {
    const area = view.graphicalArea();
    stream.setVisualArea(area.center, area.drawRadius);
    stream.pump();
    view.setStreamingRadius(stream.graphicsReadyRadius(area.center, area.drawRadius));
    if (collecting) {
      frames.push(delta * 1000);
      drawCalls.push(view.renderingDiagnostics().drawCalls);
    }
  });
  const snapshot = () => ({
    streaming: stream.diagnostics(),
    resources: resources.diagnostics(),
    rendering: view.renderingDiagnostics(),
    physics: world.staticDiagnostics(),
    hidden: document.hidden,
  });
  async function ready(critical = false) {
    const started = performance.now();
    while (!(critical ? stream.criticalReady : stream.backgroundReady)) {
      if (stream.backgroundProblem) throw new Error(stream.backgroundProblem);
      if (performance.now() - started > 120_000)
        throw new Error('Preparation deadline: ' + JSON.stringify(snapshot()));
      await frame();
    }
    return performance.now() - started;
  }
  async function focus(position: { x: number; z: number }) {
    center = { ...position, y: 0 };
    target.set(center.x, 0, center.z);
    camera.setTarget(target, false, false, true);
    if (playing) stream.setArea(center);
    else stream.setPreview(center, view.graphicalArea().drawRadius);
    const ms = await ready();
    await delay(1500);
    return { ms, ...snapshot() };
  }
  async function sample(warmupMs = 1500, sampleMs = 2000) {
    await delay(warmupMs);
    frames.length = drawCalls.length = 0;
    collecting = true;
    await delay(sampleMs);
    collecting = false;
    return { ...snapshot(), frameMs: distribution(frames), drawCalls: distribution(drawCalls) };
  }
  if (options.cancelLate) {
    target.set(center.x, 0, center.z);
    camera.setTarget(target, false, false, true);
    if (options.cancelLate === 'collision') stream.setArea(center);
    else stream.setPreview(center, view.graphicalArea().drawRadius);
    await Promise.race([
      lateStarted,
      delay(15000).then(() => {
        throw new Error('Late request did not start');
      }),
    ]);
    stream.dispose();
    await Promise.race([
      lateFinished,
      delay(15000).then(() => {
        throw new Error('Late response did not finish');
      }),
    ]);
    await delay(500);
    const cleanup = snapshot();
    check(cleanup.physics.entities === 0, 'Late response activated disposed physics');
    check(
      view.buildingDiagnostics().buildings.length === 0,
      'Late response activated disposed graphics',
    );
    check(resources.diagnostics().cacheBytes === 0, 'Late response repopulated disposed cache');
    world.dispose();
    view.dispose();
    return { status: 'passed', delayedResource: options.cancelLate, delayedOnce, cleanup };
  }
  await focus(center);
  return {
    snapshot,
    focus,
    sample,
    async enter() {
      playing = true;
      stream.setArea(center);
      const criticalMs = await ready(true);
      await ready();
      return { criticalMs, ...snapshot() };
    },
    async leave() {
      playing = false;
      stream.setPreview(center, view.graphicalArea().drawRadius);
      await delay(5500);
      await ready();
      check(world.staticDiagnostics().bodies === 0, 'Preview retains physics bodies');
      return snapshot();
    },
    async zoomWide(measure = false) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 10000, cancelable: true }));
      const views = [];
      for (let turn = 0; turn < 4; turn++) {
        view.rotateCameraBy(Math.PI / 2);
        while (view.renderingDiagnostics().camera.turning) await frame();
        await ready();
        await delay(500);
        views.push(measure ? await sample() : snapshot());
      }
      check(view.cameraZoom === 30, 'Camera did not reach 30x');
      return views;
    },
    async zoomClose() {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -10000, cancelable: true }));
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: Math.log(1 / view.cameraZoom) * 1000, cancelable: true }),
      );
      await delay(5500);
      await ready();
      return snapshot();
    },
    async dispose() {
      stream.dispose();
      await delay(500);
      const cleanup = snapshot();
      check(cleanup.physics.entities === 0, 'Disposed stream retains physics statics');
      check(view.buildingDiagnostics().buildings.length === 0, 'Disposed stream retains graphics');
      check(resources.diagnostics().cacheBytes === 0, 'Disposed stream retains cached bytes');
      world.dispose();
      view.dispose();
      return cleanup;
    },
  };
}
