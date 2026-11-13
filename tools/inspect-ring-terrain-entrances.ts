/** Actual decorative door faces, with explicit limits; never invents entrances or claims interiors. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import {
  sampleTerrain,
  validateTerrainGrid,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import { planSupportPlacement } from '../packages/terrain-build/src/supports.js';
import { generateFootprint } from './world-build/src/city.js';
import { readRingModelSupportCatalog } from './world-build/src/ring-support-authoring.js';
import { readRingTerrainPilotWithPads } from './world-build/src/ring-pads.js';

const gridPath = process.argv[2];
const snapshotPath = process.argv[3] ?? 'data/map-layout.json';
const outputPath = process.argv[4] ?? 'output/ring-terrain-stage4/entrance-audit.json';
const [grid, catalog] = await Promise.all([
  gridPath
    ? readFile(gridPath, 'utf8').then((text) => validateTerrainGrid(JSON.parse(text)))
    : readRingTerrainPilotWithPads(),
  readRingModelSupportCatalog(),
]);
const loaded = JSON.parse(await readFile(snapshotPath, 'utf8'));
const snapshot: WorldLayoutSnapshot = loaded.targetSnapshot ?? loaded;
const fixedPlacements = Boolean(loaded.targetSnapshot);
const results = [];
for (const owner of snapshot.instances.filter((owner) => owner.enabled)) {
  const model = catalog.models.find((model) => model.assetId === owner.assetId);
  if (model?.source.kind !== 'footprint') continue;
  const rule = catalog.rules.find((rule) => rule.assetId === owner.assetId)!;
  const placement = planSupportPlacement(grid, rule, owner);
  const ownerY = fixedPlacements ? owner.position.y : placement.minimumY;
  assert.ok(ownerY >= placement.minimumY - 1e-7, 'Target owner lies below minimum support height');
  const generated = generateFootprint(owner.assetId, {
    ...JSON.parse(await readFile(model.source.recipeFile, 'utf8')),
    merge: false,
  });
  const { x: ox, z: oz } = owner.position;
  const { y: qy, w: qw } = owner.rotation;
  assert.ok(owner.rotation.x === 0 && owner.rotation.z === 0);
  const cosine = 1 - 2 * qy * qy,
    sine = 2 * qy * qw;
  const transform = (x: number, z: number) => ({
    x: ox + cosine * x + sine * z,
    z: oz - sine * x + cosine * z,
  });
  const doors = [];
  for (const part of generated.parts.filter((part) =>
    /(^|-)doors$|(^|-)porch-door$/.test(part.partId),
  )) {
    assert.equal(part.indices.length % 6, 0, 'Door quad generator changed');
    for (let index = 0; index < part.indices.length; index += 6) {
      const ids = [...new Set(part.indices.slice(index, index + 6))];
      assert.equal(ids.length, 4);
      const localBottomY = Math.min(...ids.map((i) => part.positions[i * 3 + 1]));
      const bottom = ids.filter((i) => Math.abs(part.positions[i * 3 + 1] - localBottomY) < 1e-8);
      assert.equal(bottom.length, 2);
      const world = transform(
        (part.positions[bottom[0] * 3] + part.positions[bottom[1] * 3]) / 2,
        (part.positions[bottom[0] * 3 + 2] + part.positions[bottom[1] * 3 + 2]) / 2,
      );
      const normalId = ids[0] * 3;
      const nx = cosine * part.normals[normalId] + sine * part.normals[normalId + 2];
      const nz = -sine * part.normals[normalId] + cosine * part.normals[normalId + 2];
      assert.ok(Math.abs(Math.hypot(nx, nz) - 1) < 1e-6);
      const probes = [0.7, 2, 6, 12, 20].map((distance) => {
        const x = world.x + nx * distance,
          z = world.z + nz * distance;
        const terrainY = sampleTerrain(grid, x, z)?.height;
        const doorY = ownerY + localBottomY;
        return {
          distance,
          x,
          z,
          terrainY: terrainY ?? null,
          heightDifferenceMetres: terrainY === undefined ? null : doorY - terrainY,
          straightApproachAverageSlopeDegrees:
            terrainY === undefined
              ? null
              : (Math.atan2(Math.abs(doorY - terrainY), distance) * 180) / Math.PI,
        };
      });
      const terrain = sampleTerrain(grid, world.x, world.z);
      assert.ok(terrain, 'Authored door outside terrain');
      const threshold = ownerY + localBottomY - terrain.height;
      doors.push({
        partId: part.partId,
        index: index / 6,
        localBottomY,
        world,
        outward: { x: nx, z: nz },
        doorY: ownerY + localBottomY,
        terrainAtDoorY: terrain.height,
        thresholdHeightMetres: threshold,
        approximateLengthForEightDegreesMetres:
          Math.max(0, threshold) / Math.tan((8 * Math.PI) / 180),
        probes,
        status:
          localBottomY > 0.001
            ? 'raised-door-needs-individual-review'
            : owner.assetId === 'osm-way-1258973447' && part.partId === 'entrance-porch-door'
              ? 'reviewed-outer-step-approach'
              : threshold > 0.2
                ? 'threshold-over-20cm-needs-authored-access'
                : 'low-threshold-still-needs-route-check',
      });
    }
  }
  results.push({
    entityId: owner.entityId,
    assetId: owner.assetId,
    ownerY,
    maximumVisibleFoundationHeightMetres: ownerY + rule.jointY - placement.terrainMin,
    doors,
    status: doors.length ? 'actual-generated-door-faces' : 'no-authored-door-data',
  });
}
const doors = results.flatMap((model) =>
  model.doors.map((door) => ({ entityId: model.entityId, ...door })),
);
const report = {
  formatVersion: 1,
  status: 'unapplied-generated-door-audit',
  inputs: await Promise.all(
    [
      gridPath ?? 'content/worlds/ring-block/terrain-candidate/pilot-grid-with-pads.json',
      snapshotPath,
    ].map(async (path) => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    })),
  ),
  ownerHeightSource: fixedPlacements ? 'fixed-target-snapshot' : 'minimum-support-placement',
  scope:
    'Actual generated visual door quads under the proposed static minimumY. Probe slopes are diagnostics only; no ramp, clear corridor or interior passage is asserted.',
  summary: {
    models: results.length,
    modelsWithDoors: results.filter((m) => m.doors.length).length,
    modelsWithoutDoors: results.filter((m) => !m.doors.length).length,
    doorFaces: doors.length,
    over20cm: doors.filter((d) => d.thresholdHeightMetres > 0.2).length,
    maximumThresholdMetres: Math.max(...doors.map((d) => d.thresholdHeightMetres)),
  },
  highestThresholds: [...doors]
    .sort((a, b) => b.thresholdHeightMetres - a.thresholdHeightMetres)
    .slice(0, 20),
  models: results,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary));
