import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { Ray } from '@babylonjs/core/Culling/ray';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { BuildingInstance, WorldHeader, WorldManifest } from '@su/contracts';
import { generateKit, type KitRecipe } from '../../../../tools/world-build/src/kit.js';
import { encodeStaticGlb, inspectStaticGlb } from '../../../../tools/world-build/src/glb.js';
import { treeRenderRecipe } from '../../../../tools/world-build/src/tree-instances.js';
import { BuildingViews } from './buildings';
import { WorldView } from './world-view';

const assetId = 'arch';
const arch: KitRecipe = {
  formatVersion: 1,
  parts: [
    {
      id: 'arch',
      role: 'detail',
      fade: false,
      color: '#336633',
      shapes: [
        { box: { center: [-1.5, 2, 0], size: [1, 4, 1] } },
        { box: { center: [1.5, 2, 0], size: [1, 4, 1] } },
        { box: { center: [0, 3.5, 0], size: [4, 1, 1] } },
      ],
    },
  ],
  colliders: [{ id: 'solid', center: [0, 2, 0], size: [4, 4, 1] }],
};

async function fixture(thin = true, tree = false) {
  const engine = new NullEngine();
  engine.getCaps().instancedArrays = true;
  engine.getCaps().maxVertexAttribs = 16;
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const shadow = new ShadowGenerator(
    128,
    new DirectionalLight('sun', new Vector3(0, -1, 0), scene),
  );
  const profile: KitRecipe = tree
    ? JSON.parse(
        await readFile('content/buildings/ring-block/objects/tree-leaf-medium/source.json', 'utf8'),
      )
    : arch;
  const generated = generateKit(assetId, profile);
  const model = encodeStaticGlb(generated.parts);
  const parts = {
    ...inspectStaticGlb(model, assetId).parts,
    ...(tree
      ? { tree: treeRenderRecipe('tree-leaf-medium', profile) }
      : thin
        ? { renderMode: 'thin-instance' }
        : {}),
  };
  const descriptor = {
    assetId,
    version: 'a'.repeat(64),
    partsFile: 'parts.json',
    ...(tree ? {} : { modelFile: 'model.glb' }),
    collisionFile: 'collision.json',
    bounds: generated.physics.bounds,
  };
  const manifest = { assets: { [assetId]: descriptor } } as unknown as WorldManifest;
  const header = { simulation: { character: { height: 1.8, radius: 0.35 } } } as WorldHeader;
  const views = new BuildingViews(scene, shadow, header);
  const release = await views.prepareAssets(manifest, [assetId], async (path) =>
    path === 'parts.json' ? new TextEncoder().encode(JSON.stringify(parts)) : model,
  );
  const add = (entityId: string, x = 0, z = 10, yaw = 0) => {
    const q = Quaternion.RotationAxis(Vector3.Up(), yaw);
    const definition: BuildingInstance = {
      entityId,
      assetId,
      position: { x, y: 0, z },
      rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
    };
    views.add(definition, descriptor.version);
  };
  return {
    scene,
    views,
    add,
    dispose() {
      views.dispose();
      release();
      scene.dispose();
      engine.dispose();
    },
  };
}
const ray = (x: number, y = 2, z = 0) => new Ray(new Vector3(x, y, z), new Vector3(0, 0, 1), 100);

describe('whole static object selection', () => {
  it.each([true, false])(
    'picks exact nearest geometry and stable IDs with thin instances = %s',
    async (thin) => {
      const f = await fixture(thin);
      try {
        f.add('near');
        f.add('far', 0, 20);
        f.add('neighbor', 6);
        expect(f.views.pick(ray(1.5))?.entityId).toBe('near');
        expect(f.views.pick(ray(7.5))?.entityId).toBe('neighbor');
        // The complete bounds overlap the archway, but empty passages are not geometry.
        expect(f.views.pick(ray(0))).toBeUndefined();
        expect(f.views.pick(ray(1.5), new Set(['near']))?.entityId).toBe('far');
        expect(
          f.views.pick(new Ray(new Vector3(1.5, 2, 0), new Vector3(0, 0, 1), 5)),
        ).toBeUndefined();
        f.views.remove('near');
        expect(f.views.pick(ray(1.5))?.entityId).toBe('far');
        f.views.remove('far');
        expect(f.views.pick(ray(1.5))).toBeUndefined();
      } finally {
        f.dispose();
      }
    },
  );

  it.each([true, false])(
    'composes rotated placements and respects hidden detail with thin instances = %s',
    async (thin) => {
      const f = await fixture(thin);
      try {
        f.add('rotated', 6, 10, Math.PI / 2);
        const hit = f.views.pick(ray(6));
        expect(hit?.entityId).toBe('rotated');
        expect(hit?.distance).toBeCloseTo(8, 4);
        expect(hit?.maximum.z).toBeCloseTo(12, 4);
        f.views.setDetailScale(20);
        expect(f.views.pick(ray(6))).toBeUndefined();
        f.views.setDetailScale(0);
        expect(f.views.pick(ray(6))?.entityId).toBe('rotated');
      } finally {
        f.dispose();
      }
    },
  );

  it('uses procedural tree crown/trunk surfaces and nearest distance rather than batch bounds', async () => {
    const f = await fixture(true, true);
    try {
      f.add('near-tree');
      f.add('far-tree', 0, 30, Math.PI / 4);
      expect(f.views.pick(ray(0, 1))?.entityId).toBe('near-tree');
      expect(f.views.pick(ray(1, 1))).toBeUndefined();
      const near = f.views.pick(ray(0, 6));
      expect(near?.entityId).toBe('near-tree');
      f.views.remove('near-tree');
      const far = f.views.pick(ray(0, 6));
      expect(far?.entityId).toBe('far-tree');
      expect(far!.distance).toBeGreaterThan(near!.distance + 15);
      f.views.remove('far-tree');
      expect(f.views.pick(ray(0, 6))).toBeUndefined();
    } finally {
      f.dispose();
    }
  });

  it('highlights the complete instance without touching materials and clears after its last cell unloads', async () => {
    const f = await fixture();
    try {
      f.add('shared');
      f.add('shared');
      const fake = {
        scene: f.scene,
        buildings: f.views,
        statics: { remove: vi.fn() },
        getStaticObject: (id: string) => f.views.selection(id),
        highlightStaticObject(id?: string) {
          WorldView.prototype.highlightStaticObject.call(this as unknown as WorldView, id);
        },
      };
      const materials = f.scene.materials.map((material) => [material, material.alpha]);
      fake.highlightStaticObject('shared');
      const cage = f.scene.getMeshByName('static-removal-highlight')!;
      expect(cage.isEnabled()).toBe(true);
      expect(cage.scaling.x).toBeCloseTo(4.06);
      expect(cage.scaling.y).toBeCloseTo(4.06);
      fake.highlightStaticObject('shared');
      expect(f.scene.meshes.filter((mesh) => mesh.name === cage.name)).toHaveLength(1);
      for (const [material, alpha] of materials)
        expect((material as { alpha: number }).alpha).toBe(alpha);
      WorldView.prototype.releaseStatic.call(fake as unknown as WorldView, 'shared');
      expect(cage.isEnabled()).toBe(true);
      WorldView.prototype.releaseStatic.call(fake as unknown as WorldView, 'shared');
      expect(cage.isEnabled()).toBe(false);
      expect(f.views.pick(ray(1.5))).toBeUndefined();
    } finally {
      f.dispose();
    }
  });
});
