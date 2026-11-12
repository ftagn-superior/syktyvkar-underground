import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { ItemCatalog } from '@su/contracts';
import catalog from '../../../../content/items/catalog.json';
import { createItemMesh } from './items';

describe('catalogue item visuals', () => {
  it('fits each physical envelope, keeps previews identical and releases temporary geometry', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    try {
      for (const type of Object.values((catalog as ItemCatalog).types)) {
        const placed = createItemMesh('placed', type, scene);
        const preview = createItemMesh('preview', type, scene);
        preview.useVertexColors = false;
        expect(scene.meshes).toHaveLength(2);
        expect(preview.getVerticesData(VertexBuffer.PositionKind)).toEqual(
          placed.getVerticesData(VertexBuffer.PositionKind),
        );
        const bounds = placed.getBoundingInfo().boundingBox;
        for (const axis of ['x', 'y', 'z'] as const) {
          expect(bounds.minimum[axis]).toBeGreaterThanOrEqual(-type.size[axis] / 2 - 0.015);
          expect(bounds.maximum[axis]).toBeLessThanOrEqual(type.size[axis] / 2 + 0.015);
          expect(bounds.maximum[axis] - bounds.minimum[axis]).toBeCloseTo(type.size[axis], 1);
        }
        placed.dispose();
        expect(preview.isDisposed()).toBe(false);
        preview.dispose();
        expect(scene.meshes).toHaveLength(0);
        expect(scene.geometries).toHaveLength(0);
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
