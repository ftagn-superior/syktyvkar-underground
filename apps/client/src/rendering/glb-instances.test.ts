import { describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { AssetContainer } from '@babylonjs/core/assetContainer';
import { BuildingViews } from './buildings';
import { WorldView } from './world-view';
import { GlbInstances } from './glb-instances';
import { loadBuildingContainer } from './building-container';
import { encodeStaticGlb, inspectStaticGlb } from '../../../../tools/world-build/src/glb.js';
import { generateKit, type KitRecipe } from '../../../../tools/world-build/src/kit.js';
import type { BuildingInstance, WorldHeader, WorldManifest } from '@su/contracts';

const assetId = 'unrelated-stable-id';
const recipe: KitRecipe = {
  formatVersion: 1,
  parts: [
    {
      id: 'base',
      role: 'detail',
      fade: false,
      color: '#336633',
      shapes: [{ box: { center: [0, 0.5, 0], size: [1, 1, 1] } }],
    },
    {
      id: 'top',
      role: 'detail',
      fade: false,
      color: '#ddcc88',
      shapes: [{ box: { center: [0, 1.5, 0], size: [2, 0.2, 2] } }],
    },
  ],
  colliders: [{ id: 'solid', center: [0, 0.8, 0], size: [2, 1.6, 2] }],
};
function fixture(instancing = true, profile = recipe) {
  const generated = generateKit(assetId, profile);
  const model = encodeStaticGlb(generated.parts);
  const parts = { ...inspectStaticGlb(model, assetId).parts, renderMode: 'thin-instance' };
  const descriptor = {
    assetId,
    version: 'a'.repeat(64),
    partsFile: 'parts.json',
    modelFile: 'model.glb',
    collisionFile: 'colliders.json',
    bounds: generated.physics.bounds,
  };
  const manifest = { assets: { [assetId]: descriptor } } as unknown as WorldManifest;
  const header = { simulation: { character: { height: 1.8, radius: 0.35 } } } as WorldHeader;
  const engine = new NullEngine();
  engine.getCaps().instancedArrays = instancing;
  engine.getCaps().maxVertexAttribs = 16;
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const shadow = new ShadowGenerator(
    128,
    new DirectionalLight('sun', new Vector3(0, -1, 0), scene),
  );
  const radial = { center: { x: 0, y: 0, z: 0 }, radius: 1000, time: 10000, appearMs: 300 };
  const views = new BuildingViews(scene, shadow, header, radial);
  const reads: string[] = [];
  const read = async (path: string) => {
    reads.push(path);
    return path === 'parts.json' ? new TextEncoder().encode(JSON.stringify(parts)) : model;
  };
  const add = (entityId: string, x = 0, rotation = Quaternion.Identity()) => {
    const definition: BuildingInstance = {
      entityId,
      assetId,
      position: { x, y: 2, z: 10 },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    };
    views.add(definition, descriptor.version);
    return definition;
  };
  const update = (center?: Vector3, radius = Infinity) =>
    views.update(
      undefined,
      new Vector3(0, 20, 10),
      new Vector3(0, -1, 0),
      0.1,
      1000,
      0.1,
      center,
      radius,
    );
  return {
    scene,
    engine,
    shadow,
    views,
    radial,
    read,
    reads,
    add,
    update,
    descriptor,
    manifest,
    parts,
    model,
    dispose() {
      views.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}
const batches = (scene: Scene) =>
  scene.meshes.filter(
    (mesh): mesh is Mesh => mesh instanceof Mesh && mesh.name.startsWith('glb-batch:'),
  );

describe('static GLB thin instances', () => {
  it('groups multiple parts, isolates chunk buffers, compacts slots and preserves shared-cell ownership', async () => {
    const f = fixture();
    try {
      const [releaseA, releaseB] = await Promise.all([
        f.views.prepareAssets(f.manifest, [assetId], f.read),
        f.views.prepareAssets(f.manifest, [assetId], f.read),
      ]);
      f.add('a', 5);
      f.add('a', 5);
      f.add('middle', 10);
      f.add('c', 20);
      f.add('other-chunk', 510);
      f.update();
      expect(f.reads).toEqual(['parts.json', 'model.glb']);
      expect(f.views.aggregateDiagnostics()).toMatchObject({
        instances: 4,
        modelLoads: 1,
        glbInstances: 4,
        glbBatches: 4,
        glbTemplates: 2,
        glbInstanceBufferBytes: 2560,
      });
      expect(f.views.diagnostics().lifecycle).toEqual({
        modelImports: 1,
        instancesCreated: 4,
        instancesRemoved: 0,
      });
      expect(f.scene.transformNodes).toHaveLength(0);
      const near = batches(f.scene).filter((mesh) => mesh.thinInstanceCount === 3);
      const far = batches(f.scene).filter((mesh) => mesh.thinInstanceCount === 1);
      expect(near).toHaveLength(2);
      expect(far).toHaveLength(2);
      for (let i = 0; i < 2; i++) {
        expect(near[i].geometry).not.toBe(far[i].geometry);
        expect(far[i].getBoundingInfo().boundingBox.minimumWorld.x).toBeGreaterThan(500);
      }
      f.views.remove('a');
      releaseA();
      f.update();
      expect(f.views.aggregateDiagnostics().instances).toBe(4);
      expect(f.views.diagnostics().lifecycle.instancesRemoved).toBe(0);
      f.views.remove('middle');
      f.update();
      expect(
        near[0].thinInstanceGetWorldMatrices().map((matrix) => matrix.getTranslation().x),
      ).toEqual([5, 20]);
      expect(() => f.add('a', 25)).toThrow('Conflicting');
      for (const id of ['a', 'c', 'other-chunk']) f.views.remove(id);
      f.update();
      expect(f.views.aggregateDiagnostics()).toMatchObject({ instances: 0, glbBatches: 0 });
      expect(f.views.diagnostics().lifecycle).toEqual({
        modelImports: 1,
        instancesCreated: 4,
        instancesRemoved: 4,
      });
      expect(f.shadow.getShadowMap()!.renderList!.filter((mesh) => mesh.isEnabled())).toHaveLength(
        0,
      );
      releaseB();
      expect(f.scene.meshes).toHaveLength(0);
      expect(f.scene.geometries).toHaveLength(0);
      expect(f.scene.materials).toHaveLength(0);
      expect(f.views.aggregateDiagnostics()).toMatchObject({ assets: 0, glbTemplates: 0 });
    } finally {
      f.dispose();
    }
  });

  it('keeps individual appearance when joining groups and moves only the required shadow subset', async () => {
    const f = fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      const release = await f.views.prepareAssets(f.manifest, [assetId], f.read);
      f.add('old', 5);
      f.update();
      clock.mockReturnValue(200);
      f.add('new', 20);
      f.update();
      const state = () =>
        Array.from(
          (batches(f.scene)[0].getVertexBuffer('suInstanceState')!.getData() as Float32Array).slice(
            0,
            batches(f.scene)[0].thinInstanceCount * 4,
          ),
        ).filter((_, i) => i % 4 === 0);
      expect(state()).toEqual([100, 200]);
      f.views.remove('old');
      f.update();
      expect(state()).toEqual([200]);
      f.add('distant', 110);
      f.update(new Vector3(0, 2, 10), 1000);
      expect(f.shadow.getShadowMap()!.renderList!.filter((mesh) => mesh.isEnabled())).toHaveLength(
        2,
      );
      f.update(new Vector3(110, 2, 10), 1000);
      expect(f.shadow.getShadowMap()!.renderList!.filter((mesh) => mesh.isEnabled())).toHaveLength(
        2,
      );
      f.update(undefined, 0);
      expect(f.shadow.getShadowMap()!.renderList!.filter((mesh) => mesh.isEnabled())).toHaveLength(
        0,
      );
      for (const id of ['new', 'distant']) f.views.remove(id);
      release();
      expect(f.views.aggregateDiagnostics()).toMatchObject({ instances: 0, glbBatches: 0 });
    } finally {
      clock.mockRestore();
      f.dispose();
    }
  });

  it('uploads newly added matrices within capacity and preserves GPU buffers through compaction', async () => {
    const f = fixture();
    try {
      const release = await f.views.prepareAssets(f.manifest, [assetId], f.read);
      f.add('first', 5);
      f.update();
      const mesh = batches(f.scene).find((mesh) => mesh.isEnabled())!;
      const matrixBuffer = mesh.getVertexBuffer('world0')!.getBuffer();
      expect(mesh.thinInstanceGetWorldMatrices()).toHaveLength(1);
      const allocate = vi.spyOn(mesh, 'thinInstanceSetBuffer');
      const upload = vi.spyOn(f.engine, 'updateDynamicVertexBuffer');
      f.add('second', 20);
      f.update();
      expect(allocate).not.toHaveBeenCalled();
      expect(mesh.getVertexBuffer('world0')!.getBuffer()).toBe(matrixBuffer);
      const matrixUpload = upload.mock.calls.find(([buffer]) => buffer === matrixBuffer)!;
      expect(matrixUpload[3]).toBe(2 * 16 * 4);
      expect((matrixUpload[1] as Float32Array)[16 + 12]).toBe(20);
      expect(
        mesh.thinInstanceGetWorldMatrices().map((matrix) => matrix.getTranslation().x),
      ).toEqual([5, 20]);
      f.views.remove('first');
      f.update();
      expect(
        mesh.thinInstanceGetWorldMatrices().map((matrix) => matrix.getTranslation().x),
      ).toEqual([20]);
      expect(mesh.getVertexBuffer('world0')!.getBuffer()).toBe(matrixBuffer);
      for (let i = 0; i < 8; i++) f.add(`prop-${i}`, 30 + i);
      f.update();
      expect(mesh.thinInstanceCount).toBe(9);
      expect(mesh.getVertexBuffer('world0')!.getBuffer()).not.toBe(matrixBuffer);
      expect(mesh.getVertexBuffer('suInstanceState')!.isUpdatable()).toBe(true);
      for (let i = 0; i < 8; i++) f.views.remove(`prop-${i}`);
      f.views.remove('second');
      release();
      expect(f.scene.meshes).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });

  it('bounds idle batches by template and releases every retained mesh with its asset', async () => {
    const f = fixture();
    try {
      const release = await f.views.prepareAssets(f.manifest, [assetId], f.read);
      for (let i = 0; i < 30; i++) f.add(`prop-${i}`, i * 125 + 10);
      f.update();
      for (let i = 0; i < 30; i++) f.views.remove(`prop-${i}`);
      f.update();
      expect(f.views.aggregateDiagnostics()).toMatchObject({
        glbInstances: 0,
        glbBatches: 0,
        glbPooledBatches: 48,
      });
      expect(f.views.aggregateDiagnostics().glbPoolBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      const idle = batches(f.scene);
      expect(idle.every((mesh) => !mesh.isEnabled() && mesh.thinInstanceCount === 0)).toBe(true);
      const buffers = new Set(idle.map((mesh) => mesh.getVertexBuffer('world0')!.getBuffer()));
      f.add('returning', 6000);
      f.update();
      const active = batches(f.scene).filter((mesh) => mesh.isEnabled());
      expect(active).toHaveLength(2);
      expect(active.every((mesh) => idle.includes(mesh))).toBe(true);
      expect(active.every((mesh) => buffers.has(mesh.getVertexBuffer('world0')!.getBuffer()))).toBe(
        true,
      );
      expect(
        active.every((mesh) => mesh.thinInstanceGetWorldMatrices()[0].getTranslation().x === 6000),
      ).toBe(true);
      f.views.remove('returning');
      release();
      expect(f.scene.meshes).toHaveLength(0);
      expect(f.scene.geometries).toHaveLength(0);
      expect(f.shadow.getShadowMap()!.renderList).toHaveLength(0);
      expect(f.views.aggregateDiagnostics()).toMatchObject({
        glbPooledBatches: 0,
        glbPoolBytes: 0,
      });
    } finally {
      f.dispose();
    }
  });

  it('composes full instance quaternion and every original GLB node transform', async () => {
    const f = fixture();
    let container: AssetContainer | undefined;
    const glbs = new GlbInstances(f.scene, f.shadow);
    try {
      container = await loadBuildingContainer(f.model, f.scene, 'transform.glb');
      const template = container.meshes.find(
        (mesh) => mesh instanceof Mesh && mesh.getTotalVertices(),
      )! as Mesh;
      template.position.set(2, 3, -1);
      template.rotationQuaternion = Quaternion.FromEulerAngles(0.3, 0.7, -0.2);
      template.scaling.set(2, 0.7, 1.4);
      const local = template.computeWorldMatrix(true).clone();
      glbs.prepare(f.descriptor, { ...f.parts, renderMode: 'thin-instance' }, container);
      const rotation = Quaternion.FromEulerAngles(-0.4, 0.5, 0.2);
      const definition: BuildingInstance = {
        entityId: 'rotated',
        assetId,
        position: { x: 30, y: 7, z: -20 },
        rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      };
      glbs.add(definition, f.descriptor.version, 'signature');
      glbs.update(undefined, Infinity);
      const instanceWorld = Matrix.Compose(Vector3.One(), rotation, new Vector3(30, 7, -20));
      const batch = batches(f.scene).find((mesh) => mesh.name.includes(':base:'))!;
      expect(Array.from(batch.thinInstanceGetWorldMatrices()[0].m)).toEqual(
        Array.from(local.multiply(instanceWorld).m),
      );
      const point = new Vector3(0.5, 1, 0.5);
      const expected = Vector3.TransformCoordinates(
        Vector3.TransformCoordinates(point, local),
        instanceWorld,
      );
      const actual = Vector3.TransformCoordinates(point, batch.thinInstanceGetWorldMatrices()[0]);
      expect(Vector3.Distance(actual, expected)).toBeLessThan(1e-5);
      const bounds = glbs.diagnostics()[0].bounds;
      expect(actual.x).toBeGreaterThanOrEqual(bounds.min.x - 1e-5);
      expect(actual.x).toBeLessThanOrEqual(bounds.max.x + 1e-5);
    } finally {
      glbs.dispose();
      container?.dispose();
      f.dispose();
    }
  });

  it.each([
    ['sheared', Matrix.FromArray([1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])],
    ['reflected', Matrix.Scaling(-1, 1, 1)],
  ])(
    'rejects %s source transforms that cannot retain correct normal/culling behavior',
    async (_name, transform) => {
      const f = fixture();
      const glbs = new GlbInstances(f.scene, f.shadow);
      let container: AssetContainer | undefined;
      try {
        container = await loadBuildingContainer(f.model, f.scene, 'invalid-transform.glb');
        const source = container.meshes.find(
          (mesh) => mesh instanceof Mesh && mesh.getTotalVertices(),
        )! as Mesh;
        source.setPreTransformMatrix(transform);
        expect(() =>
          glbs.prepare(f.descriptor, { ...f.parts, renderMode: 'thin-instance' }, container!),
        ).toThrow('transform');
        expect(glbs.aggregateDiagnostics().glbTemplates).toBe(0);
      } finally {
        glbs.dispose();
        container?.dispose();
        f.dispose();
      }
    },
  );

  it('cancels a last owner during GLB I/O without replacing a newly prepared generation', async () => {
    const f = fixture();
    let finish!: () => void;
    let started!: () => void;
    const loading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const stale = f.views.prepareAssets(
      f.manifest,
      [assetId],
      async (path) => {
        if (path === 'model.glb') {
          started();
          await gate;
        }
        return f.read(path);
      },
      controller.signal,
    );
    try {
      await loading;
      controller.abort();
      const release = await f.views.prepareAssets(f.manifest, [assetId], f.read);
      finish();
      await expect(stale).rejects.toThrow('cancelled');
      f.add('live');
      f.update();
      expect(f.views.aggregateDiagnostics()).toMatchObject({
        instances: 1,
        assets: 1,
        glbBatches: 2,
      });
      f.views.remove('live');
      release();
      expect(f.scene.meshes).toHaveLength(0);
      expect(f.scene.materials).toHaveLength(0);
      expect(f.scene.geometries).toHaveLength(0);
    } finally {
      finish();
      await stale.catch(() => {});
      f.dispose();
    }
  });

  it('keeps the local transparent ghost separate and releases its private resources on cancellation', async () => {
    const f = fixture();
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        const ghost = await WorldView.prototype.createStaticGhost.call(
          { scene: f.scene, disposed: false } as unknown as WorldView,
          f.manifest.assets[assetId],
          f.read,
        );
        expect(f.views.aggregateDiagnostics().glbInstances).toBe(0);
        const root = f.scene.getTransformNodeByName(`model-visual:${assetId}`)!;
        const meshes = root.getChildMeshes().filter((mesh) => mesh.getTotalVertices() > 0);
        expect(meshes).toHaveLength(2);
        expect(meshes.every((mesh) => mesh.material?.alpha === 0.5 && !mesh.isPickable)).toBe(true);
        ghost.show({ position: { x: 12, y: 0, z: 4 }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
        expect(root.isEnabled()).toBe(true);
        expect(root.position.asArray()).toEqual([12, 0, 4]);
        ghost.show();
        expect(root.isEnabled()).toBe(false);
        ghost.dispose();
        expect(f.scene.meshes).toHaveLength(0);
        expect(f.scene.transformNodes).toHaveLength(0);
        expect(f.scene.geometries).toHaveLength(0);
        expect(f.scene.materials).toHaveLength(0);
      }
    } finally {
      f.dispose();
    }
  });

  it('keeps modular fence silhouettes at overview scale while culling other small props', async () => {
    const fence = fixture(true, { ...recipe, parts: [{ ...recipe.parts[0], id: 'fence' }] });
    const prop = fixture();
    try {
      const releaseFence = await fence.views.prepareAssets(fence.manifest, [assetId], fence.read);
      const releaseProp = await prop.views.prepareAssets(prop.manifest, [assetId], prop.read);
      fence.add('fence');
      prop.add('prop');
      fence.views.setDetailScale(20);
      prop.views.setDetailScale(20);
      fence.update();
      prop.update();
      expect(fence.views.aggregateDiagnostics().glbBatches).toBe(1);
      expect(batches(fence.scene)[0].thinInstanceCount).toBe(1);
      expect(prop.views.aggregateDiagnostics().glbBatches).toBe(0);
      prop.views.setDetailScale(0);
      prop.update();
      expect(prop.views.aggregateDiagnostics().glbBatches).toBe(2);
      fence.views.remove('fence');
      prop.views.remove('prop');
      releaseFence();
      releaseProp();
    } finally {
      fence.dispose();
      prop.dispose();
    }
  });

  it('releases partial chunks when GPU geometry preparation fails midway through a multi-part model', async () => {
    const f = fixture();
    const original = Mesh.prototype.makeGeometryUnique;
    const fail = vi.spyOn(Mesh.prototype, 'makeGeometryUnique').mockImplementation(function (
      this: Mesh,
    ) {
      if (this.name.includes('glb-batch:') && this.name.includes(':top:'))
        throw new Error('injected geometry failure');
      return original.call(this);
    });
    try {
      const release = await f.views.prepareAssets(f.manifest, [assetId], f.read);
      expect(() => f.add('partial')).toThrow('injected geometry failure');
      expect(f.views.aggregateDiagnostics()).toMatchObject({ instances: 0, glbBatches: 0 });
      expect(batches(f.scene)).toHaveLength(0);
      expect(f.shadow.getShadowMap()!.renderList).toHaveLength(0);
      fail.mockRestore();
      f.add('recovered');
      f.update();
      expect(f.views.aggregateDiagnostics()).toMatchObject({ instances: 1, glbBatches: 2 });
      f.views.remove('recovered');
      release();
      expect(f.scene.geometries).toHaveLength(0);
    } finally {
      fail.mockRestore();
      f.dispose();
    }
  });

  it('rejects a marked GLB if instancing cannot be prepared, releases all resources and never falls back', async () => {
    const f = fixture(false);
    try {
      await expect(f.views.prepareAssets(f.manifest, [assetId], f.read)).rejects.toThrow(
        'GPU instancing',
      );
      expect(f.views.aggregateDiagnostics().instances).toBe(0);
      expect(f.scene.meshes).toHaveLength(0);
      expect(f.scene.geometries).toHaveLength(0);
      expect(f.scene.materials).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });
});
