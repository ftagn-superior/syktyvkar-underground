/** Validate explicit facade podium candidates through the unchanged support generator. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  terrainNormal,
  validateTerrainGrid,
  type Vec3,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import {
  generateSupportAssets,
  planSupportPlacement,
} from '../packages/terrain-build/src/supports.js';
import { validateFoundationSupportRule } from '../packages/terrain-build/src/private-data.js';
import { compileGeneratedAsset } from '../packages/terrain-build/src/assets.js';

const directory = process.argv[4] ?? 'output/ring-terrain-stage4/entrance-approaches';
const reportPath = `${directory}/facade-platforms-ready.json`;
const gridPath =
  process.argv[2] ?? 'content/worlds/ring-block/terrain-candidate/pilot-grid-ready.json';
const snapshotPath = process.argv[3] ?? 'output/ring-terrain-stage4/static-preflight.json';
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const studyPath = 'content/worlds/ring-block/terrain-candidate/entrance-authoring-study.json';
const study = JSON.parse(await readFile(studyPath, 'utf8'));
const grid = validateTerrainGrid(JSON.parse(await readFile(gridPath, 'utf8')));
const loaded = JSON.parse(await readFile(snapshotPath, 'utf8'));
const snapshot: WorldLayoutSnapshot = loaded.targetSnapshot ?? loaded;
const results = [];
for (const candidate of report.ownerOverrides) {
  const owner = snapshot.instances.find((o) => o.entityId === candidate.entityId)!;
  assert.ok(owner);
  assert.equal(owner.position.y, candidate.fixedOwnerY);
  try {
    const rule = validateFoundationSupportRule(candidate.rule);
    const plan = planSupportPlacement(grid, rule, owner);
    assert.ok(
      plan.minimumY <= owner.position.y + 1e-8,
      `Explicit podium requires owner raise ${plan.minimumY - owner.position.y}`,
    );
    const generated = generateSupportAssets(grid, rule, owner, {
      foundation: `candidate-${owner.entityId}-podium`,
      approaches: Object.fromEntries(rule.approaches!.map((a) => [a.id, `candidate-${a.id}`])),
    });
    const assets = generated.map(({ role, asset }) => {
      const compiled = compileGeneratedAsset(asset.physics.assetId, asset);
      let maximumTopSlopeDegrees = 0;
      let triangles = 0;
      for (const collider of asset.physics.colliders) {
        assert.equal(collider.kind, 'mesh');
        if (collider.kind !== 'mesh') continue;
        for (let index = 0; index < collider.indices.length; index += 3) {
          const points = collider.indices.slice(index, index + 3).map((i) => ({
            x: collider.vertices[i * 3],
            y: collider.vertices[i * 3 + 1],
            z: collider.vertices[i * 3 + 2],
          })) as [Vec3, Vec3, Vec3];
          const normal = terrainNormal(points);
          if (normal.y <= 1e-8) continue;
          maximumTopSlopeDegrees = Math.max(
            maximumTopSlopeDegrees,
            (Math.atan2(Math.hypot(normal.x, normal.z), normal.y) * 180) / Math.PI,
          );
          triangles++;
        }
      }
      return {
        role,
        maximumTopSlopeDegrees,
        topTriangles: triangles,
        modelBytes: compiled.model?.byteLength,
      };
    });
    results.push({
      entityId: owner.entityId,
      status: assets.every(
        (a) => a.maximumTopSlopeDegrees <= (study.maximumActualSlopeDegrees?.[owner.entityId] ?? 8),
      )
        ? 'actual-podium-geometry-candidate'
        : 'actual-slope-needs-revision',
      fixedOwnerY: owner.position.y,
      maximumAllowedSlopeDegrees: study.maximumActualSlopeDegrees?.[owner.entityId] ?? 8,
      plan,
      addedPodiumAreaM2: candidate.addedPodiumAreaM2,
      assets,
    });
  } catch (error) {
    results.push({
      entityId: owner.entityId,
      status: 'rejected-actual-generator',
      error: String(error),
    });
  }
}
const output = {
  formatVersion: 1,
  status: 'unapplied-actual-podium-geometry-check',
  inputs: await Promise.all(
    [reportPath, gridPath, snapshotPath].map(async (path) => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    })),
  ),
  limitations: [
    'Actual support generator, support placement, closed collision solids and compiled model resources are checked. The source model and owner positions remain fixed.',
    'City collider clearance, candidate-to-candidate conflicts across owners, route physics and visual acceptance remain separate gates.',
  ],
  summary: {
    owners: results.length,
    candidates: results.filter((r) => r.status === 'actual-podium-geometry-candidate').length,
    slopeRevisions: results.filter((r) => r.status === 'actual-slope-needs-revision').length,
    generatorRejects: results.filter((r) => r.status === 'rejected-actual-generator').length,
  },
  results,
};
await writeFile(
  `${directory}/facade-platforms-actual.json`,
  JSON.stringify(output, null, 2) + '\n',
);
console.log(JSON.stringify(output.summary));
for (const result of results) console.log(JSON.stringify(result));
