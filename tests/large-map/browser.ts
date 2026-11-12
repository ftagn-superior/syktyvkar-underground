import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector';
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { WorldView } from '../../apps/client/src/rendering/world-view';
import { BuildingViews } from '../../apps/client/src/rendering/buildings';
import { createPhysicsWorld } from '../../packages/simulation/src/physics-world.js';
import {
  validateBuildingParts,
  validateBuildingPhysicsAsset,
  type WorldDefinition,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import { runStaticLifecycleProbe } from './physics.js';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const pauseFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBrowserProbe() {
  const wasm = await (await fetch('/large-map-wasm')).arrayBuffer();
  const physics = await runStaticLifecycleProbe(wasm);
  const physicsMesh = await runStaticLifecycleProbe(wasm, 'arch');
  const data: {
    manifest: WorldManifest;
    profiles: { name: string; definition: WorldDefinition }[];
  } = await (await fetch('/large-map-data')).json();
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100vw;height:100vh';
  document.body.style.cssText = 'margin:0;overflow:hidden';
  document.body.append(canvas);
  const labels = document.createElement('div');
  document.body.append(labels);
  const profiles = [];
  const longTasks: { startTime: number; duration: number }[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longTasks.push({ startTime: entry.startTime, duration: entry.duration });
  });
  observer.observe({ type: 'longtask', buffered: true });
  try {
    for (const profile of data.profiles) {
      const serialized = JSON.stringify(profile.definition);
      const parseStart = performance.now();
      const definition = JSON.parse(serialized) as WorldDefinition;
      const jsonParseMs = performance.now() - parseStart;
      const floor = definition.entities.filter((entity) => entity.kind === 'obstacle');
      const localBounds = {
        min: {
          x: Math.min(...floor.map((tile) => tile.position.x - tile.size.x / 2)),
          y: -5,
          z: Math.min(...floor.map((tile) => tile.position.z - tile.size.z / 2)),
        },
        max: {
          x: Math.max(...floor.map((tile) => tile.position.x + tile.size.x / 2)),
          y: 15,
          z: Math.max(...floor.map((tile) => tile.position.z + tile.size.z / 2)),
        },
      };
      const view = new WorldView(canvas, labels, {
        ...definition,
        bounds: localBounds,
        buildings: [],
      });
      const camera = view.scene.activeCamera as ArcRotateCamera;
      const shadow = view.scene
        .getLightByName('sun')!
        .getShadowGenerator() as ConstructorParameters<typeof BuildingViews>[1];
      const position = new Vector3(definition.spawnPoints[0].x, 0.92, definition.spawnPoints[0].z);
      view.follow('probe');
      view.update(
        [
          {
            entityId: 'probe',
            kind: 'player',
            revision: 0,
            position: { x: position.x, y: position.y, z: position.z },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            velocity: { x: 0, y: 0, z: 0 },
            angularVelocity: { x: 0, y: 0, z: 0 },
          },
        ],
        'probe',
      );
      camera.setTarget(new Vector3(position.x, 0, position.z), false, false, true);
      const resources = () => ({
        meshes: view.scene.meshes.length,
        materials: view.scene.materials.length,
        geometries: view.scene.geometries.length,
        nodes: view.scene.transformNodes.length,
        textures: view.scene.textures.length,
        shadowCasters: shadow.getShadowMap()!.renderList!.length,
      });
      const baseline = resources();
      const cycles = [];
      const frameSamples: { phase: string; deltaMs: number }[] = [];
      let phase = 'idle';
      let active: BuildingViews | undefined;
      view.onFrame((_now, delta) => {
        frameSamples.push({ phase, deltaMs: delta * 1000 });
        active?.update(
          position,
          camera.globalPosition,
          camera.target.subtract(camera.globalPosition).normalize(),
          camera.minZ,
          performance.now(),
          delta,
        );
      });
      try {
        for (let cycle = 0; cycle < 3; cycle++) {
          await pauseFrame();
          phase = 'attach';
          const reads: string[] = [];
          const buildings = (active = new BuildingViews(view.scene, shadow, definition));
          const start = performance.now();
          await buildings.prepare(data.manifest, async (file) => {
            reads.push(file);
            const response = await fetch(`/large-map-assets/${file}`);
            check(response.ok, `resource HTTP ${response.status}: ${file}`);
            return new Uint8Array(await response.arrayBuffer());
          });
          const attachMs = performance.now() - start;
          const physicsStart = performance.now();
          const localPhysics = await createPhysicsWorld(definition, wasm, true);
          const physicsCreateMs = performance.now() - physicsStart;
          const physicsBodies = localPhysics.physics.getBodies().length;
          const physicsDisposeStart = performance.now();
          localPhysics.dispose();
          const physicsDisposeMs = performance.now() - physicsDisposeStart;
          const loaded = resources();
          check(
            buildings.aggregateDiagnostics().instances === definition.buildings.length,
            'placed instance count',
          );
          check(
            reads.every(
              (path) =>
                !path.includes(data.manifest.assets['house-remote-a'].version) &&
                !path.includes(data.manifest.assets['house-remote-b'].version),
            ),
            'remote model loaded',
          );
          phase = 'steady';
          await delay(1200);
          phase = 'release';
          const releaseStart = performance.now();
          buildings.dispose();
          active = undefined;
          const releaseMs = performance.now() - releaseStart;
          await pauseFrame();
          const released = resources();
          for (const key of [
            'meshes',
            'materials',
            'geometries',
            'nodes',
            'shadowCasters',
          ] as const)
            check(
              released[key] === baseline[key],
              `${profile.name}: retained ${key}: ${released[key]} vs ${baseline[key]}`,
            );
          cycles.push({
            cycle,
            attachMs,
            releaseMs,
            physicsCreateMs,
            physicsDisposeMs,
            physicsBodies,
            reads,
            loaded,
            released,
          });
        }
        const modelParses = [];
        for (const assetId of new Set(definition.buildings.map((building) => building.assetId))) {
          const descriptor = data.manifest.assets[assetId];
          const [model, parts, collision] = await Promise.all(
            [descriptor.modelFile, descriptor.partsFile, descriptor.collisionFile].map(
              async (file) => {
                const response = await fetch(`/large-map-assets/${file}`);
                check(response.ok, `model parse resource: ${file}`);
                return new Uint8Array(await response.arrayBuffer());
              },
            ),
          );
          const partsStart = performance.now();
          validateBuildingParts(JSON.parse(new TextDecoder().decode(parts)));
          const partsParseMs = performance.now() - partsStart;
          const collisionStart = performance.now();
          validateBuildingPhysicsAsset(JSON.parse(new TextDecoder().decode(collision)));
          const collisionParseMs = performance.now() - collisionStart;
          const modelStart = performance.now();
          const container = await LoadAssetContainerAsync(model, view.scene, {
            pluginExtension: '.glb',
          });
          const glbParseMs = performance.now() - modelStart;
          const meshes = container.meshes.length;
          const materials = container.materials.length;
          const disposeStart = performance.now();
          container.dispose();
          modelParses.push({
            assetId,
            bytes: model.length,
            partsParseMs,
            collisionParseMs,
            glbParseMs,
            meshes,
            materials,
            disposeMs: performance.now() - disposeStart,
          });
        }
        const coverage = [];
        // Check the real camera projection at rotations and viewport extremes, near a cell corner.
        if (profile.name === 'dense') {
          for (const [width, height] of [
            [1920, 1080],
            [800, 1200],
            [3440, 1440],
          ]) {
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            window.dispatchEvent(new Event('resize'));
            for (const angle of Array.from({ length: 8 }, (_, step) => (step * Math.PI) / 4)) {
              camera.alpha = angle;
              camera.setTarget(new Vector3(124.9, 0, 124.9), false, false, true);
              camera.getViewMatrix(true);
              camera.getProjectionMatrix(true);
              const points = [];
              for (const x of [0, view.engine.getRenderWidth()])
                for (const y of [0, view.engine.getRenderHeight()]) {
                  const ray = view.scene.createPickingRay(x, y, Matrix.Identity(), camera);
                  for (const elevation of [0, 7.5]) {
                    const distance = (elevation - ray.origin.y) / ray.direction.y;
                    const hit = ray.origin.add(ray.direction.scale(distance));
                    check(
                      hit.x >= -125 && hit.x <= 250 && hit.z >= -125 && hit.z <= 250,
                      `camera exceeds prepared 3x3: ${width}x${height}, angle ${angle}, hit ${hit.x},${hit.z}, radius ${camera.radius}`,
                    );
                    check(
                      Math.hypot(hit.x - 124.9, hit.z - 124.9) <= 80,
                      'camera exceeds initial AOI entry radius',
                    );
                    points.push({ x: hit.x, z: hit.z });
                  }
                }
              coverage.push({ width, height, angle, points });
            }
          }
          canvas.style.width = '100vw';
          canvas.style.height = '100vh';
        }
        const steady = frameSamples
          .filter((sample) => sample.phase === 'steady')
          .map((sample) => sample.deltaMs)
          .sort((a, b) => a - b);
        check(steady.length >= 3, 'insufficient browser frames');
        profiles.push({
          name: profile.name,
          placements: definition.buildings.length,
          jsonBytes: serialized.length,
          jsonParseMs,
          baseline,
          cycles,
          frameSamples,
          coverage,
          modelParses,
          rendering: view.renderingDiagnostics(),
          frameP95Ms: steady[Math.floor(steady.length * 0.95)],
          maxFrameMs: Math.max(...frameSamples.map((sample) => sample.deltaMs)),
        });
      } finally {
        active?.dispose();
        view.dispose();
        await pauseFrame();
      }
    }
    return {
      result: 'passed',
      physics,
      physicsMesh,
      profiles,
      longTasks,
      hidden: document.hidden,
      memory: (
        performance as Performance & {
          memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
        }
      ).memory
        ? {
            usedJSHeapSize: (performance as any).memory.usedJSHeapSize,
            totalJSHeapSize: (performance as any).memory.totalJSHeapSize,
          }
        : null,
    };
  } finally {
    observer.disconnect();
    canvas.remove();
    labels.remove();
  }
}
