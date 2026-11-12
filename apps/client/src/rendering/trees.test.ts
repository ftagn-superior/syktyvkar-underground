import { describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { Ray } from '@babylonjs/core/Culling/ray';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  validateBuildingParts,
  type BuildingInstance,
  type WorldManifest,
  type WorldHeader,
} from '@su/contracts';
import { generateKit, type KitRecipe } from '../../../../tools/world-build/src/kit.js';
import { treeRenderRecipe } from '../../../../tools/world-build/src/tree-instances.js';
import { encodeStaticGlb, inspectStaticGlb } from '../../../../tools/world-build/src/glb.js';
import { treeIntersectsRay, treeTemplate } from './tree-geometry';
import { BuildingViews } from './buildings';
import type { RadialState } from './radial-fog';

const directory = 'content/buildings/ring-block/objects';
const sampleId = 'tree-f1aeb38d13795ef3';
const source = async (id = sampleId): Promise<KitRecipe> =>
  JSON.parse(await readFile(`${directory}/${id}/source.json`, 'utf8'));

describe('tree instancing', () => {
  it('always bakes broadleaf occlusion while leaving the trunk opaque and unshaded', () => {
    const baked = treeTemplate('#ffffff', '#ffffff', 'broadleaf');
    expect(baked.colors.some((channel) => channel < 0.8)).toBe(true);
    for (let vertex = 0; vertex < baked.parts.length; vertex++) {
      expect(baked.colors[vertex * 4 + 3]).toBe(1);
      if (baked.parts[vertex] === 2)
        expect(baked.colors.slice(vertex * 4, vertex * 4 + 4)).toEqual([1, 1, 1, 1]);
    }
  });

  it('reconstructs positions, normals and colors of all 829 authored trees without quantization', async () => {
    const ids = (await readdir(directory)).filter((id) => id.startsWith('tree-'));
    expect(ids).toHaveLength(829);
    for (const id of ids) {
      const recipe = await source(id);
      const tree = treeRenderRecipe(id, recipe)!;
      expect(tree, id).toBeDefined();
      const original = generateKit(id, recipe).parts[0];
      const template = treeTemplate(tree.crownColor, tree.trunkColor, tree.foliage);
      const vertices: string[] = [];
      const key = (values: number[]) => values.map((v) => Math.round(v * 100_000)).join(',');
      // Evaluate the shader's deformation independently against the existing kit generator.
      for (let i = 0; i < template.parts.length; i++) {
        let [x, y, z] = template.positions.slice(i * 3, i * 3 + 3);
        let normal = Vector3.FromArray(template.normals, i * 3);
        if (template.parts[i] < 2 && tree.foliage === 'broadleaf') {
          const [lower, upper] = tree.crowns;
          const radius = Math.max(lower[0], lower[1], upper[0], upper[1]);
          const height = upper[2] + upper[3] - lower[2];
          x *= radius;
          z *= radius;
          y = lower[2] + y * height;
          normal = new Vector3(normal.x / radius, normal.y / height, normal.z / radius).normalize();
        } else if (template.parts[i] < 2) {
          const [bottom, top, base, height] = tree.crowns[template.parts[i]];
          const radius = bottom + (top - bottom) * y;
          x *= radius;
          z *= radius;
          y = base + y * height;
          if (Math.abs(normal.y) < 0.5)
            normal.y = ((bottom - top) * Math.cos(Math.PI / 7)) / height;
          normal.normalize();
        } else {
          const [sx, sy, sz, yaw] = tree.trunk;
          const c = Math.cos(yaw),
            s = Math.sin(yaw);
          [x, y, z] = [c * x * sx + s * z * sz, y * sy + tree.trunkBase, -s * x * sx + c * z * sz];
          normal = new Vector3(c * normal.x + s * normal.z, normal.y, -s * normal.x + c * normal.z);
        }
        vertices.push(
          key([x, y, z, normal.x, normal.y, normal.z, ...template.colors.slice(i * 4, i * 4 + 3)]),
        );
      }
      const expected = original.positions.reduce<string[]>((result, _, i) => {
        if (i % 3 === 0)
          result.push(
            key([
              ...original.positions.slice(i, i + 3),
              ...original.normals.slice(i, i + 3),
              ...original.colors!.slice(i, i + 3),
            ]),
          );
        return result;
      }, []);
      expect(vertices.sort(), id).toEqual(expected.sort());
      expect(template.indices.length).toBe(original.indices.length);
    }
  });

  it('tests broadleaf crown gaps and the current spruce silhouette', async () => {
    const authored = await source();
    const broadleaf = treeRenderRecipe(sampleId, authored)!;
    expect(broadleaf.foliage).toBe('broadleaf');
    const [lower, upper] = broadleaf.crowns;
    const radius = Math.max(lower[0], lower[1], upper[0], upper[1]);
    const height = upper[2] + upper[3] - lower[2];
    const ray = (x: number, y: number) =>
      new Ray(new Vector3(x * radius, lower[2] + y * height, 20), new Vector3(0, 0, -1), 40);
    expect(treeIntersectsRay(broadleaf, ray(-0.1, 0.85))).toBe(true);
    expect(treeIntersectsRay(broadleaf, ray(0.8, 0.95))).toBe(false);
    delete authored.foliage;
    const spruce = treeRenderRecipe(sampleId, authored)!;
    expect(spruce.foliage).toBe('spruce');
    expect(treeTemplate(spruce.crownColor, spruce.trunkColor, spruce.foliage).indices.length).toBe(
      generateKit(sampleId, authored).parts[0].indices.length,
    );
    expect(treeIntersectsRay(spruce, ray(0, 0.5))).toBe(true);
  });

  it('rejects unsupported shapes and obsolete or malformed procedural metadata', async () => {
    const recipe = await source();
    const tree = treeRenderRecipe(sampleId, recipe)!;
    const parts = inspectStaticGlb(
      encodeStaticGlb(generateKit(sampleId, recipe).parts),
      sampleId,
    ).parts;
    expect(validateBuildingParts({ ...parts, tree }).tree).toEqual(tree);
    for (const invalid of [
      { ...tree, formatVersion: 1 },
      { ...tree, foliage: 'unknown' },
      { ...tree, ambientOcclusion: 'unknown' },
      { ...tree, foliage: undefined, ambientOcclusion: 'foliage-v1' },
      { ...tree, crowns: [[0, 1, 2, 3]] },
      { ...tree, trunkBase: Infinity },
      { ...tree, trunkColor: 'red' },
    ]) {
      expect(() => validateBuildingParts({ ...parts, tree: invalid })).toThrow('tree render');
    }
    (recipe.parts[0].shapes[0] as { cone: { sides: number } }).cone.sides = 8;
    expect(treeRenderRecipe(sampleId, recipe)).toBeUndefined();
  });

  it('tests actual crown/trunk surfaces, including rotated trunks and finite rays', async () => {
    const recipe = treeRenderRecipe(sampleId, await source())!;
    expect(
      treeIntersectsRay(recipe, new Ray(new Vector3(0, 1, 20), new Vector3(0, 0, -1), 40)),
    ).toBe(true);
    expect(
      treeIntersectsRay(recipe, new Ray(new Vector3(1, 1, 20), new Vector3(0, 0, -1), 40)),
    ).toBe(false);
    expect(
      treeIntersectsRay(recipe, new Ray(new Vector3(0, 6, 20), new Vector3(0, 0, -1), 40)),
    ).toBe(true);
    expect(
      treeIntersectsRay(recipe, new Ray(new Vector3(0, 6, 20), new Vector3(0, 0, -1), 10)),
    ).toBe(false);
    expect(
      treeIntersectsRay(recipe, new Ray(new Vector3(0, 20, 20), new Vector3(0, 0, -1), 40)),
    ).toBe(false);
  });

  async function fixture(instancing = true, radial?: RadialState, attributes = 16) {
    const recipe = await source();
    const generated = generateKit(sampleId, recipe),
      model = encodeStaticGlb(generated.parts);
    const parts = {
      ...inspectStaticGlb(model, sampleId).parts,
      tree: treeRenderRecipe(sampleId, recipe),
    };
    const descriptor = {
      assetId: sampleId,
      version: 'a'.repeat(64),
      partsFile: 'parts.json',
      collisionFile: 'colliders.json',
      bounds: generated.physics.bounds,
    };
    const manifest = { assets: { [sampleId]: descriptor } } as unknown as WorldManifest;
    const header = { simulation: { character: { height: 1.8, radius: 0.35 } } } as WorldHeader;
    const engine = new NullEngine();
    engine.getCaps().instancedArrays = instancing;
    engine.getCaps().maxVertexAttribs = attributes;
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const shadow = new ShadowGenerator(
      128,
      new DirectionalLight('sun', new Vector3(0, -1, 0), scene),
    );
    const views = new BuildingViews(scene, shadow, header, radial);
    const reads: string[] = [];
    let release: () => void;
    try {
      release = await views.prepareAssets(manifest, [sampleId], async (path) => {
        reads.push(path);
        if (path !== 'parts.json') throw new Error(`Unexpected tree resource: ${path}`);
        return new TextEncoder().encode(JSON.stringify(parts));
      });
    } catch (error) {
      views.dispose();
      scene.dispose();
      engine.dispose();
      throw error;
    }
    const add = (entityId: string, x = 0, z = 0) => {
      const item: BuildingInstance = {
        entityId,
        assetId: sampleId,
        position: { x, y: 0, z },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      };
      views.add(item, descriptor.version);
      return item;
    };
    const update = (own?: Vector3, now = 1000) =>
      views.update(own, new Vector3(0, 1, 20), new Vector3(0, 0, -1), 0.1, now, 0.1, own, Infinity);
    return {
      views,
      scene,
      shadow,
      reads,
      add,
      update,
      release,
      dispose() {
        views.dispose();
        release();
        scene.dispose();
        engine.dispose();
      },
    };
  }

  it('skips GLBs, batches nearby trees, isolates chunk buffers and retains shared-cell ownership', async () => {
    const f = await fixture();
    try {
      f.add('a', 10);
      f.add('a', 10);
      f.add('b', 20);
      f.add('distant', 510);
      f.update();
      expect(f.reads).toEqual(['parts.json']);
      expect(f.views.aggregateDiagnostics()).toMatchObject({
        instances: 3,
        modelLoads: 0,
        treeInstances: 3,
        treeBatches: 2,
      });
      const batches = f.scene.meshes.filter((mesh) => mesh.name.startsWith('tree-batch:'));
      expect(
        batches.map((m) => m.getBoundingInfo().boundingBox.minimumWorld.x).sort((a, b) => a - b)[1],
      ).toBeGreaterThan(500);
      expect(batches[0].geometry).not.toBe(batches[1].geometry);
      f.views.remove('a');
      f.update();
      expect(f.views.aggregateDiagnostics().treeInstances).toBe(3);
      f.views.remove('a');
      f.views.remove('b');
      f.update();
      expect(f.views.aggregateDiagnostics()).toMatchObject({ treeInstances: 1, treeBatches: 1 });
      f.views.remove('distant');
      f.update();
      expect(f.views.aggregateDiagnostics()).toMatchObject({ treeInstances: 0, treeBatches: 0 });
      expect(f.shadow.getShadowMap()!.renderList).toHaveLength(0);
      f.release();
      expect(f.views.aggregateDiagnostics().assets).toBe(0);
      f.views.dispose();
      expect(f.scene.meshes).toHaveLength(0);
      expect(f.scene.geometries).toHaveLength(0);
      expect(f.scene.materials).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });

  it('fades each blocker, restores opaque batches/shadows, and rejects conflicting versions', async () => {
    const f = await fixture();
    try {
      f.add('near');
      f.add('far', 0, -4);
      f.add('clear', 12);
      const own = new Vector3(0, 1, -10);
      for (let i = 0; i < 30; i++) f.update(own, i * 100);
      expect(f.views.diagnostics().buildings.map((b) => b.opacity)).toEqual([0.22, 0.22, 1]);
      expect(f.views.aggregateDiagnostics()).toMatchObject({
        treeInstances: 3,
        treeBatches: 3,
        fadedBuildings: 2,
      });
      expect(() => f.add('near', 20)).toThrow('Conflicting');
      for (let i = 30; i < 60; i++) f.update(undefined, i * 100);
      expect(f.views.diagnostics().buildings.every((b) => b.opacity === 1)).toBe(true);
      expect(f.views.aggregateDiagnostics().treeBatches).toBe(2); // z=-4 is a neighboring chunk
    } finally {
      f.dispose();
    }
  });

  it('restores opaque tree batches in the first perspective frame and resumes overview fades', async () => {
    const f = await fixture();
    try {
      f.add('near');
      f.add('far', 0, -4);
      const own = new Vector3(0, 1, -10);
      for (let i = 0; i < 30; i++) f.update(own, i * 100);
      expect(f.views.aggregateDiagnostics().fadedTrees).toBe(2);
      f.views.update(
        own,
        new Vector3(0, 1, 20),
        new Vector3(0, 0, -1),
        0.05,
        3001,
        1 / 60,
        own,
        200,
        true,
      );
      expect(f.views.diagnostics().buildings.every((b) => b.opacity === 1 && !b.occluded)).toBe(
        true,
      );
      expect(f.views.aggregateDiagnostics().treeInstances).toBe(2);
      expect(f.views.aggregateDiagnostics().fadedTrees).toBe(0);
      f.update(own, 3002);
      expect(f.views.diagnostics().buildings.every((b) => b.occluded && b.opacity < 1)).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it('keeps independent appearance times when a chunk grows and compacts after unloading', async () => {
    const radial = { center: { x: 0, y: 0, z: 0 }, radius: 500, time: 1000, appearMs: 300 };
    const f = await fixture(true, radial);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      f.add('old', 10);
      f.update();
      clock.mockReturnValue(200);
      f.add('new', 20);
      f.update();
      const times = () =>
        Array.from(
          f.scene.meshes
            .find((mesh) => mesh.name.startsWith('tree-batch:'))!
            .getVertexBuffer('suTreeState')!
            .getData() as Float32Array,
        ).filter((_, i) => i % 4 === 0);
      expect(times()).toEqual([100, 200]);
      f.views.remove('old');
      f.update();
      expect(times()).toEqual([200]);
    } finally {
      clock.mockRestore();
      f.dispose();
    }
  });

  it.each([
    [false, 16],
    [true, 8],
  ])('requires instancing with instancing=%s and %s attributes', async (instancing, attributes) => {
    await expect(fixture(!!instancing, undefined, Number(attributes))).rejects.toThrow(
      'instancing',
    );
  });
});
