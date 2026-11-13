/** Author explicit full-map pads and audit every actual saved support/contact. No publication or DB. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { canonicalJson, sampleTerrain } from '../packages/contracts/src/index.js';
import { hash } from '../packages/world-release/src/index.js';
import { planSupportPlacement } from '../packages/terrain-build/src/supports.js';
import { patchRange, rectangle, terrainPatch } from '../packages/terrain-build/src/terrain.js';
import {
  generateFullRingTerrain,
  readFullRingTerrainInputs,
} from './world-build/src/ring-full-terrain.js';
import {
  RING_TERRAIN_CANDIDATE_DIRECTORY as directory,
  ringTerrainGridStatistics,
} from './world-build/src/ring-terrain-candidate.js';

const check = process.argv.includes('--check');
const diagnostic = process.argv.includes('--diagnostic');
assert.ok(process.argv.slice(2).every((arg) => ['--check', '--diagnostic'].includes(arg)));
const output = resolve('output/ring-terrain-stage5/full-authoring');
await mkdir(output, { recursive: true });
const input = await readFullRingTerrainInputs();
const { base, snapshot, catalog, kits, anchors, config, inheritedBuildings, inheritedPublic } =
  input;
const allRules = [...catalog.rules, ...kits.map((k) => k.rule)];
const grid = generateFullRingTerrain(
  base,
  catalog.rules,
  allRules,
  snapshot,
  inheritedBuildings,
  inheritedPublic,
  config,
);
const byAsset = new Map(allRules.map((r) => [r.assetId, r]));
const kitByAsset = new Map(kits.map((k) => [k.assetId, k]));
const anchorByAsset = new Map(anchors.map((a) => [a.assetId, a.policy]));
const foundation = [],
  contacts = [],
  issues = [];
for (const owner of snapshot.instances.filter((i) => i.enabled)) {
  try {
    const rule = byAsset.get(owner.assetId);
    if (rule) {
      const placement = planSupportPlacement(grid, rule, owner);
      const kind = kitByAsset.has(owner.assetId) ? 'kit' : 'building';
      const maximumVisibleHeight = kitByAsset.get(owner.assetId)?.maximumVisibleHeight ?? 3;
      const savedOffset = owner.position.y + rule.jointY;
      const targetY = placement.minimumY + savedOffset;
      const visibleHeight = targetY + rule.jointY - placement.terrainMin;
      const row = {
        entityId: owner.entityId,
        assetId: owner.assetId,
        kind,
        x: owner.position.x,
        z: owner.position.z,
        targetY,
        visibleHeight,
        maximumVisibleHeight,
        ...placement,
      };
      foundation.push(row);
      if (savedOffset < -1e-8 || visibleHeight > maximumVisibleHeight + 1e-8)
        issues.push({
          ...row,
          reason: savedOffset < 0 ? 'invalid-source-offset' : 'foundation-height',
        });
    } else {
      const policy = anchorByAsset.get(owner.assetId);
      assert.ok(policy, `Unclassified actual owner: ${owner.entityId}`);
      const yaw = 2 * Math.atan2(owner.rotation.y, owner.rotation.w);
      const x =
        owner.position.x + policy.anchor.x * Math.cos(yaw) + policy.anchor.z * Math.sin(yaw);
      const z =
        owner.position.z - policy.anchor.x * Math.sin(yaw) + policy.anchor.z * Math.cos(yaw);
      const footprint = rectangle(x, z, 2 * policy.contactRadius, 2 * policy.contactRadius);
      for (const [px, pz] of footprint)
        assert.ok(sampleTerrain(grid, px, pz), 'Anchor contact is outside the terrain grid');
      const range = patchRange(terrainPatch(grid, footprint));
      const relief = range.max - range.min;
      const row = {
        entityId: owner.entityId,
        assetId: owner.assetId,
        kind: 'anchor',
        x,
        z,
        relief,
        allowedRelief: policy.maximumTerrainReliefMetres,
        ...range,
      };
      contacts.push(row);
      if (relief > policy.maximumTerrainReliefMetres + 1e-8)
        issues.push({ ...row, reason: 'anchor-relief' });
    }
  } catch (error) {
    issues.push({
      entityId: owner.entityId,
      assetId: owner.assetId,
      reason: 'geometry',
      error: String(error),
    });
  }
}
const changed = grid.heights.map((h, i) => Math.abs(h - base.heights[i]) > 1e-10);
let changedTriangles = 0;
for (let z = 0; z < grid.rows - 1; z++)
  for (let x = 0; x < grid.columns - 1; x++) {
    const a = z * grid.columns + x,
      b = a + 1,
      c = a + grid.columns + 1,
      d = a + grid.columns;
    if ([a, c, b].some((i) => changed[i])) changedTriangles++;
    if ([a, d, c].some((i) => changed[i])) changedTriangles++;
  }
const report = {
  formatVersion: 1,
  status: issues.length ? 'requires-explicit-authoring' : 'support-geometry-candidate-ready',
  databaseAccess: false,
  publicationWritten: false,
  gameplayAccepted: false,
  gridSha256: hash(canonicalJson(grid)),
  sourceGridSha256: config.sourceGridSha256,
  configSha256: hash(await readFile(`${directory}/full-terrain-pads.json`)),
  statistics: ringTerrainGridStatistics(grid),
  sourceStatistics: ringTerrainGridStatistics(base),
  intervention: {
    changedNodes: changed.filter(Boolean).length,
    totalNodes: changed.length,
    changedTriangles,
    changedAreaM2: (changedTriangles * grid.spacing ** 2) / 2,
    reviewedPilotBuildingOwners: inheritedBuildings.placements.length,
    retiredPilotBuildingOwners: config.buildingPads.replacement.retiredOwners.length,
    fullPlatformBuildingOwners: config.buildingPads.replacement.clusters.flatMap((c) => c.ownerIds)
      .length,
    fullGradeBuildingOwners: config.buildingPads.replacement.gradeCorrections.length,
    inheritedPublicOwners: inheritedPublic.pads.flatMap((p) => p.owners).length,
    extraPadOwners: config.additionalPads.flatMap((p) => p.ownerIds).length,
    sourceHeightsUnchangedOutsideExplicitPadInfluence: true,
  },
  checked: {
    actualOwners: snapshot.instances.filter((i) => i.enabled).length,
    buildingModels: catalog.rules.length,
    kitModels: kits.length,
    buildingOwners: foundation.filter((p) => p.kind === 'building').length,
    kitOwners: foundation.filter((p) => p.kind === 'kit').length,
    anchorOwners: contacts.length,
  },
  foundation,
  contacts,
  issues,
};
await writeFile(join(output, 'diagnostics.json'), JSON.stringify(report, null, 2) + '\n');
const gridBytes = JSON.stringify(grid) + '\n';
if (diagnostic) await writeFile(join(output, 'full-grid-candidate.json'), gridBytes);
else {
  assert.equal(
    issues.length,
    0,
    'Full terrain has unresolved actual support/contact issues; use --diagnostic for authoring',
  );
  const inputs = [
    'tools/build-ring-full-terrain.ts',
    'tools/world-build/src/ring-full-terrain.ts',
    'tools/world-build/src/ring-pads.ts',
    'tools/world-build/src/syktsu-pad.ts',
    `${directory}/full-terrain-pads.json`,
    `${directory}/full-grid-4m.json`,
    `${directory}/ring-pads.json`,
    `${directory}/public-space-pads.json`,
    `${directory}/model-supports.json`,
    `${directory}/kit-support-decisions.json`,
    `${directory}/anchor-contact-decisions.json`,
    'data/map-layout.json',
  ];
  const provenance = {
    ...report,
    foundation: undefined,
    contacts: undefined,
    inputs: Object.fromEntries(
      await Promise.all(inputs.map(async (file) => [file, hash(await readFile(file))])),
    ),
    output: { file: 'full-grid-ready.json', sha256: hash(gridBytes) },
    limitations: [
      'Approximate ArcticDEM-derived ground with explicit local gameplay pads, not geodetic truth.',
      'Entrance approaches, publication, actual saved dynamics, browser/gameplay and performance acceptance are separate.',
    ],
  };
  for (const [file, bytes] of [
    ['full-grid-ready.json', gridBytes],
    ['full-terrain-provenance.json', JSON.stringify(provenance, null, 2) + '\n'],
  ])
    if (check) assert.equal(await readFile(`${directory}/${file}`, 'utf8'), bytes, `Stale ${file}`);
    else await writeFile(`${directory}/${file}`, bytes);
}
console.log(
  JSON.stringify({
    status: report.status,
    gridSha256: report.gridSha256,
    statistics: report.statistics,
    intervention: report.intervention,
    checked: report.checked,
    issues,
  }),
);
