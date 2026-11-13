/** Full immutable pilot scene plus unapplied entrance candidates; never publishes assets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadWorldBundle,
  sampleTerrain,
  validateTerrainGrid,
  validateWorld,
  validateWorldManifest,
  type BuildingInstance,
} from '../packages/contracts/src/index.js';
import { validateFoundationSupportRule } from '../packages/terrain-build/src/private-data.js';
import { generateSupportAssets } from '../packages/terrain-build/src/supports.js';
import { readRingModelSupportCatalog } from './world-build/src/ring-support-authoring.js';
import { createPhysicsWorld } from '../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';

const directory = 'output/ring-terrain-stage4/entrance-approaches';
const worldDirectory = 'output/ring-terrain-stage4/export-world';
const manifest = validateWorldManifest(
  JSON.parse(await readFile(join(worldDirectory, 'manifest.json'), 'utf8')),
);
const world = await loadWorldBundle(manifest, async (path, expectedHash) => {
  const bytes = await readFile(join(worldDirectory, path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash);
  return bytes;
});
const grid = validateTerrainGrid(
  JSON.parse(
    await readFile('content/worlds/ring-block/terrain-candidate/pilot-grid-ready.json', 'utf8'),
  ),
);
const preliminary = JSON.parse(await readFile(`${directory}/preliminary-ready.json`, 'utf8'));
const platforms = JSON.parse(await readFile(`${directory}/facade-platforms-ready.json`, 'utf8'));
const catalog = await readRingModelSupportCatalog();
type Point = { x: number; z: number };
type Route = { id: string; owner: BuildingInstance; points: Point[]; candidateKind: string };
const additions: ReturnType<typeof generateSupportAssets> = [];
const routes: Route[] = [];

const straight = preliminary.doors.find(
  (r: { entityId: string; door: { index: number } }) =>
    r.entityId === 'osm-way-109234383' && r.door.index === 1,
);
const straightOwner = world.buildings.find((b) => b.entityId === straight.entityId)!;
const straightRule = {
  ...catalog.rules.find((r) => r.assetId === straightOwner.assetId)!,
  ownerId: straightOwner.entityId,
  approaches: [straight.approach],
};
const straightAssets = generateSupportAssets(grid, straightRule, straightOwner, {
  foundation: 'probe-straight-foundation',
  approaches: { [straight.approach.id]: 'probe-straight-ramp' },
});
additions.push(...straightAssets.filter((a) => a.role !== 'foundation'));
const a = straight.approach;
const middle = {
  x: straightOwner.position.x + (a.edge[0][0] + a.edge[1][0]) / 2,
  z: straightOwner.position.z + (a.edge[0][1] + a.edge[1][1]) / 2,
};
const along = (distance: number) => ({
  x: middle.x + a.outward[0] * distance,
  z: middle.z + a.outward[1] * distance,
});
routes.push({
  id: 'straight-109234383-door-1-fences',
  owner: straightOwner,
  points: [along(a.length + 0.7), along(0.7)],
  candidateKind: 'straight-with-potential-fence-contacts',
});

for (const entityId of ['osm-way-109234386']) {
  const candidate = platforms.ownerOverrides.find(
    (o: { entityId: string }) => o.entityId === entityId,
  );
  const owner = world.buildings.find((b) => b.entityId === entityId)!;
  const rule = validateFoundationSupportRule(candidate.rule);
  additions.push(
    ...generateSupportAssets(grid, rule, owner, {
      foundation: `probe-${entityId}-podium`,
      approaches: Object.fromEntries(rule.approaches!.map((r) => [r.id, `probe-${r.id}`])),
    }),
  );
  for (const approach of rule.approaches!) {
    const facade = platforms.facades.find((f: { id: string }) => f.id === approach.id);
    const doorRef = facade.doors[0];
    const original = preliminary.doors.find(
      (r: { entityId: string; door: { partId: string; index: number } }) =>
        r.entityId === entityId &&
        r.door.partId === doorRef.partId &&
        r.door.index === doorRef.index,
    );
    const outward = original.door.outward;
    const mid = {
      x: owner.position.x + (approach.edge[0][0] + approach.edge[1][0]) / 2,
      z: owner.position.z + (approach.edge[0][1] + approach.edge[1][1]) / 2,
    };
    const from = (distance: number) => ({
      x: mid.x + approach.outward[0] * distance,
      z: mid.z + approach.outward[1] * distance,
    });
    const cap = from(-1.2);
    routes.push({
      id: `${entityId}-side-descent-trees`,
      owner,
      candidateKind: 'podium-side-descent-with-potential-tree-contacts',
      points: [
        from(approach.length + 0.7),
        from(0.7),
        cap,
        { x: cap.x - outward.x * 2.4, z: cap.z - outward.z * 2.4 },
        { x: original.door.world.x + outward.x * 1.2, z: original.door.world.z + outward.z * 1.2 },
      ],
    });
  }
}
const definition = validateWorld({
  ...world,
  initialItems: [],
  buildingAssets: {
    ...world.buildingAssets,
    ...Object.fromEntries(additions.map((a) => [a.asset.physics.assetId, a.asset.physics])),
  },
  buildings: [
    ...world.buildings,
    ...additions.map((a) => ({
      entityId: a.asset.physics.assetId,
      assetId: a.asset.physics.assetId,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })),
  ],
});
const physics = await createPhysicsWorld(definition, await loadServerWasm(), false);
const results = [];
try {
  for (const route of routes) {
    for (const sprint of [false, true]) {
      const id = 'full-city-entrance-probe';
      const start = route.points[0];
      const actor = physics.createCharacter(id, {
        ...start,
        y: sampleTerrain(grid, start.x, start.z)!.height + 0.92,
      });
      for (let tick = 0; tick < 90; tick++) physics.advance(1 / 60);
      const milestones = [];
      const targets = [...route.points.slice(1), ...route.points.slice(0, -1).reverse()];
      for (const target of targets) {
        let reached = false;
        let ticks = 0;
        let stallTicks = 0;
        let previous = physics.state(id).position;
        for (; ticks < 2400; ticks++) {
          const state = physics.state(id);
          const dx = target.x - state.position.x,
            dz = target.z - state.position.z;
          const distance = Math.hypot(dx, dz);
          if (distance < 0.26) {
            reached = true;
            break;
          }
          actor.input = { moveX: dx / distance, moveZ: dz / distance, sprint };
          physics.advance(1 / 60);
          const current = physics.state(id).position;
          stallTicks =
            Math.hypot(current.x - previous.x, current.z - previous.z) < 0.0001
              ? stallTicks + 1
              : 0;
          previous = current;
          if (stallTicks > 90) break;
        }
        actor.input = { moveX: 0, moveZ: 0 };
        for (let rest = 0; rest < 90; rest++) physics.advance(1 / 60);
        milestones.push({ target, reached, ticks, state: physics.state(id) });
        if (!reached) break;
      }
      const result = {
        routeId: route.id,
        candidateKind: route.candidateKind,
        sprint,
        status:
          milestones.length === targets.length &&
          milestones.every((m) => m.reached && m.state.grounded)
            ? 'walked-and-returned-grounded'
            : 'route-blocked-or-not-grounded',
        milestones,
      };
      results.push(result);
      console.log(JSON.stringify(result));
      physics.removeCharacter(id);
    }
  }
} finally {
  physics.dispose();
}
await writeFile(
  `${directory}/full-city-representative-probes.json`,
  JSON.stringify(
    {
      formatVersion: 1,
      status: 'unapplied-full-city-candidate-probes',
      mapVersion: manifest.mapVersion,
      buildings: world.buildings.length,
      addedCandidateColliders: additions.length,
      limitations: [
        'Node Havok on the full immutable pilot plus candidate entrance structures; this does not publish entrances or establish full-map acceptance.',
        'Only the explicitly listed centerline routes are probed. A failed route may require different authored geometry or a verified detour.',
      ],
      routes,
      results,
    },
    null,
    2,
  ) + '\n',
);
