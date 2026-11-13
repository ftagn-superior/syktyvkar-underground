/** Full-city physical gates for explicit entrances and all low-threshold decorative doors. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadWorldBundle,
  canonicalJson,
  sampleTerrain,
  validateTerrainGrid,
  validateWorldManifest,
  type BuildingInstance,
} from '../packages/contracts/src/index.js';
import { createPhysicsWorld } from '../packages/simulation/src/physics-world.js';
import { loadServerWasm } from '../packages/simulation/src/server.js';
import {
  readRingEntranceCatalog,
  captureRingEntrancePhysicalRuntimePins,
} from './world-build/src/ring-entrance-authoring.js';
import {
  validateFoundationSupportRule,
  type FoundationSupportRuleV2,
} from '../packages/terrain-build/src/private-data.js';

type Point = { x: number; z: number };
type Door = {
  partId: string;
  index: number;
  world: Point;
  outward: Point;
  thresholdHeightMetres: number;
};
type Route = {
  id: string;
  entityId: string;
  partId: string;
  index: number;
  kind: string;
  points: Point[];
};
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `Missing ${name} value`);
  return args.splice(index, 2)[1];
};
const catalogFile = option('--catalog');
const output = option('--output');
const directory =
  option('--evidence-directory') ?? 'output/ring-terrain-stage5/entrance-approaches';
assert.ok(!catalogFile || output, 'A fresh catalog requires a separate --output directory');
assert.ok(
  args.length <= 1 && args.every((arg) => !arg.startsWith('--')),
  'Unknown entrance probe arguments',
);
const outputDirectory = output ?? directory;
await mkdir(outputDirectory, { recursive: true });
const worldDirectory = args[0] ?? 'output/ring-terrain-stage5/final/export-world';
const manifest = validateWorldManifest(
  JSON.parse(await readFile(join(worldDirectory, 'manifest.json'), 'utf8')),
);
const world = await loadWorldBundle(manifest, async (path, expectedHash) => {
  const bytes = await readFile(join(worldDirectory, path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash);
  return bytes;
});
const catalog = await readRingEntranceCatalog(catalogFile);
const physicalRuntimePins = await captureRingEntrancePhysicalRuntimePins();
const supportFile = catalog.sourcePins.find((pin) => pin.file.endsWith('/model-supports.json'));
assert.ok(supportFile, 'Catalog must pin its base model support rules');
const source: { rules: FoundationSupportRuleV2[] } = {
  rules: JSON.parse(await readFile(supportFile.file, 'utf8')).rules.map(
    validateFoundationSupportRule,
  ),
};
const grid = validateTerrainGrid(JSON.parse(await readFile(catalog.terrain.file, 'utf8')));
const audit = JSON.parse(await readFile(`${directory}/entrance-audit-ready.json`, 'utf8'));
const platforms = JSON.parse(await readFile(`${directory}/facade-platforms-ready.json`, 'utf8'));
const preliminary = JSON.parse(await readFile(`${directory}/preliminary-ready.json`, 'utf8'));
const hashFile = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const overrideSha256 = await hashFile(catalog.overrideArtifact.file);
assert.equal(overrideSha256, catalog.overrideArtifact.sha256, 'Entrance override bytes changed');
const high: Route[] = [];
const low: Route[] = [];
const pointAt = (p: Point, direction: Point, distance: number): Point => ({
  x: p.x + direction.x * distance,
  z: p.z + direction.z * distance,
});
const worldMiddle = (owner: BuildingInstance, edge: ReadonlyArray<readonly [number, number]>) => ({
  x: owner.position.x + (edge[0][0] + edge[1][0]) / 2,
  z: owner.position.z + (edge[0][1] + edge[1][1]) / 2,
});
for (const entry of catalog.owners) {
  const owner = world.buildings.find((o) => o.entityId === entry.entityId)!;
  assert.ok(owner);
  for (const door of entry.doors) {
    const approach = entry.rule.approaches!.find((a) => a.id === door.approachId)!;
    const mid = worldMiddle(owner, approach.edge);
    const direction = { x: approach.outward[0], z: approach.outward[1] };
    const points = [pointAt(mid, direction, approach.length + 0.7), pointAt(mid, direction, 0.7)];
    const facade = platforms.facades.find((f: { id: string }) => f.id === approach.id);
    if (facade) {
      const baseRule = source.rules.find((r) => r.assetId === owner.assetId)!;
      const [ci, ri, ei] = facade.id.split('-').slice(-3).map(Number);
      const ring = [baseRule.components[ci].outline, ...(baseRule.components[ci].holes ?? [])][ri];
      const a = ring[ei],
        b = ring[(ei + 1) % ring.length];
      const edgeLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const normal = { x: (b[1] - a[1]) / edgeLength, z: -(b[0] - a[0]) / edgeLength };
      const cap = pointAt(mid, direction, -1.2);
      points.push(
        cap,
        pointAt(cap, normal, -(facade.galleryWidthMetres + facade.descentLaneWidthMetres) / 2),
      );
      const original = preliminary.doors.find(
        (r: { entityId: string; door: Door }) =>
          r.entityId === entry.entityId &&
          r.door.partId === door.partId &&
          r.door.index === door.index,
      );
      if (facade.cornerGallery && door.index === 0 && owner.entityId === 'osm-way-56438161') {
        const vertex = ring[3];
        const southA = ring[2],
          southB = ring[3];
        const length = Math.hypot(southB[0] - southA[0], southB[1] - southA[1]);
        const southNormal = {
          x: (southB[1] - southA[1]) / length,
          z: -(southB[0] - southA[0]) / length,
        };
        const half = facade.galleryWidthMetres / 2;
        const determinant = southNormal.x * normal.z - southNormal.z * normal.x;
        points.push({
          x: owner.position.x + vertex[0] + (half * (normal.z - southNormal.z)) / determinant,
          z: owner.position.z + vertex[1] + (half * (southNormal.x - normal.x)) / determinant,
        });
      }
      const stop = worldMiddle(owner, original.supportEdge.edge);
      points.push(pointAt(stop, original.door.outward, facade.galleryWidthMetres / 2));
    }
    high.push({
      id: `${entry.entityId}/${door.partId}/${door.index}`,
      entityId: entry.entityId,
      partId: door.partId,
      index: door.index,
      kind: facade ? 'podium-and-side-descent' : 'straight-descent',
      points,
    });
  }
}
for (const record of catalog.directTerrainDoors) {
  const owner = world.buildings.find((o) => o.entityId === record.entityId)!;
  const model = audit.models.find((m: { entityId: string }) => m.entityId === record.entityId);
  const door: Door = model.doors.find(
    (d: Door) => d.partId === record.partId && d.index === record.index,
  );
  const rule = source.rules.find((r) => r.assetId === owner.assetId)!;
  const candidates: Array<{ mid: Point; offset: number }> = [];
  for (const component of rule.components)
    for (const ring of [component.outline, ...(component.holes ?? [])]) {
      for (let index = 0; index < ring.length; index++) {
        const a = ring[index],
          b = ring[(index + 1) % ring.length];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length < 0.9) continue;
        const tangent = { x: (b[0] - a[0]) / length, z: (b[1] - a[1]) / length };
        const normal = { x: tangent.z, z: -tangent.x };
        if (normal.x * door.outward.x + normal.z * door.outward.z < 0.999) continue;
        const local = { x: door.world.x - owner.position.x, z: door.world.z - owner.position.z };
        const along = (local.x - a[0]) * tangent.x + (local.z - a[1]) * tangent.z;
        const clipped = Math.max(0.45, Math.min(length - 0.45, along));
        if (Math.abs(clipped - along) > 0.55) continue;
        const mid = {
          x: owner.position.x + a[0] + clipped * tangent.x,
          z: owner.position.z + a[1] + clipped * tangent.z,
        };
        const offset = (mid.x - door.world.x) * normal.x + (mid.z - door.world.z) * normal.z;
        if (offset >= -0.1 && offset <= 6) candidates.push({ mid, offset });
      }
    }
  candidates.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
  assert.ok(
    candidates.length,
    `Low door has no verified outer support edge: ${record.entityId}/${record.partId}/${record.index}`,
  );
  const mid = candidates[0].mid;
  low.push({
    id: `${record.entityId}/${record.partId}/${record.index}`,
    entityId: record.entityId,
    partId: record.partId,
    index: record.index,
    kind: 'direct-terrain-low-threshold',
    points: [pointAt(mid, door.outward, 2), pointAt(mid, door.outward, 0.7)],
  });
}
const physics = await createPhysicsWorld(world, await loadServerWasm(), false);
const halfHeight = world.simulation.character.height / 2;
const results: Array<Record<string, unknown>> = [];
try {
  for (const route of [...high, ...low]) {
    for (const sprint of [false, true]) {
      const id = 'entrance-catalog-probe';
      const owner = world.buildings.find((o) => o.entityId === route.entityId)!;
      const start = route.points[0];
      const terrainY = sampleTerrain(grid, start.x, start.z)!.height;
      const floor = physics.surfaceRay(
        { ...start, y: Math.max(terrainY, owner.position.y) + 0.45 },
        { ...start, y: grid.bottom - 1 },
      );
      assert.ok(floor, `Missing route start floor ${route.id}`);
      const actor = physics.createCharacter(id, { ...start, y: floor.point.y + halfHeight + 0.06 });
      for (let tick = 0; tick < 90; tick++) physics.advance(1 / 60);
      const initial = physics.state(id);
      const initialHorizontalDisplacement = Math.hypot(
        initial.position.x - start.x,
        initial.position.z - start.z,
      );
      let maximumAirGapMetres = 0;
      let consecutiveAirTicks = 0;
      let maximumConsecutiveAirTicks = 0;
      const milestones = [];
      const targets = [...route.points.slice(1), ...route.points.slice(0, -1).reverse()];
      for (const target of targets) {
        let reached = false,
          ticks = 0,
          stall = 0;
        let previous = physics.state(id).position;
        for (; ticks < 2400; ticks++) {
          const state = physics.state(id);
          const dx = target.x - state.position.x,
            dz = target.z - state.position.z;
          const distance = Math.hypot(dx, dz);
          if (distance < 0.24) {
            reached = true;
            break;
          }
          actor.input = { moveX: dx / distance, moveZ: dz / distance, sprint };
          physics.advance(1 / 60);
          const current = physics.state(id);
          consecutiveAirTicks = current.grounded ? 0 : consecutiveAirTicks + 1;
          maximumConsecutiveAirTicks = Math.max(maximumConsecutiveAirTicks, consecutiveAirTicks);
          if (ticks % 6 === 0) {
            const surface = physics.surfaceRay(
              { ...current.position, y: current.position.y - halfHeight + 0.15 },
              { ...current.position, y: grid.bottom - 1 },
              id,
            );
            if (surface)
              maximumAirGapMetres = Math.max(
                maximumAirGapMetres,
                current.position.y - halfHeight - surface.point.y,
              );
          }
          stall =
            Math.hypot(current.position.x - previous.x, current.position.z - previous.z) < 0.0001
              ? stall + 1
              : 0;
          previous = current.position;
          if (stall > 90 || maximumAirGapMetres > 1) break;
        }
        actor.input = { moveX: 0, moveZ: 0 };
        for (let tick = 0; tick < 90; tick++) physics.advance(1 / 60);
        milestones.push({ target, reached, ticks, state: physics.state(id) });
        if (!reached) break;
      }
      const passed =
        initial.grounded &&
        initialHorizontalDisplacement < 0.15 &&
        milestones.length === targets.length &&
        milestones.every((m) => m.reached && m.state.grounded) &&
        maximumAirGapMetres < 0.4 &&
        maximumConsecutiveAirTicks < 30;
      const result = {
        routeId: route.id,
        kind: route.kind,
        sprint,
        status: passed ? 'passed' : 'failed',
        initialHorizontalDisplacement,
        maximumAirGapMetres,
        maximumConsecutiveAirTicks,
        milestones,
      };
      results.push(result);
      if (!passed) console.log(JSON.stringify(result));
      physics.removeCharacter(id);
    }
    if (results.length % 20 === 0)
      console.log(
        JSON.stringify({
          checkedRuns: results.length,
          failedRuns: results.filter((r) => r.status === 'failed').length,
        }),
      );
  }
} finally {
  physics.dispose();
}
assert.equal(
  canonicalJson(await captureRingEntrancePhysicalRuntimePins()),
  canonicalJson(physicalRuntimePins),
  'Physics runtime changed while entrance routes were running',
);
for (const [kind, routes, file] of [
  ['full-city-authored-entrances', high, 'full-city-entrance-probes.json'],
  ['full-city-low-door-volumes', low, 'low-door-volumes.json'],
] as const) {
  const ids = new Set(routes.map((r) => r.id));
  const selected = results.filter((r) => ids.has(r.routeId as string));
  const report = {
    formatVersion: 1,
    kind,
    status: selected.every((r) => r.status === 'passed') ? 'passed' : 'failed',
    mapVersion: manifest.mapVersion,
    terrainSha256: catalog.terrain.sha256,
    overridesSha256: overrideSha256,
    physicalRuntimePins,
    buildings: world.buildings.length,
    routes: routes.length,
    runs: selected.length,
    failures: selected.filter((r) => r.status === 'failed').length,
    results: selected,
  };
  await writeFile(join(outputDirectory, file), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      kind,
      status: report.status,
      routes: report.routes,
      runs: report.runs,
      failures: report.failures,
    }),
  );
}
