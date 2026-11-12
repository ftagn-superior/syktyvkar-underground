import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import {
  loadWorldHeader,
  type Vec3,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import { createPhysicsWorld } from '../../packages/simulation/src/physics-world.js';
import { WorldView } from '../../apps/client/src/rendering/world-view';
import { CellStreamer } from '../../apps/client/src/streaming/cells';
import { VerifiedResources } from '../../apps/client/src/streaming/resources';
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
let disposeGraphics: (() => void) | undefined;
export function disposeProbe() {
  disposeGraphics?.();
}

export async function runStreamingProbe() {
  const manifest: WorldManifest = await (await fetch('/l2-manifest')).json();
  const requests: { path: string; cache?: RequestCache }[] = [];
  let corruptOnce = true;
  let failRemote = true;
  let delayCells = false;
  const resources = new VerifiedResources(manifest, '/l2-assets/', {
    fetch: async (url, options) => {
      const path = String(url).slice('/l2-assets/'.length);
      requests.push({ path, cache: options?.cache });
      if (delayCells && path.startsWith('cells/')) {
        await delay(250);
        return fetch(url, { ...options, signal: undefined });
      }
      if (path === manifest.assets['house-a'].modelFile && corruptOnce) {
        corruptOnce = false;
        return new Response(new Uint8Array([0]));
      }
      if (path === manifest.assets['house-remote-a'].modelFile && failRemote)
        return new Response('', { status: 503 });
      return fetch(url, options);
    },
  });
  const header = await loadWorldHeader(manifest, (path) => resources.read(path));
  const wasm = await (await fetch('/l2-wasm')).arrayBuffer();
  const world = await createPhysicsWorld(header, wasm, true);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100vw;height:100vh';
  document.body.style.cssText = 'margin:0;overflow:hidden';
  document.body.append(canvas);
  const labels = document.createElement('div');
  document.body.append(labels);
  const view = new WorldView(canvas, labels, header);
  disposeGraphics = () => view.dispose();
  let clockOffset = 0;
  const stream = new CellStreamer(
    manifest,
    resources,
    world,
    view,
    () => performance.now() + clockOffset,
  );
  const frames: number[] = [];
  const longTasks: { start: number; duration: number }[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longTasks.push({ start: entry.startTime, duration: entry.duration });
  });
  observer.observe({ type: 'longtask', buffered: true });
  view.onFrame((_now, delta) => frames.push(delta * 1000));
  const counts = () => ({
    meshes: view.scene.meshes.length,
    materials: view.scene.materials.length,
    geometries: view.scene.geometries.length,
    nodes: view.scene.transformNodes.length,
    textures: view.scene.textures.length,
    shadows: view.scene.getLightByName('sun')!.getShadowGenerator()!.getShadowMap()!.renderList!
      .length,
    physics: world.staticDiagnostics(),
  });
  async function waitReady() {
    const deadline = performance.now() + 15000;
    while (!stream.ready && performance.now() < deadline) {
      stream.pump();
      await frame();
    }
    check(stream.ready, `Area preparation failed: ${JSON.stringify(stream.diagnostics())}`);
  }
  async function drain() {
    clockOffset += 5001;
    for (let i = 0; i < 1000; i++) {
      stream.pump();
      if (!stream.diagnostics().cells.some((cell) => cell.state === 'releasing' || cell.releaseAt))
        return;
      await frame();
    }
    throw new Error('Release did not finish');
  }
  function display() {
    view.follow('self');
    view.update([world.state('self')], 'self');
  }
  async function relocate(position: Vec3) {
    stream.setArea(position);
    await waitReady();
    world.restoreCharacter({ ...world.state('self'), position, velocity: { x: 0, y: 0, z: 0 } });
    display();
    const camera = view.scene.activeCamera as ArcRotateCamera;
    camera.setTarget(new Vector3(position.x, 0, position.z), false, false, true);
  }
  async function walk(target: Vec3, steps: number, blocked = false) {
    const controller = world.characters.get('self')!.controller;
    for (let step = 0; step < steps; step++) {
      const state = world.state('self');
      stream.setArea(state.position);
      stream.pump();
      if (!stream.ready) await waitReady();
      const dx = target.x - state.position.x,
        dz = target.z - state.position.z;
      const distance = Math.hypot(dx, dz);
      world.characters.get('self')!.input = {
        moveX: distance > 0.06 ? dx / distance : 0,
        moveZ: distance > 0.06 ? dz / distance : 0,
      };
      world.advance(1 / 60);
      check(world.state('self').position.y > 0.8, 'Character fell through cell seam');
      if (step % 60 === 0) {
        display();
        await frame();
      }
    }
    display();
    check(
      world.characters.get('self')!.controller === controller,
      'Cell switch recreated controller',
    );
    const end = world.state('self').position;
    const distance = Math.hypot(end.x - target.x, end.z - target.z);
    check(
      blocked ? distance > 1 : distance < 0.15,
      `Unexpected route endpoint: ${JSON.stringify({ end, target })}`,
    );
    return { end, distance, sameController: true };
  }
  try {
    world.createCharacter('self', { x: -5, y: 0.92, z: 4 });
    stream.setArea(world.state('self').position);
    await waitReady();
    display();
    const initial = {
      diagnostics: stream.diagnostics(),
      requests: requests.slice(),
      resources: counts(),
    };
    check(initial.diagnostics.required.length === 9, 'Cold start is not a neighborhood');
    check(
      !requests.some(({ path }) =>
        ['house-remote-a', 'house-remote-b'].some((id) =>
          Object.values(manifest.assets[id]).includes(path),
        ),
      ),
      'Remote dependencies downloaded on cold start',
    );
    check(resources.diagnostics().integrityRetries === 1, 'Corrupt resource did not recover');
    const side = await walk({ x: 130, y: 0.92, z: 4 }, 2100);
    await relocate({ x: -3, y: 0.92, z: -3 });
    const corner = await walk({ x: 3, y: 0.92, z: 3 }, 200);
    await relocate({ x: -135, y: 0.92, z: -312.5 });
    await drain();
    check(
      view.buildingDiagnostics().buildings.filter((item) => item.entityId === 'house-6-5-0')
        .length === 1,
      'Boundary house duplicated',
    );
    const boundaryHouse = await walk({ x: -115, y: 0.92, z: -312.5 }, 400, true);
    await relocate({ x: -260, y: 0.92, z: -260 });
    await drain();
    check(
      view.buildingDiagnostics().buildings.filter((item) => item.entityId === 'house-5-5-0')
        .length === 1,
      'Corner house duplicated',
    );
    const cornerHouse = await walk({ x: -240, y: 0.92, z: -240 }, 500, true);
    // Keep history colliders after moving to a distant area, then release the final reference.
    const held = { x: -125, y: 0.92, z: -312.5 };
    stream.setArea({ x: 500, y: 0, z: 500 }, undefined, ['6_5']);
    await waitReady();
    await drain();
    check(
      view.buildingDiagnostics().buildings.some((item) => item.entityId === 'house-6-5-0'),
      'History collider was released',
    );
    stream.setArea({ x: 500, y: 0, z: 500 });
    await drain();
    check(
      !view.buildingDiagnostics().buildings.some((item) => item.entityId === 'house-6-5-0'),
      'History reference leaked',
    );
    await relocate(held);
    await drain();
    const cycles: ReturnType<typeof counts>[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await relocate({ x: 500, y: 0.92, z: 500 });
      await drain();
      await relocate(held);
      await drain();
      for (let turn = 0; turn < 4; turn++) {
        view.rotateCamera(1);
        for (let i = 0; i < 12; i++) await frame();
      }
      cycles.push(counts());
    }
    check(
      cycles.every((value) => JSON.stringify(value) === JSON.stringify(cycles[0])),
      'Repeated route accumulated native/GPU resources',
    );
    // An explicit retry follows a failed unique remote model request.
    stream.setArea({ x: 950, y: 0, z: 950 });
    for (
      let i = 0;
      i < 300 && !stream.diagnostics().cells.some((cell) => cell.state === 'error');
      i++
    ) {
      stream.pump();
      await frame();
    }
    check(
      stream.diagnostics().cells.some((cell) => cell.state === 'error'),
      'HTTP error was not surfaced',
    );
    failRemote = false;
    stream.retry();
    await waitReady();
    await drain();
    // A response that ignores abort must not activate an obsolete target or a disposed session.
    delayCells = true;
    stream.setArea({ x: -950, y: 0, z: 950 });
    await delay(30);
    stream.setArea(held);
    await waitReady();
    await delay(500);
    await drain();
    check(
      stream.diagnostics().cells.every((cell) => stream.diagnostics().required.includes(cell.id)),
      'Late response activated an old target',
    );
    const self = world.state('self');
    for (let cycle = 0; cycle < 3; cycle++) {
      world.setRemoteSnapshot(
        {
          players: [self, { ...self, entityId: 'remote' }],
          crate: { ...self, kind: 'crate', entityId: header.crate.entityId },
        },
        'self',
      );
      world.setRemoteSnapshot({ players: [self] }, 'self');
      world.advance(1 / 60);
    }
    check(
      !world.staticDiagnostics().crate && world.staticDiagnostics().remotePlayers === 0,
      'Proxy lifecycle leaked',
    );
    const diagnostics = stream.diagnostics();
    const rendering = view.renderingDiagnostics();
    stream.setArea({ x: -950, y: 0, z: 950 });
    await delay(20);
    stream.dispose();
    await delay(500);
    check(
      world.staticDiagnostics().entities === 0 && view.buildingDiagnostics().buildings.length === 0,
      'Disposed stream kept static resources',
    );
    check(resources.diagnostics().cacheBytes === 0, 'Disposed byte cache leaked');
    const cleanup = counts();
    world.dispose();
    observer.disconnect();
    return {
      status: 'passed',
      initial,
      side,
      corner,
      boundaryHouse,
      cornerHouse,
      cycles,
      diagnostics,
      rendering,
      cleanup,
      frames,
      longTasks,
      http: requests,
      hidden: document.hidden,
      limits: { plannedFrameMs: 2, graceMs: 5000, cacheBytes: 64 * 1024 * 1024 },
    };
  } catch (error) {
    stream.dispose();
    world.dispose();
    view.dispose();
    observer.disconnect();
    throw error;
  }
}
