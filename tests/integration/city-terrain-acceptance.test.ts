import { describe, expect, it } from 'vitest';
import { createWorldGrid, type TerrainGrid } from '../../packages/contracts/src/index.js';
import { createWorldPublication } from '../../packages/world-release/src/index.js';
import { physicsFixture } from '../../packages/simulation/src/test-fixture.js';
import { loadServerWasm } from '../../packages/simulation/src/server.js';
import { cityTerrainAcceptance, type CityAcceptanceControls } from '../terrain/city-acceptance.js';

function fixture() {
  const world = physicsFixture();
  world.spawnPoints = Array.from({ length: 8 }, (_, index) => ({
    x: -3 + (index % 4),
    y: 0,
    z: -3 + Math.floor(index / 4) * 2,
  }));
  for (const [name, position, size] of [
    ['north', { x: 0, y: 1, z: -19.75 }, { x: 40, y: 2, z: 0.5 }],
    ['south', { x: 0, y: 1, z: 19.75 }, { x: 40, y: 2, z: 0.5 }],
    ['east', { x: 19.75, y: 1, z: 0 }, { x: 0.5, y: 2, z: 40 }],
    ['west', { x: -19.75, y: 1, z: 0 }, { x: 0.5, y: 2, z: 40 }],
  ] as const)
    world.entities.push({ ...world.entities[1], entityId: `boundary-${name}`, position, size });
  for (const entity of world.entities) entity.color = '#ffffff';
  const grid: TerrainGrid = {
    formatVersion: 1,
    origin: { x: -20, z: -20 },
    spacing: 2,
    columns: 21,
    rows: 21,
    heights: Array(441).fill(0),
    bottom: -3,
  };
  const manifest = createWorldPublication(world, createWorldGrid(world.bounds, 10), {}).manifest;
  const controls: CityAcceptanceControls = {
    formatVersion: 1,
    expectedSpawns: 8,
    boundaryPrefix: 'boundary-',
    routes: [
      {
        id: 'around-actual-wall',
        points: [
          [-8, -8],
          [-8, 8],
          [8, 8],
        ],
      },
    ],
    openRayPoints: [
      [-8, -8],
      [0, 8],
    ],
    restPoints: [[-8, 0]],
  };
  return { world, grid, manifest, controls };
}

describe('published-city acceptance scenarios', () => {
  it('tests full-city walk/sprint in both directions, cell seams, all spawns, stops and actual boundary contacts', async () => {
    const { world, grid, manifest, controls } = fixture();
    const result = await cityTerrainAcceptance(
      world,
      manifest,
      grid,
      ['floor'],
      controls,
      await loadServerWasm(),
    );
    expect(result.issues).toEqual([]);
    expect(result.status).toBe('passed');
    expect(result.spawns.filter((spawn) => spawn.position)).toHaveLength(8);
    expect(result.routes).toHaveLength(4);
    expect(
      result.routes.every(
        (route) =>
          route.status === 'passed' && route.seamCrossings.x > 0 && route.seamCrossings.z > 0,
      ),
    ).toBe(true);
    expect(result.boundaries).toHaveLength(12);
    expect(result.boundaries.every((boundary) => boundary.steps === 120)).toBe(true);
    expect(result.rests[0].maximumDrift).toBeLessThanOrEqual(0.01);
    expect(result.fullGameplayAcceptance).toBe(false);
    expect(result.performanceAcceptance).toBe(false);
  });

  it('reports a real city obstruction and escaped boundary instead of passing isolated-ground movement', async () => {
    const { world, grid, manifest, controls } = fixture();
    controls.routes = [
      {
        id: 'blocked-by-wall',
        points: [
          [0, 0],
          [8, 0],
        ],
      },
    ];
    world.entities.find((entity) => entity.entityId === 'boundary-west')!.position.y = -4;
    const result = await cityTerrainAcceptance(
      world,
      manifest,
      grid,
      ['floor'],
      controls,
      await loadServerWasm(),
    );
    expect(result.status).toBe('failed');
    expect(
      result.issues.some(
        (issue) =>
          issue.scenario.startsWith('route:blocked-by-wall:') && /stuck/.test(issue.message),
      ),
    ).toBe(true);
    expect(
      result.issues.some(
        (issue) =>
          issue.scenario.startsWith('boundary:boundary-west:') && /escaped/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('rejects an incorrect surface grid and an open-city control hidden by a building', async () => {
    const { world, grid, manifest, controls } = fixture();
    controls.openRayPoints = [[5, 0]];
    grid.heights.fill(0.25);
    const result = await cityTerrainAcceptance(
      world,
      manifest,
      grid,
      ['floor'],
      controls,
      await loadServerWasm(),
    );
    expect(result.status).toBe('failed');
    expect(
      result.issues.some(
        (issue) => issue.scenario.startsWith('terrain-ray:') && /ray error/.test(issue.message),
      ),
    ).toBe(true);
    expect(
      result.issues.some(
        (issue) => issue.scenario === 'city-ray:5,0' && issue.message.includes('wall'),
      ),
    ).toBe(true);
  });

  it('keeps evidence of an obstructed city start and verifies both its existing fence and the same isolated boundary', async () => {
    const { world, grid, manifest, controls } = fixture();
    world.entities.push({
      ...world.entities[1],
      entityId: 'existing-fence',
      position: { x: 0, y: 0.8, z: -17.5 },
      size: { x: 0.3, y: 1.6, z: 4 },
    });
    const result = await cityTerrainAcceptance(
      world,
      manifest,
      grid,
      ['floor'],
      controls,
      await loadServerWasm(),
    );
    expect(result.issues).toEqual([]);
    const blocked = result.boundaries.find(
      (entry) => entry.scope === 'full-city' && entry.occludedStart,
    )!;
    expect(blocked.blockingEntityId).toBe('existing-fence');
    expect(blocked.steps).toBe(120);
    expect(blocked.startAttempts!.filter((attempt) => !attempt.free)).toHaveLength(3);
    expect(result.boundaries).toContainEqual(
      expect.objectContaining({
        entityId: blocked.entityId,
        tangent: blocked.tangent,
        scope: 'ground-and-boundaries',
        steps: 120,
      }),
    );
  });
});
