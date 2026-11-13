/** Offline authored candidate + exact static export dry-run. Never opens or rewrites a database. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  canonicalJson,
  validateTerrainGrid,
  type WorldLayoutSnapshot,
} from '../packages/contracts/src/index.js';
import { hash, writeWorldPublication } from '../packages/world-release/src/index.js';
import { planSupportPlacement } from '../packages/terrain-build/src/supports.js';
import { patchRange, rectangle, terrainPatch } from '../packages/terrain-build/src/terrain.js';
import { readRingAnchorDecisions } from './world-build/src/ring-anchor-authoring.js';
import { buildWorld } from './world-build/src/index.js';
import { readRingModelSupportCatalog } from './world-build/src/ring-support-authoring.js';
import { readRingKitSupportDecisions } from './world-build/src/ring-kit-authoring.js';
import { ringTerrainBoundaries, terrainHeight } from './world-build/src/ring-terrain-layout.js';
import {
  readAuthoringRelease,
  createLayoutPublication,
  editableStaticAssetIds,
} from '../apps/server/src/layout/release.js';
import {
  planStaticTerrainPoses,
  type TerrainPoseRules,
  type TerrainObjectPolicy,
} from '../apps/server/src/layout/terrain-poses.js';

const gridFile = resolve(
  process.argv[2] ?? 'content/worlds/ring-block/terrain-candidate/pilot-grid-ready.json',
);
const output = resolve(process.argv[3] ?? 'output/ring-terrain-stage4');
const save = async (file: string, value: unknown) =>
  writeFile(join(output, file), JSON.stringify(value, null, 2) + '\n');
await mkdir(output, { recursive: true });
const snapshotBytes = await readFile('data/map-layout.json');
assert.equal(
  hash(snapshotBytes),
  'f4419053c7b40d2f6262a05a690ede725e4c879938e8806f8b85e918d4bad193',
);
const snapshot: WorldLayoutSnapshot = JSON.parse(snapshotBytes.toString());
const source = await readAuthoringRelease('output/ring-terrain-stage0/source-world');
const original = await createLayoutPublication(source, snapshot);
const grid = validateTerrainGrid(JSON.parse(await readFile(gridFile, 'utf8')));
assert.equal(grid.spacing, 4);
if (!process.argv[2]) {
  const provenance = JSON.parse(
    await readFile('content/worlds/ring-block/terrain-candidate/public-space-pads.json', 'utf8'),
  );
  assert.equal(provenance.gridSha256, hash(canonicalJson(grid)), 'Final pilot grid is stale');
  assert.equal(
    provenance.generatorSha256,
    hash(await readFile('tools/build-ring-public-pads.ts')),
    'Public pad generator changed',
  );
  assert.equal(provenance.sourceExportSha256, hash(snapshotBytes));
}
const catalog = await readRingModelSupportCatalog();
const kits = await readRingKitSupportDecisions(catalog);
const anchors = await readRingAnchorDecisions(catalog);
const supports = [...catalog.rules, ...kits.map((d) => d.rule)];
const models: TerrainPoseRules['models'] = catalog.models
  .filter((m) => m.policy.kind !== 'terrain-replacement')
  .map((m) => {
    const kit = kits.find((d) => d.assetId === m.assetId);
    let policy: TerrainObjectPolicy;
    if (kit) policy = { kind: 'foundation', maximumVisibleHeight: kit.maximumVisibleHeight };
    else if (m.policy.kind === 'foundation')
      policy = { kind: 'foundation', maximumVisibleHeight: 3 };
    else if (m.policy.kind === 'ground-anchor')
      policy = anchors.find((a) => a.assetId === m.assetId)!.policy;
    else throw new Error(`Unresolved model policy: ${m.assetId}`);
    return { assetId: m.assetId, policy };
  });
// A separate seed is required for a coherent new-world release; it never replaces the export.
const seedY: Record<string, number> = {};
for (const owner of source.seed) {
  const model = models.find((m) => m.assetId === owner.assetId)!;
  if (model.policy.kind === 'foundation') {
    const rule = supports.find((r) => r.assetId === owner.assetId)!;
    seedY[owner.entityId] = owner.position.y + planSupportPlacement(grid, rule, owner).minimumY;
  } else if (model.policy.kind === 'ground-anchor') {
    const yaw = 2 * Math.atan2(owner.rotation.y, owner.rotation.w);
    const a = model.policy.anchor;
    const point = {
      x: owner.position.x + a.x * Math.cos(yaw) + a.z * Math.sin(yaw),
      z: owner.position.z - a.x * Math.sin(yaw) + a.z * Math.cos(yaw),
    };
    const radius = model.policy.contactRadius;
    const datum =
      model.policy.contactDatum === 'minimum'
        ? patchRange(terrainPatch(grid, rectangle(point.x, point.z, radius * 2, radius * 2))).min
        : terrainHeight(grid, point);
    seedY[owner.entityId] = owner.position.y + datum;
  }
}
const header = {
  bounds: structuredClone(source.definition.bounds),
  spawnPoints: source.definition.spawnPoints.map((p) => ({
    ...p,
    y: p.y + terrainHeight(grid, p),
  })),
  initialItems: source.definition.initialItems.map((item) => ({
    ...item,
    position: { ...item.position, y: item.position.y + terrainHeight(grid, item.position) },
  })),
};
// Permit the unchanged tallest models after their explicit upward terrain placement.
for (const owner of source.seed)
  header.bounds.max.y = Math.max(
    header.bounds.max.y,
    Math.ceil(
      seedY[owner.entityId] + source.definition.buildingAssets[owner.assetId].bounds.max.y + 2,
    ),
  );
const authoringDirectory = join(output, 'authoring-world');
const began = performance.now();
await buildWorld('content/worlds/ring-block/world.json', authoringDirectory, {
  groundTerrain: {
    spacing: 4,
    grid,
    supports,
    header,
    statics: ringTerrainBoundaries(source.definition, grid),
    seedY,
  },
});
const target = await readAuthoringRelease(authoringDirectory);
assert.deepEqual(editableStaticAssetIds(target), editableStaticAssetIds(source));
for (const id of editableStaticAssetIds(source))
  assert.deepEqual(
    target.definition.buildingAssets[id],
    source.definition.buildingAssets[id],
    `Changed model: ${id}`,
  );
const rules: TerrainPoseRules = {
  formatVersion: 1,
  algorithmVersion: 'terrain-poses/1',
  sourceFlatGroundY: 0,
  sourceGroundIds: source.metadata.fixedInstanceIds,
  targetGroundIds: target.metadata.fixedInstanceIds,
  models,
};
await save('terrain-pose-rules.json', rules);
const result = planStaticTerrainPoses(
  {
    sourceRelease: source,
    targetRelease: target,
    sourceSnapshot: snapshot,
    sourceWorld: original.world,
    sourceItems: [],
  },
  rules,
);
await save('static-preflight.json', result);
if (result.issues.length) {
  console.error(JSON.stringify({ status: 'blocked', issues: result.issues }, null, 2));
  process.exitCode = 1;
} else {
  const publication = await createLayoutPublication(target, result.targetSnapshot);
  await writeWorldPublication(publication.publication, join(output, 'export-world'));
  await save('target-static-snapshot.json', result.targetSnapshot);
  const changed = result.targetSnapshot.instances.filter(
    (owner, i) => owner.position.y !== snapshot.instances[i].position.y,
  );
  assert.equal(hash(await readFile('data/map-layout.json')), hash(snapshotBytes));
  const report = {
    status: 'static-candidate-built',
    databaseAccess: false,
    savedItemsAssessed: false,
    sourceExportSha256: hash(snapshotBytes),
    sourceRevision: snapshot.revision,
    sourceAssetReleaseVersion: snapshot.assetReleaseVersion,
    targetAssetReleaseVersion: target.metadata.assetReleaseVersion,
    mapVersion: publication.publication.manifest.mapVersion,
    layoutHash: publication.hash,
    gridFile,
    gridSha256: hash(canonicalJson(grid)),
    models: models.length,
    supportRules: supports.length,
    sourceOwners: snapshot.instances.length,
    enabledOwners: snapshot.instances.filter((o) => o.enabled).length,
    changedStaticY: changed.length,
    derivedCount:
      publication.world.buildings.length -
      target.metadata.fixedInstanceIds.length -
      snapshot.instances.filter((o) => o.enabled).length,
    buildAndPublishMs: performance.now() - began,
    bounds: header.bounds,
    spawnPoints: header.spawnPoints,
    initialItemsAreFreshWorldSeedOnly: true,
    sourceUnchanged: true,
    publicResourceBytes: Object.keys(publication.publication.manifest.files).reduce(
      (n, file) => n + (publication.publication.payloads.get(file)?.byteLength ?? 0),
      0,
    ),
  };
  await save('build-report.json', report);
  console.log(JSON.stringify(report, null, 2));
}
