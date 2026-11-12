import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import {
  loadWorldBundle,
  loadWorldCell,
  type BuildingInstance,
  type WorldDefinition,
  type WorldManifest,
} from '../../packages/contracts/src/index.js';
import { buildWorld } from '../../tools/world-build/src/index.js';
import type { KitRecipe } from '../../tools/world-build/src/kit.js';
import { createPhysicsWorld } from '../../packages/simulation/src/physics-world.js';
import { createPredictionWorld } from '../../packages/simulation/src/prediction.js';
import { loadServerWasm } from '../../packages/simulation/src/server.js';
import { BuildingViews } from '../../apps/client/src/rendering/buildings.js';
import { CellStreamer } from '../../apps/client/src/streaming/cells.js';
import { VerifiedResources } from '../../apps/client/src/streaming/resources.js';
import { predictionCells } from '../../apps/client/src/streaming/prediction-area.js';

const identity = { x: 0, y: 0, z: 0, w: 1 };
const quarterTurn = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
const signal: KitRecipe = {
  formatVersion: 1,
  merge: true,
  parts: [
    {
      id: 'support',
      role: 'detail',
      fade: true,
      color: '#444444',
      shapes: [
        { box: { center: [0, 1.5, 0], size: [0.2, 3, 0.2] } },
        { box: { center: [0.5, 2.7, 0], size: [1, 0.1, 0.1] } },
        { box: { center: [1, 2.8, 0], size: [0.45, 0.9, 0.25] } },
      ],
    },
    ...['#ff0000', '#ffff00', '#00ff00'].map((color, i) => ({
      id: `light-${i}`,
      role: 'detail' as const,
      fade: true,
      color,
      shapes: [
        {
          cylinder: {
            center: [1, 3.05 - i * 0.25, 0.14] as [number, number, number],
            radius: 0.08,
            length: 0.04,
            axis: 'z' as const,
          },
        },
      ],
    })),
  ],
  colliders: [
    { id: 'pole', center: [0, 1.5, 0], size: [0.2, 3, 0.2] },
    { id: 'housing', center: [1, 2.8, 0], size: [0.45, 0.9, 0.25] },
  ],
};
const fence: KitRecipe = {
  formatVersion: 1,
  merge: true,
  parts: [
    {
      id: 'span',
      role: 'detail',
      fade: true,
      color: '#778877',
      shapes: [{ box: { center: [0, 1, 0], size: [6, 2, 0.2] } }],
    },
  ],
  colliders: [{ id: 'span', center: [0, 1, 0], size: [6, 2, 0.2] }],
};
const instance = (entityId: string, assetId: string, x: number, z: number): BuildingInstance => ({
  entityId,
  assetId,
  position: { x, y: 0, z },
  rotation: identity,
});
const original = [
  instance('signal-first', 'signal', -0.05, -0.05),
  instance('signal-second', 'signal', 900, 900),
  instance('fence-first', 'fence', -5, 20),
  instance('fence-second', 'fence', 5, 20),
];
const moved = original.map((item) =>
  item.entityId.endsWith('first')
    ? {
        ...item,
        position: item.assetId === 'signal' ? { x: 130, y: 0, z: 130 } : { x: 130, y: 0, z: 20 },
        rotation: quarterTurn,
      }
    : item,
);
type Release = { directory: string; manifest: WorldManifest; definition: WorldDefinition };
let directory: string;
let before: Release;
let after: Release;
const read = (release: Release, path: string) => readFile(join(release.directory, path));
async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value));
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-independent-objects-'));
  const source = JSON.parse(await readFile('content/worlds/physics-lab/world.json', 'utf8'));
  source.worldId = 'independent-objects';
  source.bounds = { min: { x: -1000, y: -5, z: -1000 }, max: { x: 1000, y: 30, z: 1000 } };
  source.initialItems = [];
  source.entities = [-500, 500].flatMap((x) =>
    [-500, 500].map((z) => ({
      ...source.entities[0],
      entityId: `floor-${x}-${z}`,
      position: { x, y: -0.5, z },
      size: { x: 1000, y: 1, z: 1000 },
    })),
  );
  source.assetCatalog = 'catalog.json';
  source.itemCatalog = resolve('content/items/catalog.json');
  source.cells = ['placement.json'];
  await writeJson(join(directory, 'world.json'), source);
  await writeJson(join(directory, 'catalog.json'), {
    formatVersion: 1,
    assets: { signal: 'signal/asset.json', fence: 'fence/asset.json' },
  });
  for (const [id, recipe] of Object.entries({ signal, fence })) {
    await mkdir(join(directory, id));
    await writeJson(join(directory, id, 'asset.json'), {
      formatVersion: 1,
      assetId: id,
      source: { kind: 'kit', file: 'source.json' },
    });
    await writeJson(join(directory, id, 'source.json'), recipe);
  }
  const compile = async (name: string, buildings: BuildingInstance[]): Promise<Release> => {
    await writeJson(join(directory, 'placement.json'), {
      formatVersion: 2,
      cellId: 'authored',
      buildings,
      statics: [],
    });
    const output = join(directory, name);
    const manifest = await buildWorld(join(directory, 'world.json'), output);
    const definition = await loadWorldBundle(manifest, (path) => readFile(join(output, path)));
    return { directory: output, manifest, definition };
  };
  before = await compile('before', original);
  after = await compile('after', moved);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function graphics(definition: WorldDefinition) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const light = new DirectionalLight('sun', new Vector3(0, -1, 0), scene);
  const shadow = new ShadowGenerator(128, light);
  const views = new BuildingViews(scene, shadow, definition);
  return {
    engine,
    scene,
    shadow,
    views,
    dispose: () => {
      views.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}
function points(scene: Scene, id: string): number[][] {
  return scene
    .getTransformNodeByName(id)!
    .getChildMeshes()
    .flatMap((mesh) => {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind) ?? [];
      const matrix = mesh.computeWorldMatrix(true);
      const output = [];
      for (let i = 0; i < positions.length; i += 3) {
        const point = Vector3.TransformCoordinates(Vector3.FromArray(positions, i), matrix);
        output.push([point.x, point.y, point.z]);
      }
      return output;
    });
}
async function memberships(release: Release, entityId: string) {
  const cells = await Promise.all(
    release.manifest.cells.map((cell) =>
      loadWorldCell(release.manifest, cell.cellId, (path) => read(release, path)),
    ),
  );
  return cells
    .filter((cell) => cell.buildings.some((item) => item.entityId === entityId))
    .map((cell) => cell.cellId);
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(stream: CellStreamer, predicate: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    stream.pump(2);
    if (predicate()) return;
    await tick();
  }
  throw new Error(JSON.stringify(stream.diagnostics()));
}

describe('independent whole static objects', () => {
  it('rebuilds a moved and rotated shared signal and fence without moving their second instances or rewriting their models', async () => {
    expect(after.manifest.mapVersion).not.toBe(before.manifest.mapVersion);
    for (const id of ['signal', 'fence'])
      expect(after.manifest.assets[id]).toEqual(before.manifest.assets[id]);
    expect(await memberships(before, 'signal-first')).toEqual(['7_7', '8_7', '7_8', '8_8']);
    expect(await memberships(after, 'signal-first')).toEqual(['9_9']);
    expect(await memberships(after, 'signal-second')).toEqual(
      await memberships(before, 'signal-second'),
    );
    expect(await memberships(after, 'fence-first')).not.toEqual(
      await memberships(before, 'fence-first'),
    );
    const oldView = graphics(before.definition),
      newView = graphics(after.definition);
    try {
      await oldView.views.prepare(before.manifest, (path) => read(before, path));
      await newView.views.prepare(after.manifest, (path) => read(after, path));
      const signalMesh = (id: string) =>
        newView.scene
          .getTransformNodeByName(id)!
          .getChildMeshes()
          .find((mesh) => mesh.getTotalVertices() > 0) as Mesh;
      expect(signalMesh('signal-first').geometry).toBe(signalMesh('signal-second').geometry);
      expect(signalMesh('signal-first').material).not.toBe(signalMesh('signal-second').material);
      for (const item of original) {
        const oldPoints = points(oldView.scene, item.entityId);
        const newPoints = points(newView.scene, item.entityId);
        const placement = moved.find((entry) => entry.entityId === item.entityId)!;
        expect(newPoints.length).toBe(oldPoints.length);
        oldPoints.forEach(([x, y, z], index) => {
          const expected = item.entityId.endsWith('first')
            ? [
                placement.position.x + z - item.position.z,
                y,
                placement.position.z - (x - item.position.x),
              ]
            : [x, y, z];
          expected.forEach((value, axis) => expect(newPoints[index][axis]).toBeCloseTo(value, 5));
        });
      }
    } finally {
      oldView.dispose();
      newView.dispose();
    }
    for (const release of [before, after]) {
      const server = await createPhysicsWorld(release.definition, await loadServerWasm(), false);
      const prediction = await createPredictionWorld(release.definition, await loadServerWasm());
      try {
        for (const world of [server, prediction]) {
          const ray = (x: number, z: number, alongX = false) =>
            world.surfaceRay(
              { x: x - (alongX ? 1 : 0), y: 1, z: z - (alongX ? 0 : 1) },
              { x: x + (alongX ? 1 : 0), y: 1, z: z + (alongX ? 0 : 1) },
            );
          expect(!!ray(-0.05, -0.05, true)).toBe(release === before);
          expect(!!ray(130, 130, true)).toBe(release === after);
          expect(!!ray(900, 900, true)).toBe(true);
          expect(!!ray(-5, 20)).toBe(release === before);
          expect(!!ray(130, 20, true)).toBe(release === after);
          expect(!!ray(5, 20)).toBe(true);
          expect(ray(0, 20)).toBeUndefined(); // the gate remains open
        }
      } finally {
        server.dispose();
        prediction.dispose();
      }
    }
  });

  it('retains a corner object once, pins prediction history, and frees scene/native resources after the final cell and model owner', async () => {
    const view = graphics(before.definition);
    const {
      entities: _entities,
      buildings: _buildings,
      buildingAssets: _assets,
      ...header
    } = before.definition;
    const physics = await createPhysicsWorld(header, await loadServerWasm(), true);
    let now = 0;
    const resources = new VerifiedResources(before.manifest, '/', {
      fetch: async (url) => new Response(await read(before, String(url).slice(1))),
    });
    const stream = new CellStreamer(
      before.manifest,
      resources,
      physics,
      {
        prepareCellAssets: (manifest, ids, read, signal) =>
          view.views.prepareAssets(manifest, ids, read, signal),
        retainStatic: (item, version) => {
          if ('assetId' in item) view.views.add(item, version);
        },
        releaseStatic: (id) => view.views.remove(id),
      },
      () => now,
    );
    const start = { x: -0.05, y: 1, z: -0.05 },
      far = { x: 950, y: 1, z: 950 };
    try {
      stream.setPreview(start);
      await until(stream, () => stream.backgroundReady);
      expect(physics.staticDiagnostics().bodies).toBe(0);
      expect(view.views.aggregateDiagnostics()).toMatchObject({ instances: 3, assets: 2 });
      stream.setArea(start);
      await until(stream, () => stream.backgroundReady);
      expect(physics.staticDiagnostics().buildings).toMatchObject({ instances: 3, assets: 2 });
      expect(view.scene.transformNodes.filter((node) => node.name === 'signal-first')).toHaveLength(
        1,
      );
      const pins = predictionCells(before.manifest, start, { x: 0.05, y: 1, z: 0.05 }, 0.35);
      expect(pins).toEqual(['7_7', '8_7', '7_8', '8_8']);
      stream.setArea(far, far, pins);
      stream.setVisualArea(far, 500);
      await until(stream, () => stream.backgroundReady);
      now += 5001;
      stream.pump(1000);
      expect(view.scene.getTransformNodeByName('signal-first')).not.toBeNull();
      stream.setArea(far);
      now += 5001;
      await until(stream, () => !view.scene.getTransformNodeByName('signal-first'));
      expect(view.views.aggregateDiagnostics()).toMatchObject({ instances: 1, assets: 1 });
      expect(physics.staticDiagnostics().buildings).toMatchObject({ instances: 1, assets: 1 });
      // A wide camera holds the distant graphics without restoring distant physics.
      stream.setVisualArea(far, 30 * 125);
      await until(stream, () => stream.backgroundReady);
      expect(view.views.aggregateDiagnostics().instances).toBe(4);
      expect(physics.staticDiagnostics().buildings.instances).toBe(1);
      stream.setPreview(far, 500);
      now += 5001;
      await until(stream, () => view.views.aggregateDiagnostics().instances === 1);
      expect(physics.staticDiagnostics().bodies).toBe(0);
      expect(resources.diagnostics().httpPeak).toBeLessThanOrEqual(4);
      expect(resources.diagnostics().pending).toBe(0);
      expect(stream.backgroundProblem).toBeUndefined();
      for (let cycle = 0; cycle < 3; cycle++) {
        stream.setPreview(start);
        now += 5001;
        await until(stream, () => stream.backgroundReady);
        stream.pump(1000);
        expect(view.views.aggregateDiagnostics()).toMatchObject({ instances: 3, assets: 2 });
        expect(physics.staticDiagnostics().bodies).toBe(0);
        stream.setArea(start);
        await until(stream, () => stream.backgroundReady);
        expect(physics.staticDiagnostics().buildings).toMatchObject({ instances: 3, assets: 2 });
        stream.setArea(far);
        stream.setVisualArea(far, 500);
        now += 5001;
        await until(stream, () => stream.backgroundReady);
        stream.pump(1000);
        expect(view.views.aggregateDiagnostics()).toMatchObject({ instances: 1, assets: 1 });
        expect(physics.staticDiagnostics().buildings).toMatchObject({ instances: 1, assets: 1 });
        stream.setPreview(far);
        now += 5001;
        stream.pump(1000);
        expect(physics.staticDiagnostics().bodies).toBe(0);
      }
    } finally {
      stream.dispose();
      physics.dispose();
      view.dispose();
    }
    expect(physics.staticDiagnostics()).toMatchObject({
      entities: 0,
      bodies: 0,
      buildings: { instances: 0, assets: 0, shapes: 0 },
    });
    expect(view.scene.meshes).toHaveLength(0);
    expect(view.scene.materials).toHaveLength(0);
    expect(view.scene.geometries).toHaveLength(0);
    expect(resources.diagnostics()).toMatchObject({ cacheBytes: 0, pending: 0 });
  });

  it('does not activate an abandoned corner when a cancelled real GLB finishes after the camera has moved', async () => {
    const view = graphics(before.definition);
    // Exercise the legacy individual-GLB path explicitly; published packs have
    // their own cancellation/integrity checks and would bypass this read hook.
    const legacyManifest = {
      ...before.manifest,
      cells: before.manifest.cells.map(({ graphicsPacks: _packs, ...cell }) => cell),
    };
    let unblock!: () => void;
    let requested!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const resources = new VerifiedResources(legacyManifest, '/', {
      fetch: async (url) => {
        const path = String(url).slice(1);
        if (path === before.manifest.assets.signal.modelFile) {
          requested();
          // Deliberately complete despite AbortSignal, as with a late browser/worker result.
          await gate;
        }
        return new Response(await read(before, path));
      },
    });
    let now = 0;
    const stream = new CellStreamer(
      legacyManifest,
      resources,
      {
        retainStatic: () => {
          throw new Error('Preview created physics');
        },
        releaseStatic: () => {},
      },
      {
        prepareCellAssets: (manifest, ids, read, signal) =>
          view.views.prepareAssets(manifest, ids, read, signal),
        retainStatic: (item, version) => {
          if ('assetId' in item) view.views.add(item, version);
        },
        releaseStatic: (id) => view.views.remove(id),
      },
      () => now,
    );
    try {
      stream.setPreview({ x: 0, y: 1, z: 0 });
      await started;
      stream.setPreview({ x: 950, y: 1, z: 950 });
      now += 5001;
      stream.pump(1000);
      unblock();
      await until(stream, () => stream.backgroundReady);
      expect(view.scene.getTransformNodeByName('signal-first')).toBeNull();
      expect(view.scene.getTransformNodeByName('signal-second')).not.toBeNull();
      expect(view.views.aggregateDiagnostics()).toMatchObject({ instances: 1, assets: 1 });
      expect(stream.backgroundProblem).toBeUndefined();
      expect(resources.diagnostics().pending).toBe(0);
    } finally {
      unblock();
      stream.dispose();
      view.dispose();
    }
    expect(view.scene.geometries).toHaveLength(0);
    expect(view.scene.materials).toHaveLength(0);
  });
});
