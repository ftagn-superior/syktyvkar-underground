import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Material } from '@babylonjs/core/Materials/material';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { AssetContainer } from '@babylonjs/core/assetContainer';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { loadWorldBundle, type WorldDefinition, type WorldManifest } from '@su/contracts';
import { buildWorld } from '../../../../tools/world-build/src/index.js';
import { BuildingViews } from './buildings';

let directory: string;
let manifest: WorldManifest;
let definition: WorldDefinition;
const readBytes = (path: string) => readFile(join(directory, path));
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'su-render-buildings-'));
  manifest = await buildWorld('content/worlds/physics-lab/world.json', directory);
  definition = await loadWorldBundle(manifest, readBytes);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fixture(world = definition) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const light = new DirectionalLight('sun', new Vector3(0, -1, 0), scene);
  const shadow = new ShadowGenerator(128, light);
  const buildings = new BuildingViews(scene, shadow, world);
  return {
    scene,
    shadow,
    buildings,
    dispose: () => {
      buildings.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

async function modelBatch(count = 10) {
  const source = manifest.assets['house-a'];
  const model = await readBytes(source.modelFile);
  const parts = JSON.parse((await readBytes(source.partsFile)).toString());
  const ids = Array.from({ length: count }, (_, index) => `batch-${index}`);
  const assets = Object.fromEntries(
    ids.map((assetId, index) => [
      assetId,
      {
        ...source,
        assetId,
        version: (index + 1).toString(16).padStart(64, '0'),
        modelFile: `${assetId}/model.glb`,
        partsFile: `${assetId}/parts.json`,
      },
    ]),
  );
  return {
    ids,
    manifest: { ...manifest, assets },
    bytes: (path: string) =>
      path.endsWith('.glb')
        ? model
        : new TextEncoder().encode(JSON.stringify({ ...parts, assetId: path.split('/')[0] })),
  };
}

describe('building rendering from the real world bundle', () => {
  it('shares GLB geometry, fades every blocking building independently, restores shadows and releases instances', async () => {
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    const world = {
      ...definition,
      buildings: [
        { entityId: 'near', assetId: 'house-a', position: { x: 0, y: 0, z: 0 }, rotation },
        { entityId: 'far', assetId: 'house-a', position: { x: 0, y: 0, z: -8 }, rotation },
        { entityId: 'clear', assetId: 'house-b', position: { x: 12, y: 0, z: 0 }, rotation },
      ],
    };
    const view = fixture(world);
    const reads: string[] = [];
    try {
      await view.buildings.prepare(manifest, async (path) => {
        reads.push(path);
        return readBytes(path);
      });
      expect(reads.filter((path) => path.endsWith('.glb'))).toHaveLength(2);
      expect(view.buildings.aggregateDiagnostics()).toEqual({
        instances: 3,
        assets: 2,
        modelLoads: 2,
        fadedBuildings: 0,
        treeInstances: 0,
        treeBatches: 0,
        treeTemplates: 0,
        fadedTrees: 0,
      });
      const wall = (id: string) =>
        view.scene
          .getTransformNodeByName(id)!
          .getChildMeshes()
          .find((mesh) => mesh.metadata?.gltf?.extras?.su.role === 'wall')! as Mesh;
      const near = wall('near'),
        far = wall('far'),
        clear = wall('clear');
      expect(near.geometry).toBe(far.geometry);
      // Opaque buildings share the template material; copies appear only while fading.
      expect(near.material).toBe(far.material);
      const direction = new Vector3(0, -0.2, -1).normalize();
      for (let frame = 0; frame < 30; frame++)
        view.buildings.update(
          new Vector3(0, 0.92, -14),
          new Vector3(0, 8, 20),
          direction,
          0.1,
          (frame * 1000) / 60,
          1 / 60,
        );
      const diagnostics = view.buildings.diagnostics();
      expect(diagnostics.buildings.map((building) => building.opacity)).toEqual([0.22, 0.22, 1]);
      expect(near.material).not.toBe(far.material);
      expect(near.material!.alpha).toBeCloseTo(0.22);
      expect(near.material!.transparencyMode).toBe(Material.MATERIAL_ALPHABLEND);
      expect(clear.material!.alpha).toBe(1);
      expect(view.shadow.getShadowMap()!.renderList).not.toContain(near);
      expect(view.shadow.getShadowMap()!.renderList).toContain(clear);
      const own = new Vector3(0, 0.92, -14);
      view.buildings.update(
        own,
        new Vector3(0, 8, 20),
        direction,
        0.05,
        490,
        1 / 60,
        own,
        200,
        true,
      );
      expect(
        view.buildings.diagnostics().buildings.every((building) => building.opacity === 1),
      ).toBe(true);
      expect(near.material).toBe(far.material);
      expect(view.shadow.getShadowMap()!.renderList).toContain(near);
      view.buildings.update(own, new Vector3(0, 8, 20), direction, 0.1, 491, 1 / 60);
      expect(view.buildings.diagnostics().buildings[0].occluded).toBe(true);
      expect(near.material!.alpha).toBeLessThan(1);
      // Clearing the silhouette restores rendering state without touching geometry or placement.
      for (let frame = 0; frame < 90; frame++)
        view.buildings.update(
          new Vector3(-15, 0.92, -14),
          new Vector3(0, 8, 20),
          direction,
          0.1,
          500 + (frame * 1000) / 60,
          1 / 60,
        );
      expect(
        view.buildings.diagnostics().buildings.every((building) => building.opacity === 1),
      ).toBe(true);
      expect(near.material!.transparencyMode).toBe(Material.MATERIAL_OPAQUE);
      expect(near.material).toBe(far.material);
      expect(view.shadow.getShadowMap()!.renderList).toContain(near);
      view.buildings.dispose();
      view.buildings.dispose();
      expect(view.scene.meshes).toHaveLength(0);
      expect(view.scene.transformNodes).toHaveLength(0);
      expect(view.scene.materials).toHaveLength(0);
      expect(view.scene.geometries).toHaveLength(0);
      expect(view.shadow.getShadowMap()!.renderList).toHaveLength(0);
    } finally {
      view.dispose();
    }
  });

  it('uses the authored ground pivot and rotation in a right-handed scene', async () => {
    const first = definition.buildings[0];
    const root = {
      ...first,
      position: { x: 3, y: 2, z: 4 },
      rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
    };
    const view = fixture({ ...definition, buildings: [root] });
    try {
      await view.buildings.prepare(manifest, readBytes);
      const actual = view.buildings.diagnostics().buildings[0].bounds;
      const asset = manifest.assets[first.assetId].bounds;
      expect(actual.min.y).toBeCloseTo(2);
      expect(actual.max.y).toBeCloseTo(2 + asset.max.y);
      expect(actual.min.x).toBeCloseTo(3 + asset.min.z);
      expect(actual.max.z).toBeCloseTo(4 - asset.min.x);
    } finally {
      view.dispose();
    }
  });

  it('rejects inconsistent part metadata and releases the completed templates and partial instance', async () => {
    const view = fixture();
    try {
      await expect(
        view.buildings.prepare(manifest, async (path) => {
          const bytes = await readBytes(path);
          if (!path.endsWith('parts.json')) return bytes;
          const parts = JSON.parse(bytes.toString());
          parts.parts[0].occlusionGroup = 'wrong';
          return new TextEncoder().encode(JSON.stringify(parts));
        }),
      ).rejects.toThrow('Invalid building semantic part');
      expect(view.scene.meshes).toHaveLength(0);
      expect(view.scene.transformNodes).toHaveLength(0);
      expect(view.scene.materials).toHaveLength(0);
      expect(view.shadow.getShadowMap()!.renderList).toHaveLength(0);
    } finally {
      view.dispose();
    }
  });

  it('does not create scene resources when disposed during a pending read', async () => {
    const view = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = view.buildings.prepare(manifest, async (path) => {
      await gate;
      return readBytes(path);
    });
    view.buildings.dispose();
    release();
    try {
      await expect(pending).rejects.toThrow('cancelled');
      expect(view.scene.meshes).toHaveLength(0);
      expect(view.scene.materials).toHaveLength(0);
    } finally {
      view.dispose();
    }
  });

  it('drains concurrent loaders after a failure without starting queued models or leaking late containers', async () => {
    const view = fixture();
    const batch = await modelBatch();
    const reads: string[] = [];
    const signals: AbortSignal[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = view.buildings.prepareAssets(
      batch.manifest,
      batch.ids,
      async (path, signal) => {
        if (path.endsWith('.glb')) {
          reads.push(path);
          signals.push(signal!);
          if (path === batch.manifest.assets[batch.ids[0]].modelFile)
            throw new Error('model hash mismatch');
          // Exercise loaders whose response arrives even after its last user cancelled.
          await gate;
        }
        return batch.bytes(path);
      },
    );
    let settled = false;
    const rejected = expect(pending).rejects.toThrow('model hash mismatch');
    void pending.catch(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => {
        expect(signals).toHaveLength(4);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
      });
      expect(reads).toHaveLength(4);
      expect(settled).toBe(false);
      finish();
      await rejected;
      expect(reads).toHaveLength(4);
      expect(view.scene.meshes).toHaveLength(0);
      expect(view.scene.materials).toHaveLength(0);
      expect(view.buildings.aggregateDiagnostics().assets).toBe(0);
    } finally {
      finish();
      await rejected;
      view.dispose();
    }
  });

  it('releases partial unparented clones after a Babylon failure without removing existing scene nodes', async () => {
    const view = fixture();
    const sentinel = new Mesh('existing-mesh', view.scene);
    const sentinelRoot = new TransformNode('existing-transform', view.scene);
    const original = AssetContainer.prototype.instantiateModelsToScene;
    let restore: (() => void) | undefined;
    let release: (() => void) | undefined;
    try {
      release = await view.buildings.prepareAssets(manifest, ['house-a'], readBytes);
      const spy = vi
        .spyOn(AssetContainer.prototype, 'instantiateModelsToScene')
        .mockImplementationOnce(function (this: AssetContainer, ...args) {
          original.apply(this, args);
          new Mesh('orphaned-clone', view.scene);
          new TransformNode('orphaned-transform', view.scene);
          throw new Error('clone interrupted');
        });
      restore = () => spy.mockRestore();
      const instance = definition.buildings.find((building) => building.assetId === 'house-a')!;
      expect(() => view.buildings.add(instance, manifest.assets['house-a'].version)).toThrow(
        'clone interrupted',
      );
      expect(view.scene.meshes).toEqual([sentinel]);
      expect(view.scene.transformNodes).toEqual([sentinelRoot]);
      expect(view.buildings.aggregateDiagnostics()).toMatchObject({ instances: 0, assets: 1 });
      restore();
      view.buildings.add(instance, manifest.assets['house-a'].version);
      expect(view.buildings.aggregateDiagnostics().instances).toBe(1);
      view.buildings.remove(instance.entityId);
      release();
      expect(view.scene.meshes).toEqual([sentinel]);
      expect(view.scene.transformNodes).toEqual([sentinelRoot]);
      expect(view.scene.materials).toHaveLength(0);
      expect(view.scene.geometries).toHaveLength(0);
    } finally {
      restore?.();
      view.buildings.dispose();
      release?.();
      view.dispose();
    }
  });
});

describe('incremental building ownership', () => {
  it('prepares a bounded window of models concurrently and refills it as individual models finish', async () => {
    const view = fixture();
    const batch = await modelBatch();
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    let blocked = true;
    const pending = view.buildings.prepareAssets(batch.manifest, batch.ids, async (path) => {
      if (path.endsWith('.glb')) {
        started.push(path);
        if (blocked)
          await new Promise<void>((resolve) => {
            gates.set(path, resolve);
          });
      }
      return batch.bytes(path);
    });
    try {
      await vi.waitFor(() => expect(started).toHaveLength(4));
      gates.get(started[0])!();
      await vi.waitFor(() => expect(started).toHaveLength(5));
      expect(view.buildings.aggregateDiagnostics().assets).toBe(1);
      blocked = false;
      for (const finish of gates.values()) finish();
      const release = await pending;
      expect(started).toHaveLength(batch.ids.length);
      expect(view.buildings.aggregateDiagnostics().assets).toBe(batch.ids.length);
      release();
      expect(view.buildings.aggregateDiagnostics().assets).toBe(0);
      expect(view.scene.materials).toHaveLength(0);
      expect(view.scene.geometries).toHaveLength(0);
    } finally {
      blocked = false;
      for (const finish of gates.values()) finish();
      await pending.catch(() => {});
      view.dispose();
    }
  });

  it('pins one shared template across cells, keeps seam instances and disposes its last user', async () => {
    const view = fixture();
    const id = 'house-a',
      version = manifest.assets[id].version;
    const instance = {
      ...definition.buildings.find((item) => item.assetId === id)!,
      entityId: 'seam',
    };
    const reads: string[] = [];
    const read = async (path: string) => {
      reads.push(path);
      return readBytes(path);
    };
    try {
      const [releaseA, releaseB] = await Promise.all([
        view.buildings.prepareAssets(manifest, [id], read),
        view.buildings.prepareAssets(manifest, [id], read),
      ]);
      expect(reads.filter((path) => path.endsWith('.glb'))).toHaveLength(1);
      view.buildings.add(instance, version);
      view.buildings.add(instance, version);
      view.buildings.remove(instance.entityId);
      releaseA();
      expect(view.buildings.aggregateDiagnostics()).toMatchObject({ instances: 1, assets: 1 });
      expect(() => view.buildings.add(instance, 'different')).toThrow('version');
      view.buildings.remove(instance.entityId);
      releaseB();
      expect(view.buildings.aggregateDiagnostics()).toMatchObject({ instances: 0, assets: 0 });
      expect(view.scene.geometries).toHaveLength(0);
      expect(view.scene.materials).toHaveLength(0);
      expect(view.shadow.getShadowMap()!.renderList).toHaveLength(0);
    } finally {
      view.dispose();
    }
  });
  it('cancels one cell without aborting another owner of an in-flight model', async () => {
    const view = fixture();
    const controller = new AbortController();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const signals: AbortSignal[] = [];
    const read = async (path: string, signal?: AbortSignal) => {
      signals.push(signal!);
      await gate;
      return readBytes(path);
    };
    const cancelled = view.buildings.prepareAssets(manifest, ['house-a'], read, controller.signal);
    const retained = view.buildings.prepareAssets(manifest, ['house-a'], read);
    // Parts are now read first; supported trees never need their GLB.
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort();
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    finish();
    try {
      await expect(cancelled).rejects.toThrow('cancelled');
      const release = await retained;
      expect(view.buildings.aggregateDiagnostics().assets).toBe(1);
      release();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(view.buildings.aggregateDiagnostics().assets).toBe(0);
    } finally {
      view.dispose();
    }
  });
});
