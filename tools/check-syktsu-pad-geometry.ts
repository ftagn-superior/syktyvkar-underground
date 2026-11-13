/** Isolated quantitative comparison, never a world publication or database migration. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  sampleTerrain,
  validateTerrainGrid,
  validateWorld,
  type BuildingInstance,
  type TerrainGrid,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import {
  planSupportPlacement,
  generateSupportAssets,
} from '../packages/terrain-build/src/supports.js';
import { generateTerrainTile } from '../packages/terrain-build/src/terrain.js';
import { generateFootprint } from './world-build/src/city.js';
import { readRingModelSupportCatalog } from './world-build/src/ring-support-authoring.js';
import { createPhysicsWorld } from '../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';

const directory = 'output/ring-terrain-stage4/pad-evaluation';
const catalog = await readRingModelSupportCatalog();
const snapshot: WorldLayoutSnapshot = JSON.parse(await readFile('data/map-layout.json', 'utf8'));
const comparison = JSON.parse(await readFile(`${directory}/comparison.json`, 'utf8'));
const pilotRule = catalog.rules.find((rule) => rule.assetId === 'osm-way-1258973447')!;
const saved = snapshot.instances.find((owner) => owner.entityId === pilotRule.assetId)!;
const choices = [
  { id: 'baseline', gridFile: 'content/worlds/ring-block/terrain-candidate/pilot-grid-4m.json' },
  ...comparison.variants.filter((variant: { id: string }) =>
    ['level-6-blend-80', 'level-7-blend-80', 'level-6-blend-60'].includes(variant.id),
  ),
];
if (process.argv[2]) choices.push({ id: 'final-explicit-pads', gridFile: process.argv[2] });
const results = [];
for (const choice of choices) {
  const grid = validateTerrainGrid(JSON.parse(await readFile(choice.gridFile, 'utf8')));
  const buildings = [];
  for (const owner of snapshot.instances.filter((owner) => owner.enabled)) {
    const rule = catalog.rules.find((rule) => rule.assetId === owner.assetId);
    if (!rule) continue;
    const plan = planSupportPlacement(grid, rule, owner);
    buildings.push({
      entityId: owner.entityId,
      ...plan,
      maximumVisibleFoundationHeightMetres: plan.minimumY + rule.jointY - plan.terrainMin,
      entranceStatus: catalog.models.find((model) => model.assetId === owner.assetId)!.evidence
        .entranceStatus,
    });
  }
  results.push({
    id: choice.id,
    buildings,
    exceedingThreeMetres: buildings.filter((b) => b.maximumVisibleFoundationHeightMetres > 3),
  });
  console.log(
    JSON.stringify({
      id: choice.id,
      buildings: buildings.length,
      overThreeMetres: results.at(-1)!.exceedingThreeMetres.length,
      maximum: Math.max(...buildings.map((b) => b.maximumVisibleFoundationHeightMetres)),
    }),
  );
}
const baseline = new Map(results[0].buildings.map((b) => [b.entityId, b]));
const comparisons = results.slice(1).map((variant) => ({
  id: variant.id,
  changedBuildings: variant.buildings
    .filter(
      (building) => Math.abs(building.minimumY - baseline.get(building.entityId)!.minimumY) > 1e-8,
    )
    .map((building) => ({
      ...building,
      baselineVisibleFoundationHeightMetres: baseline.get(building.entityId)!
        .maximumVisibleFoundationHeightMetres,
      deltaVisibleFoundationHeightMetres:
        building.maximumVisibleFoundationHeightMetres -
        baseline.get(building.entityId)!.maximumVisibleFoundationHeightMetres,
    })),
  exceedingThreeMetres: variant.exceedingThreeMetres,
}));

async function walk(grid: TerrainGrid) {
  const plan = planSupportPlacement(grid, pilotRule, saved);
  const owner: BuildingInstance = { ...saved, position: { ...saved.position, y: plan.minimumY } };
  const supports = generateSupportAssets(grid, pilotRule, owner, {
    foundation: 'pad-study-foundation',
    approaches: { 'main-entrance': 'pad-study-approach' },
  });
  const terrain = generateTerrainTile(
    'pad-study-ground',
    grid,
    [
      [-241, -301],
      [11, -301],
      [11, 11],
      [-241, 11],
    ],
    [],
  );
  const model = generateFootprint(
    owner.assetId,
    JSON.parse(
      await readFile('content/buildings/ring-block/osm-way-1258973447/source.json', 'utf8'),
    ),
  );
  const definition = JSON.parse(await readFile('content/worlds/ring-block/world.json', 'utf8'));
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  const standalone = [terrain.physics, ...supports.map((s) => s.asset.physics)];
  const world = validateWorld({
    ...definition,
    entities: [],
    initialItems: [],
    itemCatalog: { version: '1', types: {} },
    buildingAssets: Object.fromEntries(
      [model.physics, ...standalone].map((asset) => [asset.assetId, asset]),
    ),
    buildings: [
      owner,
      ...standalone.map((asset) => ({
        entityId: asset.assetId,
        assetId: asset.assetId,
        position: { x: 0, y: 0, z: 0 },
        rotation: identity,
      })),
    ],
  });
  const physics = await createPhysicsWorld(world, await loadServerWasm(), false);
  const approach = pilotRule.approaches![0];
  const middle = {
    x: owner.position.x + (approach.edge[0][0] + approach.edge[1][0]) / 2,
    z: owner.position.z + (approach.edge[0][1] + approach.edge[1][1]) / 2,
  };
  const at = (distance: number) => ({
    x: middle.x + approach.outward[0] * distance,
    z: middle.z + approach.outward[1] * distance,
  });
  const route = [{ x: 0, z: 0 }, { x: -33, z: -75 }, { x: -68, z: -130 }, at(6.5), at(0.7)];
  const passes = [];
  try {
    let maximumApproachRayError = 0;
    for (const t of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const point = at(t * approach.length);
      const base = sampleTerrain(grid, point.x, point.z)!.height;
      const expected = (owner.position.y + approach.targetY) * (1 - t) + base * t;
      const actual = physics.surfaceRay({ ...point, y: 15 }, { ...point, y: -2 });
      assert.ok(actual);
      maximumApproachRayError = Math.max(
        maximumApproachRayError,
        Math.abs(actual.point.y - expected),
      );
    }
    assert.ok(maximumApproachRayError <= 0.01);
    for (const sprint of [false, true]) {
      const start = route[0];
      const actor = physics.createCharacter('pad-route', {
        ...start,
        y: sampleTerrain(grid, start.x, start.z)!.height + 0.92,
      });
      for (let tick = 0; tick < 60; tick++) physics.advance(1 / 60);
      const milestones = [];
      for (const target of [...route.slice(1), ...route.slice(0, -1).reverse()]) {
        let reached = false;
        let tick = 0;
        for (; tick < 3000; tick++) {
          const state = physics.state('pad-route');
          const dx = target.x - state.position.x,
            dz = target.z - state.position.z;
          const distance = Math.hypot(dx, dz);
          if (distance < 0.28) {
            reached = true;
            break;
          }
          actor.input = { moveX: dx / distance, moveZ: dz / distance, sprint };
          physics.advance(1 / 60);
        }
        assert.ok(
          reached,
          `Route failed: ${JSON.stringify({ sprint, target, state: physics.state('pad-route') })}`,
        );
        actor.input = { moveX: 0, moveZ: 0 };
        for (let pause = 0; pause < 60; pause++) physics.advance(1 / 60);
        const state = physics.state('pad-route');
        assert.ok(state.grounded, `Ungrounded route target ${JSON.stringify(target)}`);
        milestones.push({ target, ticks: tick, state });
      }
      passes.push({ sprint, milestones });
      physics.removeCharacter('pad-route');
    }
    return {
      scope:
        'Isolated Node Havok terrain + actual Syktsu building, foundation and approach; surrounding city objects, networking and browser are not included.',
      ownerY: owner.position.y,
      maximumApproachRayError,
      route,
      passes,
      supportAssets: supports.map((s) => ({
        role: s.role,
        colliderCount: s.asset.physics.colliders.length,
      })),
    };
  } finally {
    physics.dispose();
  }
}
const grid = validateTerrainGrid(
  JSON.parse(await readFile(process.argv[2] ?? `${directory}/level-6-blend-80-grid.json`, 'utf8')),
);
const physicalProbe = await walk(grid);
await writeFile(
  process.argv[3] ?? `${directory}/geometry-check.json`,
  JSON.stringify(
    {
      formatVersion: 1,
      status: 'unapplied-isolated-geometry-check',
      results,
      comparisons,
      physicalProbe,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    physicalProbe: {
      ownerY: physicalProbe.ownerY,
      maximumApproachRayError: physicalProbe.maximumApproachRayError,
      passes: physicalProbe.passes.map((p) => ({
        sprint: p.sprint,
        milestones: p.milestones.length,
      })),
    },
  }),
);
