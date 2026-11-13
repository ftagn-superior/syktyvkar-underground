import {
  loadWorldHeader,
  worldCellAt,
  worldNeighborhood,
  type Vec3,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import { createPhysicsWorld } from '../../packages/simulation/src/physics-world.js';
import { WorldView } from '../../apps/client/src/rendering/world-view.js';
import { CellStreamer } from '../../apps/client/src/streaming/cells.js';
import { VerifiedResources } from '../../apps/client/src/streaming/resources.js';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

/** Real city resources; controlled lifecycle clock, no live game or saved-player mutation. */
export async function createCityBrowserProbe() {
  const manifest: WorldManifest = await (await fetch('/city-manifest')).json();
  const resources = new VerifiedResources(manifest, '/city-assets/');
  const header = await loadWorldHeader(manifest, (path) => resources.read(path));
  const world = await createPhysicsWorld(
    header,
    await (await fetch('/city-wasm')).arrayBuffer(),
    true,
  );
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
  const center = { ...header.spawnPoints[0] };
  const distant = { x: header.bounds.max.x + 2000, y: 0, z: header.bounds.max.z + 2000 };
  view.onFrame(() => {
    stream.pump();
    view.setStreamingRadius(250);
  });
  const counts = () => ({
    meshes: view.scene.meshes.length,
    materials: view.scene.materials.length,
    geometries: view.scene.geometries.length,
    nodes: view.scene.transformNodes.length,
    textures: view.scene.textures.length,
    assets: view.buildingDiagnostics().assets.length,
    physics: world.staticDiagnostics(),
  });
  async function until(ready: () => boolean, message: string) {
    const began = performance.now();
    while (!ready()) {
      if (stream.problem || stream.backgroundProblem)
        throw new Error(stream.problem ?? stream.backgroundProblem);
      if (performance.now() - began > 120000) throw new Error(message);
      stream.pump();
      await frame();
    }
    for (let i = 0; i < 5; i++) await frame();
  }
  async function connect() {
    stream.setArea(center);
    stream.setVisualArea(center, 250);
    await until(
      () => stream.criticalReady && stream.backgroundReady,
      'City resources did not connect',
    );
  }
  async function release() {
    stream.setPreview(distant, 125);
    stream.pump();
    clockOffset += 5001;
    await until(() => stream.diagnostics().cells.length === 0, 'City resources did not release');
  }
  const cycles: unknown[] = [];
  let empty: ReturnType<typeof counts> | undefined;
  return {
    async warmup() {
      for (let i = 0; i < 2; i++) {
        await connect();
        await release();
      }
      empty = counts();
      return empty;
    },
    async cycle(index: number) {
      check(empty, 'Lifecycle warmup is required');
      await connect();
      const active = counts();
      await release();
      const released = counts();
      check(
        JSON.stringify(released) === JSON.stringify(empty),
        `Cycle ${index}: resources accumulated after release`,
      );
      if (cycles.length)
        check(
          JSON.stringify(active) === JSON.stringify((cycles[0] as { active: unknown }).active),
          `Cycle ${index}: resources accumulated after reconnect`,
        );
      const result = { index, active, released, cache: resources.diagnostics() };
      cycles.push(result);
      return result;
    },
    async pins() {
      await connect();
      const spawn = world.findSpawn(undefined, center);
      check(spawn, 'Actual city spawn must support the pin-test capsule');
      world.createCharacter('pin-test', spawn!);
      const neighborhood = worldNeighborhood(manifest.bounds, manifest.grid, center);
      const history = manifest.cells.find((c) => !neighborhood.includes(c.cellId));
      check(history, 'City probe needs a history cell outside the player neighborhood');
      stream.setArea(center, center, [history!.cellId]);
      stream.setVisualArea(distant, 125);
      clockOffset += 5001;
      await until(
        () => stream.criticalReady && stream.backgroundReady,
        'History pins did not connect',
      );
      const before = stream.diagnostics();
      const underfoot = worldCellAt(manifest.bounds, manifest.grid, center)!;
      const position = world.state('pin-test').position;
      let maximumDrift = 0;
      for (let i = 0; i < 180; i++) {
        stream.pump();
        world.advance(1 / 60);
        const now: Vec3 = world.state('pin-test').position;
        maximumDrift = Math.max(
          maximumDrift,
          Math.hypot(now.x - position.x, now.y - position.y, now.z - position.z),
        );
        const state = stream.diagnostics();
        check(
          state.physicsActive.includes(underfoot),
          'Physics unloaded beneath the pin-test capsule',
        );
        check(
          state.historyRequired.includes(history!.cellId) &&
            state.physicsActive.includes(history!.cellId),
          'Prediction-history cell unloaded while required',
        );
        await frame();
      }
      check(maximumDrift < 0.15, `Pin-test capsule fell/drifted ${maximumDrift}m`);
      const result = {
        underfoot,
        historyCell: history!.cellId,
        historyOutsidePlayerNeighborhood: !neighborhood.includes(history!.cellId),
        frames: 180,
        maximumDrift,
        before,
        after: stream.diagnostics(),
      };
      world.removeCharacter('pin-test');
      await release();
      check(
        JSON.stringify(counts()) === JSON.stringify(empty),
        'Pin-test resources did not return to the warmed empty state',
      );
      return result;
    },
    dispose() {
      stream.dispose();
      world.dispose();
      view.dispose();
    },
  };
}
