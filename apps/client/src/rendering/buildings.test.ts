import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Material } from '@babylonjs/core/Materials/material';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
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
  manifest = await buildWorld(undefined, directory);
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
      expect(near.material).not.toBe(far.material);
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
      expect(near.material!.alpha).toBeCloseTo(0.22);
      expect(near.material!.transparencyMode).toBe(Material.MATERIAL_ALPHABLEND);
      expect(clear.material!.alpha).toBe(1);
      expect(view.shadow.getShadowMap()!.renderList).not.toContain(near);
      expect(view.shadow.getShadowMap()!.renderList).toContain(clear);
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

  it('waits for every started loader before reporting a failed asset and allowing scene teardown', async () => {
    const view = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const pending = view.buildings.prepare(manifest, async (path) => {
      if (path === manifest.assets['house-a'].modelFile) throw new Error('model hash mismatch');
      if (path.startsWith(`assets/${manifest.assets['house-b'].version}/`)) await gate;
      return readBytes(path);
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release();
      await expect(pending).rejects.toThrow('model hash mismatch');
      expect(view.scene.meshes).toHaveLength(0);
      expect(view.scene.materials).toHaveLength(0);
      expect(view.buildings.aggregateDiagnostics().assets).toBe(0);
    } finally {
      release();
      await pending.catch(() => {});
      view.dispose();
    }
  });
});
