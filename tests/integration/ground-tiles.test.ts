import { describe, expect, it } from 'vitest';
import { generateGround, type GroundRecipe } from '../../tools/world-build/src/city.js';
import { createPhysicsWorld } from '../../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../../packages/simulation/src/server.js';
import { physicsFixture } from '../../packages/simulation/src/test-fixture.js';

const recipe: GroundRecipe = {
  formatVersion: 1,
  min: [-10, -10],
  max: [10, 10],
  depth: 1,
  color: '#444444',
  layers: [
    {
      id: 'surface',
      color: '#888888',
      elevation: 0.01,
      polygons: [
        [
          [
            [-10, -10],
            [10, -10],
            [10, 10],
            [-10, 10],
          ],
          [
            [-1, -1],
            [-1, 1],
            [1, 1],
            [1, -1],
          ],
        ],
      ],
    },
  ],
};
const tiles = [
  [-10, -10, 0, 0],
  [0, -10, 10, 0],
  [-10, 0, 0, 10],
  [0, 0, 10, 10],
].map(([x, z, mx, mz], i) =>
  generateGround(`ground-${i}`, { ...recipe, min: [x, z], max: [mx, mz] }),
);
function surfaceArea(generated: ReturnType<typeof generateGround>) {
  const part = generated.parts.find((p) => p.partId === 'surface')!;
  let area = 0;
  for (let i = 0; i < part.indices.length; i += 3) {
    const points = part.indices
      .slice(i, i + 3)
      .map((id) => part.positions.slice(id * 3, id * 3 + 3));
    const [a, b, c] = points;
    area += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
    expect(points.flat().every(Number.isFinite)).toBe(true);
    const center = { x: (a[0] + b[0] + c[0]) / 3, z: (a[2] + b[2] + c[2]) / 3 };
    expect(Math.abs(center.x) < 1 && Math.abs(center.z) < 1).toBe(false);
  }
  return area;
}

describe('ground cell partition', () => {
  it('preserves area, holes, elevation and finite normals on side/corner cuts', () => {
    expect(surfaceArea(generateGround('whole', recipe))).toBeCloseTo(396);
    expect(tiles.reduce((sum, tile) => sum + surfaceArea(tile), 0)).toBeCloseTo(396);
    for (const tile of tiles) {
      expect(tile.physics.colliders).toHaveLength(1);
      for (const part of tile.parts) expect(part.normals.every(Number.isFinite)).toBe(true);
    }
  });
  it.each([false, true])(
    'walks across the side and corner seams without internal walls (sprint %s)',
    async (sprint) => {
      const definition = physicsFixture();
      definition.entities = [];
      definition.initialItems = [];
      definition.buildingAssets = Object.fromEntries(
        tiles.map((tile) => [tile.physics.assetId, tile.physics]),
      );
      definition.buildings = tiles.map((tile) => ({
        entityId: tile.physics.assetId,
        assetId: tile.physics.assetId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      }));
      const world = await createPhysicsWorld(definition, await loadServerWasm(), false);
      try {
        for (const diagonal of [false, true]) {
          world.removeCharacter('self');
          const player = world.createCharacter('self', { x: -2, y: 0.92, z: diagonal ? -2 : 3 });
          player.input = {
            moveX: diagonal ? Math.SQRT1_2 : 1,
            moveZ: diagonal ? Math.SQRT1_2 : 0,
            sprint,
          };
          for (let step = 0; step < (sprint ? 40 : 120); step++) world.advance(1 / 60);
          const state = world.state('self');
          expect(state.position.x).toBeGreaterThan(2);
          if (diagonal) expect(state.position.z).toBeGreaterThan(2);
          expect(state.position.y).toBeCloseTo(0.9, 1);
        }
      } finally {
        world.dispose();
      }
    },
  );
});
