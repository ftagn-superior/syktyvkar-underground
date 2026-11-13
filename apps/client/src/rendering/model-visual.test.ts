import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { treeRenderRecipe } from '../../../../tools/world-build/src/tree-instances';
import { generateKit, type KitRecipe } from '../../../../tools/world-build/src/kit';
import { createModelVisual } from './model-visual';
import { TREE_ATTRIBUTES } from './tree-material';
import { treeTemplate } from './tree-geometry';

const directory = 'content/buildings/ring-block/objects';
describe('single model visuals', () => {
  it('shows all nine released procedural trees using world geometry, AO and shader attributes in both modes, then releases resources', async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const ids = (await readdir(directory)).filter((id) => id.startsWith('tree-'));
      expect(ids).toHaveLength(9);
      for (const assetId of ids) {
        const source: KitRecipe = JSON.parse(
          await readFile(`${directory}/${assetId}/source.json`, 'utf8'),
        );
        const recipe = treeRenderRecipe(assetId, source)!;
        const descriptor = {
          assetId,
          version: 'a'.repeat(64),
          partsFile: 'parts.json',
          collisionFile: 'colliders.json',
          bounds: generateKit(assetId, source).physics.bounds,
        };
        const reads: string[] = [];
        const read = async (path: string) => {
          reads.push(path);
          return new TextEncoder().encode(
            JSON.stringify({
              formatVersion: 1,
              assetId,
              parts: [{ partId: 'tree', role: 'detail', occlusionGroup: 'shell', nodeIndex: 0 }],
              tree: recipe,
            }),
          );
        };
        for (const purpose of ['catalog-preview', 'placement-ghost'] as const) {
          const visual = await createModelVisual(scene, descriptor, read, purpose);
          const mesh = visual.root.getChildMeshes()[0] as Mesh;
          const template = treeTemplate(recipe.crownColor, recipe.trunkColor, recipe.foliage);
          expect(mesh.thinInstanceCount ?? 0).toBe(0);
          expect(mesh.getTotalVertices()).toBe(template.parts.length);
          expect(mesh.getVerticesData('suTreePart')).toEqual(template.parts);
          expect(mesh.getVerticesData('color')).toEqual(template.colors);
          expect(Array.from(mesh.getVerticesData(TREE_ATTRIBUTES[0])!.slice(0, 4))).toEqual(
            Array.from(new Float32Array(recipe.crowns[0])),
          );
          expect(mesh.material!.alpha).toBe(purpose === 'placement-ghost' ? 0.5 : 1);
          expect(mesh.useVertexColors).toBe(purpose === 'catalog-preview');
          expect(visual.root.isEnabled()).toBe(purpose === 'catalog-preview');
          visual.show({ position: { x: 4, y: 0, z: 8 }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
          expect(visual.root.position.asArray()).toEqual([4, 0, 8]);
          visual.dispose();
          visual.dispose();
          expect(scene.meshes).toHaveLength(0);
          expect(scene.transformNodes).toHaveLength(0);
          expect(scene.materials).toHaveLength(0);
          expect(scene.geometries).toHaveLength(0);
        }
        expect(reads).toEqual(['parts.json', 'parts.json']);
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
  it('releases a model cancelled after verified bytes arrive without leaving a local root', async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const controller = new AbortController();
    try {
      const source: KitRecipe = JSON.parse(
        await readFile(`${directory}/tree-birch-small/source.json`, 'utf8'),
      );
      const descriptor = {
        assetId: 'tree-birch-small',
        version: 'a'.repeat(64),
        partsFile: 'parts.json',
        collisionFile: 'colliders.json',
        bounds: generateKit('tree-birch-small', source).physics.bounds,
      };
      await expect(
        createModelVisual(
          scene,
          descriptor,
          async () => {
            controller.abort();
            return new TextEncoder().encode(
              JSON.stringify({
                formatVersion: 1,
                assetId: descriptor.assetId,
                parts: [{ partId: 'tree', role: 'detail', occlusionGroup: 'shell', nodeIndex: 0 }],
                tree: treeRenderRecipe(descriptor.assetId, source),
              }),
            );
          },
          'placement-ghost',
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(scene.meshes).toHaveLength(0);
      expect(scene.transformNodes).toHaveLength(0);
      expect(scene.materials).toHaveLength(0);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
